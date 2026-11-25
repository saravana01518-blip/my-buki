/**
 * Sage Business Cloud Accounting v3.1 FinanceProvider.
 *
 * Wires SageClient + pure mapper into Buki's FinanceProvider contract.
 */

import type { FinanceProvider } from "../providers/types";
import type { BankTransaction, Invoice, LedgerAccount, Party } from "../types";
import { SageApiError, SageClient, configFromEnv } from "./client";
import {
  normalizeBankTransactions,
  normalizeInvoice,
  normalizeLedgerAccount,
  normalizeParty,
} from "./mapper";

export function createSageProvider(createClient: () => SageClient = () => new SageClient(configFromEnv())): FinanceProvider {
  return {
    source: "sage",

    async health() {
      try {
        const cfg = configFromEnv();
        const client = createClient();
        const businesses = await client.businesses();
        const name = businesses[0]?.name ?? businesses[0]?.displayed_as ?? businesses[0]?.id ?? "unknown business";
        const mode = cfg.useFixtures ? "fixtures (fixtures/sage-v3.1)" : cfg.apiBaseUrl;
        return {
          ok: true,
          detail: `Connected to Sage (${name}) via ${mode}`,
        };
      } catch (err) {
        const kind = err instanceof SageApiError ? err.kind : "unknown";
        return {
          ok: false,
          detail: `${kind}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },

    async accounts(): Promise<LedgerAccount[]> {
      const raw = await createClient().ledgerAccounts();
      return raw.map(normalizeLedgerAccount).filter((a): a is LedgerAccount => a !== null);
    },

    async parties(): Promise<Party[]> {
      const raw = await createClient().contacts();
      return raw.map(normalizeParty).filter((p): p is Party => p !== null);
    },

    async invoices(since?: string): Promise<Invoice[]> {
      const client = createClient();
      const [salesRaw, purchaseRaw] = await Promise.all([
        client.salesInvoices(since),
        client.purchaseInvoices(since),
      ]);
      const sales = salesRaw
        .map((inv) => normalizeInvoice(inv, "sales"))
        .filter((inv): inv is Invoice => inv !== null);
      const purchases = purchaseRaw
        .map((inv) => normalizeInvoice(inv, "purchase"))
        .filter((inv): inv is Invoice => inv !== null);
      return [...sales, ...purchases];
    },

    async bankTransactions(since?: string): Promise<BankTransaction[]> {
      const raw = await createClient().bankTransactions(since);
      return normalizeBankTransactions(raw);
    },
  };
}

export const sageProvider: FinanceProvider = createSageProvider();
