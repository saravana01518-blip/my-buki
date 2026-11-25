import { mkdtemp, rm, readFile, writeFile, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SageClient, readTokens, writeTokensAtomic } from "./client";
import {
  normalizeBankTransactions,
  normalizeInvoice,
  normalizeLedgerAccount,
  normalizeParty,
} from "./mapper";
import { createSageProvider } from "./provider";
import { validateFinanceSet } from "../../../lib/check/validate";
import { answerBrief } from "../../../lib/brief/answer";
import { emptyHr, type Store } from "../../../lib/store/store";
import { runSync } from "../../../lib/sync/runSync";

const FIXTURES_DIR = path.join(process.cwd(), "fixtures", "sage-v3.1");

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("Sage v3.1 Connector", () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "buki-sage-test-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (tempDirs.length) {
      const dir = tempDirs.pop()!;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("1. exchanges OAuth2 code and resolves X-Business via GET /businesses without sending X-Business on /businesses", async () => {
    const dir = await makeTempDir();
    const tokenPath = path.join(dir, "sage-tokens.json");
    const calls: Array<{ url: string; headers: unknown }> = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, headers: init?.headers });
      if (url === "https://oauth.accounting.sage.com/token") {
        return jsonResponse({
          access_token: "acc-initial",
          refresh_token: "ref-initial",
          expires_in: 300,
        });
      }
      if (url.endsWith("/businesses")) {
        return jsonResponse({
          $total: 1,
          $page: 1,
          $next: null,
          $back: null,
          $itemsPerPage: 100,
          $items: [{ id: "biz-123", name: "Test Co" }],
        });
      }
      return jsonResponse({
        $total: 0,
        $page: 1,
        $next: null,
        $back: null,
        $itemsPerPage: 100,
        $items: [],
      });
    };

    const client = new SageClient({
      clientId: "cid",
      clientSecret: "csec",
      tokenPath,
      fetchFn: mockFetch,
    });

    const tokens = await client.exchangeCode("auth-code-1", "http://localhost:3000/api/sage/callback");
    expect(tokens.access_token).toBe("acc-initial");
    expect(tokens.refresh_token).toBe("ref-initial");

    await client.ledgerAccounts();

    const bizCall = calls.find((c) => c.url.endsWith("/businesses"))!;
    const bizHeaders = bizCall.headers as Record<string, string>;
    expect(bizHeaders.Authorization).toBe("Bearer acc-initial");
    expect(bizHeaders["X-Business"]).toBeUndefined();

    const ledgerCall = calls.find((c) => c.url.includes("/ledger_accounts"))!;
    const ledgerHeaders = ledgerCall.headers as Record<string, string>;
    expect(ledgerHeaders["X-Business"]).toBe("biz-123");
  });

  it("2. refreshes on HTTP 401 (up to 2,048-byte tokens), atomically persists BOTH rotated tokens, and retries once", async () => {
    const dir = await makeTempDir();
    const tokenPath = path.join(dir, "sage-tokens.json");
    const longAccess = "a".repeat(2048);
    const longRefresh = "r".repeat(2048);
    await writeTokensAtomic({ access_token: "expired-token", refresh_token: "old-refresh" }, tokenPath);

    let apiAttempts = 0;
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://oauth.accounting.sage.com/token") {
        return jsonResponse({
          access_token: longAccess,
          refresh_token: longRefresh,
          expires_in: 300,
        });
      }
      apiAttempts += 1;
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (auth === "Bearer expired-token") {
        return new Response("Unauthorized", { status: 401 });
      }
      expect(auth).toBe(`Bearer ${longAccess}`);
      return jsonResponse({
        $total: 1,
        $page: 1,
        $next: null,
        $back: null,
        $itemsPerPage: 100,
        $items: [{ id: "la-1", displayed_as: "Sales", ledger_account_type: { id: "SALES" } }],
      });
    };

    const client = new SageClient({
      clientId: "cid",
      clientSecret: "csec",
      businessId: "biz-1",
      tokenPath,
      fetchFn: mockFetch,
    });

    const accounts = await client.ledgerAccounts();
    expect(accounts).toHaveLength(1);
    expect(apiAttempts).toBe(2);

    const saved = await readTokens(tokenPath);
    expect(saved?.access_token).toBe(longAccess);
    expect(saved?.refresh_token).toBe(longRefresh);
  });

  it("3. paginates multi-page responses with items_per_page=100 until $next === null", async () => {
    const dir = await makeTempDir();
    const tokenPath = path.join(dir, "sage-tokens.json");
    await writeTokensAtomic({ access_token: "ok-tok", refresh_token: "ok-ref" }, tokenPath);

    const visited: string[] = [];
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      visited.push(url);
      if (url.includes("page=2")) {
        return jsonResponse({
          $total: 2,
          $page: 2,
          $next: null,
          $back: "/contacts?page=1&items_per_page=100",
          $itemsPerPage: 100,
          $items: [{ id: "ct-2", name: "Beta Ltd", contact_types: [{ id: "CUSTOMER" }] }],
        });
      }
      return jsonResponse({
        $total: 2,
        $page: 1,
        $next: "/contacts?page=2&items_per_page=100",
        $back: null,
        $itemsPerPage: 100,
        $items: [{ id: "ct-1", name: "Alpha Ltd", contact_types: [{ id: "CUSTOMER" }] }],
      });
    };

    const client = new SageClient({
      businessId: "biz-1",
      tokenPath,
      fetchFn: mockFetch,
    });

    const contacts = await client.contacts();
    expect(contacts.map((c) => c.id)).toEqual(["ct-1", "ct-2"]);
    expect(visited[0]).toContain("items_per_page=100");
    expect(visited[1]).toContain("page=2");
  });

  it("4. honors Retry-After on HTTP 429 and retries transient 5xx with exponential backoff", async () => {
    const dir = await makeTempDir();
    const tokenPath = path.join(dir, "sage-tokens.json");
    await writeTokensAtomic({ access_token: "ok-tok", refresh_token: "ok-ref" }, tokenPath);

    const sleeps: number[] = [];
    let attempt = 0;
    const mockFetch: typeof fetch = async () => {
      attempt += 1;
      if (attempt === 1) return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "2" } });
      if (attempt === 2) return new Response("Bad Gateway", { status: 502 });
      return jsonResponse({
        $total: 1,
        $page: 1,
        $next: null,
        $back: null,
        $itemsPerPage: 100,
        $items: [{ id: "la-1", displayed_as: "Bank", ledger_account_type: { id: "BANK" } }],
      });
    };

    const client = new SageClient({
      businessId: "biz-1",
      tokenPath,
      fetchFn: mockFetch,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });

    const accounts = await client.ledgerAccounts();
    expect(accounts).toHaveLength(1);
    expect(sleeps).toEqual([2000, 500]);
  });

  it("5. falls back cleanly to recorded v3.1 fixtures on HTTP 405 for /purchase_invoices", async () => {
    const dir = await makeTempDir();
    const tokenPath = path.join(dir, "sage-tokens.json");
    await writeTokensAtomic({ access_token: "ok-tok", refresh_token: "ok-ref" }, tokenPath);
    const logs: string[] = [];

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/purchase_invoices")) {
        return new Response("Method Not Allowed", { status: 405 });
      }
      return jsonResponse({
        $total: 0,
        $page: 1,
        $next: null,
        $back: null,
        $itemsPerPage: 100,
        $items: [],
      });
    };

    const client = new SageClient({
      businessId: "biz-1",
      tokenPath,
      fixturesDir: FIXTURES_DIR,
      fetchFn: mockFetch,
      logger: (m) => logs.push(m),
    });

    const purchases = await client.purchaseInvoices();
    expect(purchases.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes("405") && l.includes("purchase_invoices"))).toBe(true);
  });

  it("6. maps canonical types with absent optional fields, exact ISO currencies, no double-counted bank credits/transfers, and passes validateFinanceSet", async () => {
    const provider = createSageProvider(() => new SageClient({ useFixtures: true, fixturesDir: FIXTURES_DIR }));
    const [accounts, parties, invoices, bankTransactions] = await Promise.all([
      provider.accounts(),
      provider.parties(),
      provider.invoices(),
      provider.bankTransactions(),
    ]);

    const noDue = invoices.find((i) => i.id === "sage:si-3004");
    expect(noDue).toBeDefined();
    expect("dueDate" in noDue!).toBe(false);
    expect(noDue?.dueDate).toBeUndefined();

    const noEmail = parties.find((p) => p.id === "sage:ct-northgate");
    expect(noEmail).toBeDefined();
    expect("email" in noEmail!).toBe(false);

    // Check bank transactions: bt-5005 (is_duplicate_credit) excluded, outflow negative, transfer not double-counted
    expect(bankTransactions.find((t) => t.id === "sage:bt-5005")).toBeUndefined();
    expect(bankTransactions.find((t) => t.id === "sage:bt-5002")?.amount).toBe(-1800);
    expect(bankTransactions.find((t) => t.id === "sage:bt-5003")?.amount).toBe(-10000);
    expect(bankTransactions.find((t) => t.id === "sage:bt-5004")?.amount).toBe(10000);

    // Currency preserved
    expect(invoices.every((i) => i.currency === "GBP")).toBe(true);

    // Validate full set
    const check = validateFinanceSet({ accounts, parties, invoices, bankTransactions });
    expect(check.errors).toEqual([]);
    expect(check.warnings).toEqual([]);
    expect(check.set).not.toBeNull();

    // Direct unit checks on mapper edge cases
    expect(normalizeLedgerAccount({ id: "1", displayed_as: "Cash", nominal_code: null })).not.toHaveProperty("code");
    expect(normalizeParty({ id: "2", name: "Acme", email: "" })).not.toHaveProperty("email");
    expect(
      normalizeInvoice(
        { id: "3", contact: { id: "2" }, date: "2026-10-01", due_date: null, currency: "EUR", total_amount: 100 },
        "sales",
      ),
    ).not.toHaveProperty("dueDate");
    expect(
      normalizeBankTransactions([
        { id: "t1", bank_account: { id: "b1" }, date: "2026-10-01", total_amount: 500, currency: "USD", transfer_id: "x1" },
        { id: "t2", bank_account: { id: "b1" }, date: "2026-10-01", total_amount: 500, currency: "USD", transfer_id: "x1" },
      ]),
    ).toHaveLength(1);
  });

  it("7. preserves prior complete snapshot in store on mid-sync failure", async () => {
    const dir = await makeTempDir();
    const storeMod = await import("../../../lib/store/store");
    const origPath = storeMod.STORE_PATH;
    // Run against real runSync with failing financeProvider after a successful sync
    const goodProvider = createSageProvider(() => new SageClient({ useFixtures: true, fixturesDir: FIXTURES_DIR }));
    const failingProvider = {
      ...goodProvider,
      async bankTransactions() {
        throw new Error("Simulated mid-sync 503 outage");
      },
    };
    const mockHr = {
      source: "bamboohr" as const,
      async health() {
        return { ok: true, detail: "ok" };
      },
      async employees() {
        return [];
      },
    };

    // First sync succeeds
    const r1 = await runSync({ hrProvider: mockHr, financeProvider: goodProvider });
    expect(r1.ok).toBe(true);
    const snap1 = await storeMod.readStore();
    expect(snap1.finance.invoices.length).toBeGreaterThan(0);

    // Second sync fails mid-way
    const r2 = await runSync({ hrProvider: mockHr, financeProvider: failingProvider });
    expect(r2.ok).toBe(false);
    const snap2 = await storeMod.readStore();
    expect(snap2.finance.invoices).toEqual(snap1.finance.invoices);
    expect(snap2.finance.syncedAt).toBe(snap1.finance.syncedAt);
    expect(origPath).toBeTruthy();
    expect(dir).toBeTruthy();
  });

  it("8. scheduled sync picks up live fixture edits in place without duplicating records", async () => {
    const dir = await makeTempDir();
    await cp(FIXTURES_DIR, dir, { recursive: true });
    const provider = createSageProvider(() => new SageClient({ useFixtures: true, fixturesDir: dir }));
    const mockHr = {
      source: "bamboohr" as const,
      async health() {
        return { ok: true, detail: "ok" };
      },
      async employees() {
        return [];
      },
    };

    const first = await runSync({ hrProvider: mockHr, financeProvider: provider });
    expect(first.ok).toBe(true);

    // Simulate editing si-3001 outstanding_amount in Sage fixture
    const salesFile = path.join(dir, "sales_invoices.json");
    const salesJson = JSON.parse(await readFile(salesFile, "utf8"));
    salesJson.$items[0].outstanding_amount = 4500;
    await writeFile(salesFile, JSON.stringify(salesJson, null, 2), "utf8");

    const second = await runSync({ hrProvider: mockHr, financeProvider: provider });
    expect(second.ok).toBe(true);
    const finRun = second.runs.find((r) => r.domain === "finance")!;
    expect(finRun.changed).toBe(1);
    expect(finRun.added).toBe(0);
  });

  it("9 & 10. answers both CLI briefs accurately as of 2026-11-25", async () => {
    const provider = createSageProvider(() => new SageClient({ useFixtures: true, fixturesDir: FIXTURES_DIR }));
    const [accounts, parties, invoices, bankTransactions] = await Promise.all([
      provider.accounts(),
      provider.parties(),
      provider.invoices(),
      provider.bankTransactions(),
    ]);

    const now = new Date("2026-11-25T11:00:00Z");
    const store: Store = {
      hr: emptyHr(),
      finance: {
        source: "sage",
        syncedAt: now.toISOString(),
        accounts,
        parties,
        invoices,
        bankTransactions,
      },
      runs: [],
    };

    // Brief 1: Who owes us money?
    const owes = answerBrief("Who owes us money?", store, now);
    expect(owes.answer).toContain("2 invoices are overdue");
    expect(owes.answer).toContain("GBP 12,000");
    expect(owes.answer).toContain("Pinecrest Health");
    expect(owes.answer).toContain("Tolliver & Reed LLP");
    expect(owes.answer).toContain("1 open invoice has no due date on file and is not counted");
    // Valid future-due invoice si-3003 is stored, not listed as overdue
    expect(store.finance.invoices.find((i) => i.id === "sage:si-3003")?.dueDate).toBe("2026-12-10");
    expect(owes.answer).not.toContain("Northgate Analytics");

    // Brief 2: What did we spend on software last month? (October 2026, net excluding tax)
    const software = answerBrief("What did we spend on software last month?", store, now);
    expect(software.answer).toContain("GBP 2,350");
    expect(software.answer).toContain("Software subscriptions");
    expect(software.answer).toContain("October 2026");
    expect(software.answer).toContain("2 purchase invoice lines");
  });
});
