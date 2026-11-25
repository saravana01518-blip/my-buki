/**
 * Sage Business Cloud Accounting v3.1 HTTP & OAuth2 client.
 *
 * Features:
 * - OAuth2 code exchange and rotating refresh token persistence (.data/sage-tokens.json)
 * - Automatic HTTP 401 token refresh + single retry (with concurrent refresh lock)
 * - X-Business header attachment (omitted on GET /businesses)
 * - Pagination via page / items_per_page=100 until $next === null
 * - HTTP 429 Retry-After handling and 5xx exponential backoff (up to 3 retries)
 * - Graceful HTTP 405 / SAGE_USE_FIXTURES=true fallback to recorded v3.1 fixtures
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  SageBankTransaction,
  SageBusiness,
  SageContact,
  SageInvoice,
  SageLedgerAccount,
  SageListResponse,
  SageOAuthTokens,
} from "./raw/types";

export const SAGE_API_BASE_URL = "https://api.accounting.sage.com/v3.1";
export const SAGE_TOKEN_URL = "https://oauth.accounting.sage.com/token";
export const SAGE_AUTHORIZE_URL = "https://www.sageone.com/oauth2/auth/central?filter=apiv3.1";
export const DEFAULT_TOKEN_PATH = path.join(process.cwd(), ".data", "sage-tokens.json");
export const DEFAULT_FIXTURES_DIR = path.join(process.cwd(), "fixtures", "sage-v3.1");

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 250;

export type SageErrorKind = "config" | "auth" | "http" | "network" | "timeout" | "shape";

export class SageApiError extends Error {
  constructor(
    public readonly kind: SageErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SageApiError";
  }
}

export interface SageClientOptions {
  apiBaseUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  businessId?: string;
  tokenPath?: string;
  fixturesDir?: string;
  useFixtures?: boolean;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  logger?: (msg: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function readTokens(tokenPath = DEFAULT_TOKEN_PATH): Promise<SageOAuthTokens | null> {
  try {
    const raw = await readFile(tokenPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<SageOAuthTokens>;
    if (!parsed.access_token || !parsed.refresh_token) return null;
    return parsed as SageOAuthTokens;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Atomically persist BOTH access_token and rotated refresh_token via temp-file + rename. */
export async function writeTokensAtomic(
  tokens: SageOAuthTokens,
  tokenPath = DEFAULT_TOKEN_PATH,
): Promise<void> {
  await mkdir(path.dirname(tokenPath), { recursive: true });
  const tmp = `${tokenPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(tokens, null, 2) + "\n", "utf8");
  await rename(tmp, tokenPath);
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SageClientOptions {
  return {
    apiBaseUrl: (env.SAGE_API_BASE_URL || SAGE_API_BASE_URL).replace(/\/+$/, ""),
    tokenUrl: env.SAGE_TOKEN_URL || SAGE_TOKEN_URL,
    clientId: env.SAGE_CLIENT_ID || undefined,
    clientSecret: env.SAGE_CLIENT_SECRET || undefined,
    businessId: env.SAGE_BUSINESS_ID || undefined,
    tokenPath: env.SAGE_TOKEN_PATH || DEFAULT_TOKEN_PATH,
    fixturesDir: env.SAGE_FIXTURES_DIR || DEFAULT_FIXTURES_DIR,
    useFixtures: env.SAGE_USE_FIXTURES === "true",
  };
}

function parseRetryAfterMs(header: string | null): number {
  if (!header) return BASE_BACKOFF_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return BASE_BACKOFF_MS;
}

export class SageClient {
  private readonly apiBaseUrl: string;
  private readonly tokenUrl: string;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private businessId?: string;
  private readonly tokenPath: string;
  private readonly fixturesDir: string;
  private readonly useFixtures: boolean;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly logger: (msg: string) => void;
  private refreshPromise: Promise<SageOAuthTokens> | null = null;

  constructor(options: SageClientOptions = {}) {
    this.apiBaseUrl = (options.apiBaseUrl ?? SAGE_API_BASE_URL).replace(/\/+$/, "");
    this.tokenUrl = options.tokenUrl ?? SAGE_TOKEN_URL;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.businessId = options.businessId;
    this.tokenPath = options.tokenPath ?? DEFAULT_TOKEN_PATH;
    this.fixturesDir = options.fixturesDir ?? DEFAULT_FIXTURES_DIR;
    this.useFixtures = options.useFixtures ?? false;
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleepFn = options.sleepFn ?? defaultSleep;
    this.logger = options.logger ?? ((msg) => console.warn(msg));
  }

  async exchangeCode(code: string, redirectUri: string): Promise<SageOAuthTokens> {
    if (!this.clientId || !this.clientSecret) {
      throw new SageApiError("config", "SAGE_CLIENT_ID and SAGE_CLIENT_SECRET are required for OAuth exchange");
    }
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });
    const res = await this.fetchFn(this.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new SageApiError("auth", `Sage OAuth code exchange failed with HTTP ${res.status}`, res.status);
    }
    const json = (await res.json()) as Partial<SageOAuthTokens>;
    if (!json.access_token || !json.refresh_token) {
      throw new SageApiError("shape", "Sage OAuth response missing access_token or refresh_token");
    }
    const tokens: SageOAuthTokens = {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_in: json.expires_in,
      token_type: json.token_type,
      obtained_at: new Date().toISOString(),
      business_id: this.businessId,
    };
    await writeTokensAtomic(tokens, this.tokenPath);
    return tokens;
  }

  async refreshAccessToken(): Promise<SageOAuthTokens> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      if (!this.clientId || !this.clientSecret) {
        throw new SageApiError("config", "SAGE_CLIENT_ID and SAGE_CLIENT_SECRET are required to refresh Sage token");
      }
      const current = await readTokens(this.tokenPath);
      if (!current?.refresh_token) {
        throw new SageApiError("auth", `No Sage refresh_token found at ${this.tokenPath}. Run npm run sage:auth or enable SAGE_USE_FIXTURES=true.`);
      }
      const body = new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: current.refresh_token,
        grant_type: "refresh_token",
      });
      const res = await this.fetchFn(this.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: body.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new SageApiError("auth", `Sage token refresh failed with HTTP ${res.status}`, res.status);
      }
      const json = (await res.json()) as Partial<SageOAuthTokens>;
      if (!json.access_token || !json.refresh_token) {
        throw new SageApiError("shape", "Sage refresh response missing access_token or rotated refresh_token");
      }
      const updated: SageOAuthTokens = {
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        expires_in: json.expires_in,
        token_type: json.token_type,
        obtained_at: new Date().toISOString(),
        business_id: this.businessId ?? current.business_id,
      };
      await writeTokensAtomic(updated, this.tokenPath);
      return updated;
    })();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async getAccessToken(): Promise<string> {
    const tokens = await readTokens(this.tokenPath);
    if (!tokens?.access_token) {
      throw new SageApiError(
        "auth",
        `No Sage tokens found at ${this.tokenPath}. Run npm run sage:auth or set SAGE_USE_FIXTURES=true.`,
      );
    }
    if (!this.businessId && tokens.business_id) {
      this.businessId = tokens.business_id;
    }
    return tokens.access_token;
  }

  async resolveBusinessId(): Promise<string> {
    if (this.businessId) return this.businessId;
    if (this.useFixtures) {
      const businesses = await this.readFixture<SageListResponse<SageBusiness>>("businesses.json");
      const id = businesses.$items?.[0]?.id;
      if (!id) throw new SageApiError("shape", "Fixture businesses.json has no business id");
      this.businessId = id;
      return id;
    }
    const list = await this.requestJson<SageListResponse<SageBusiness>>("/businesses", { includeBusinessHeader: false });
    const first = list.$items?.[0]?.id;
    if (!first) {
      throw new SageApiError("shape", "Sage GET /businesses returned no businesses");
    }
    this.businessId = first;
    const tokens = await readTokens(this.tokenPath);
    if (tokens) {
      await writeTokensAtomic({ ...tokens, business_id: first }, this.tokenPath);
    }
    return first;
  }

  private async readFixture<T>(fileName: string): Promise<T> {
    const fullPath = path.join(this.fixturesDir, fileName);
    const raw = await readFile(fullPath, "utf8");
    return JSON.parse(raw) as T;
  }

  private buildUrl(endpointOrUrl: string, query?: Record<string, string>): string {
    const isAbsolute = /^https?:\/\//i.test(endpointOrUrl);
    const u = new URL(isAbsolute ? endpointOrUrl : `${this.apiBaseUrl}${endpointOrUrl.startsWith("/") ? "" : "/"}${endpointOrUrl}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        u.searchParams.set(k, v);
      }
    }
    return u.toString();
  }

  async requestJson<T>(
    endpointOrUrl: string,
    opts: { includeBusinessHeader?: boolean; query?: Record<string, string> } = {},
  ): Promise<T> {
    const includeBusiness = opts.includeBusinessHeader ?? true;
    const businessId = includeBusiness ? await this.resolveBusinessId() : undefined;
    const url = this.buildUrl(endpointOrUrl, opts.query);

    let refreshed = false;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const accessToken = await this.getAccessToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      };
      if (includeBusiness && businessId) {
        headers["X-Business"] = businessId;
      }

      let res: Response;
      try {
        res = await this.fetchFn(url, {
          headers,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        if (err instanceof Error && err.name === "TimeoutError") {
          throw new SageApiError("timeout", `Sage timed out requesting ${endpointOrUrl}`);
        }
        throw new SageApiError("network", `Network error calling Sage ${endpointOrUrl}: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.refreshAccessToken();
        continue;
      }

      if (res.status === 429 && attempt < MAX_RETRIES) {
        const waitMs = parseRetryAfterMs(res.headers.get("Retry-After"));
        await this.sleepFn(waitMs);
        continue;
      }

      if (res.status >= 500 && res.status < 600 && attempt < MAX_RETRIES) {
        await this.sleepFn(BASE_BACKOFF_MS * 2 ** attempt);
        continue;
      }

      if (!res.ok) {
        throw new SageApiError("http", `Sage ${endpointOrUrl} returned HTTP ${res.status}`, res.status);
      }

      try {
        return (await res.json()) as T;
      } catch {
        throw new SageApiError("shape", `Sage ${endpointOrUrl} returned invalid JSON`);
      }
    }

    throw new SageApiError("http", `Sage ${endpointOrUrl} failed after ${MAX_RETRIES} retries`);
  }

  async paginate<T>(
    resourcePath: string,
    fixtureFile: string,
    query: Record<string, string> = {},
  ): Promise<T[]> {
    if (this.useFixtures) {
      const payload = await this.readFixture<SageListResponse<T>>(fixtureFile);
      return payload.$items ?? [];
    }

    const items: T[] = [];
    let nextTarget: string | null = resourcePath;
    let pageNum = 1;

    try {
      while (nextTarget !== null) {
        const isFirst = pageNum === 1;
        const pageQuery = isFirst
          ? { items_per_page: "100", page: "1", ...query }
          : nextTarget.includes("page=")
            ? undefined
            : { items_per_page: "100", page: String(pageNum), ...query };

        const page: SageListResponse<T> = await this.requestJson<SageListResponse<T>>(nextTarget, {
          includeBusinessHeader: true,
          query: pageQuery,
        });

        if (!Array.isArray(page.$items)) {
          throw new SageApiError("shape", `Sage ${resourcePath} response missing $items array`);
        }
        items.push(...page.$items);
        nextTarget = page.$next ?? null;
        pageNum += 1;
      }
      return items;
    } catch (err) {
      if (err instanceof SageApiError && err.status === 405) {
        this.logger(
          `[sage] HTTP 405 on ${resourcePath} (plan-gated endpoint); falling back to recorded v3.1 fixture ${fixtureFile}`,
        );
        const payload = await this.readFixture<SageListResponse<T>>(fixtureFile);
        return payload.$items ?? [];
      }
      throw err;
    }
  }

  businesses(): Promise<SageBusiness[]> {
    if (this.useFixtures) {
      return this.readFixture<SageListResponse<SageBusiness>>("businesses.json").then((r) => r.$items ?? []);
    }
    return this.requestJson<SageListResponse<SageBusiness>>("/businesses", { includeBusinessHeader: false }).then(
      (r) => r.$items ?? [],
    );
  }

  ledgerAccounts(): Promise<SageLedgerAccount[]> {
    return this.paginate<SageLedgerAccount>("/ledger_accounts", "ledger_accounts.json");
  }

  contacts(): Promise<SageContact[]> {
    return this.paginate<SageContact>("/contacts", "contacts.json");
  }

  salesInvoices(since?: string): Promise<SageInvoice[]> {
    const query: Record<string, string> = { attributes: "all" };
    if (since) query.updated_or_created_since = since;
    return this.paginate<SageInvoice>("/sales_invoices", "sales_invoices.json", query);
  }

  purchaseInvoices(since?: string): Promise<SageInvoice[]> {
    const query: Record<string, string> = { attributes: "all" };
    if (since) query.updated_or_created_since = since;
    return this.paginate<SageInvoice>("/purchase_invoices", "purchase_invoices.json", query);
  }

  bankTransactions(since?: string): Promise<SageBankTransaction[]> {
    const query: Record<string, string> = {};
    if (since) query.updated_or_created_since = since;
    return this.paginate<SageBankTransaction>("/bank_transactions", "bank_transactions.json", query);
  }
}
