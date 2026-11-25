/**
 * Pure mapper: Sage v3.1 raw shapes -> Buki canonical finance types.
 *
 * Strictly enforces AGENTS.md:
 * - Missing optional fields are omitted (undefined), never defaulted.
 * - Exact 3-letter uppercase ISO 4217 currency codes are preserved.
 * - Canonical IDs use `sage:${sourceId}`.
 * - Bank transactions are deduplicated and signed without double-counting.
 */

import type { BankTransaction, Invoice, InvoiceLine, LedgerAccount, Party } from "../types";
import type {
  SageBankTransaction,
  SageContact,
  SageInvoice,
  SageLedgerAccount,
} from "./raw/types";

export const canonicalId = (sourceId: string): string => `sage:${sourceId}`;

function optionalStr(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  if (!s || s === "null" || s === "undefined") return undefined;
  return s;
}

function optionalDate(v: unknown): string | undefined {
  const s = optionalStr(v);
  if (!s) return undefined;
  const match = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : undefined;
}

function isoCurrency(v: unknown): string | null {
  const raw =
    typeof v === "string"
      ? v
      : v && typeof v === "object" && "id" in v
        ? (v as { id?: unknown }).id
        : undefined;
  const s = optionalStr(raw)?.toUpperCase();
  if (!s || !/^[A-Z]{3}$/.test(s)) return null;
  return s;
}

function mapAccountType(rawType?: string | null): LedgerAccount["type"] {
  const t = (rawType ?? "").toUpperCase();
  if (t.includes("BANK") || t.includes("CASH") || t.includes("ASSET") || t.includes("DEBTOR")) {
    return "asset";
  }
  if (t.includes("LIABILITY") || t.includes("CREDIT_CARD") || t.includes("CREDITOR") || t.includes("PAYABLE")) {
    return "liability";
  }
  if (t.includes("EQUITY") || t.includes("CAPITAL") || t.includes("RETAINED")) {
    return "equity";
  }
  if (t.includes("SALES") || t.includes("INCOME") || t.includes("REVENUE")) {
    return "income";
  }
  return "expense";
}

export function normalizeLedgerAccount(raw: SageLedgerAccount): LedgerAccount | null {
  const sourceId = optionalStr(raw.id);
  const name = optionalStr(raw.displayed_as);
  if (!sourceId || !name) return null;

  const account: LedgerAccount = {
    id: canonicalId(sourceId),
    source: "sage",
    sourceId,
    name,
    type: mapAccountType(raw.ledger_account_type?.id),
  };

  const code = optionalStr(raw.nominal_code);
  if (code) account.code = code;

  const updatedAt = optionalStr(raw.updated_at);
  if (updatedAt) account.sourceUpdatedAt = updatedAt;

  return account;
}

export function normalizeParty(raw: SageContact): Party | null {
  const sourceId = optionalStr(raw.id);
  const name = optionalStr(raw.name ?? raw.displayed_as);
  if (!sourceId || !name) return null;

  const types = (raw.contact_types ?? []).map((t) => (t.id ?? "").toUpperCase());
  const isCustomer = types.some((t) => t.includes("CUSTOMER"));
  const isSupplier = types.some((t) => t.includes("VENDOR") || t.includes("SUPPLIER"));
  const kind: Party["kind"] =
    isCustomer && isSupplier ? "both" : isSupplier ? "supplier" : "customer";

  const party: Party = {
    id: canonicalId(sourceId),
    source: "sage",
    sourceId,
    name,
    kind,
  };

  const email = optionalStr(raw.email);
  if (email) party.email = email;

  const updatedAt = optionalStr(raw.updated_at);
  if (updatedAt) party.sourceUpdatedAt = updatedAt;

  return party;
}

function mapInvoiceStatus(raw: SageInvoice): Invoice["status"] {
  if (optionalStr(raw.void_reason)) return "void";
  const rawStatus =
    typeof raw.status === "string" ? raw.status : raw.status?.id ?? raw.status?.displayed_as ?? "";
  const s = rawStatus.toUpperCase();
  if (s === "DRAFT") return "draft";
  if (s === "VOID" || s === "DELETED" || s === "CANCELLED") return "void";
  if (s === "PAID") return "paid";
  if (s === "PART_PAID" || s === "PARTIALLY_PAID") return "part_paid";
  return "unpaid";
}

export function normalizeInvoice(raw: SageInvoice, kind: "sales" | "purchase"): Invoice | null {
  const sourceId = optionalStr(raw.id);
  const contactId = optionalStr(raw.contact?.id);
  const date = optionalDate(raw.date);
  const currency = isoCurrency(raw.currency);
  if (!sourceId || !contactId || !date || !currency) return null;

  const total = Number(raw.total_amount ?? 0);
  if (!Number.isFinite(total)) return null;

  const status = mapInvoiceStatus(raw);
  const rawOutstanding = raw.outstanding_amount ?? (status === "paid" ? 0 : total);
  const outstanding = status === "paid" ? 0 : Math.min(total, Math.max(0, Number(rawOutstanding)));

  const lines: InvoiceLine[] = [];
  for (const line of raw.invoice_lines ?? []) {
    const accountId = optionalStr(line.ledger_account?.id);
    const net = Number(line.net_amount);
    if (!accountId || !Number.isFinite(net)) continue;
    lines.push({
      description: optionalStr(line.description) ?? `${kind} line`,
      accountId: canonicalId(accountId),
      net,
    });
  }

  const invoice: Invoice = {
    id: canonicalId(sourceId),
    source: "sage",
    sourceId,
    kind,
    partyId: canonicalId(contactId),
    date,
    status,
    currency,
    total,
    outstanding,
    lines,
  };

  const number = optionalStr(raw.invoice_number ?? raw.reference);
  if (number) invoice.number = number;

  // Strictly omit dueDate when Sage returns null or omits due_date.
  const dueDate = optionalDate(raw.due_date);
  if (dueDate) invoice.dueDate = dueDate;

  const updatedAt = optionalStr(raw.updated_at);
  if (updatedAt) invoice.sourceUpdatedAt = updatedAt;

  return invoice;
}

function signedBankAmount(raw: SageBankTransaction, rawAmount: number): number {
  const txType =
    typeof raw.transaction_type === "string"
      ? raw.transaction_type
      : raw.transaction_type?.id ?? "";
  const t = txType.toUpperCase();

  // If Sage already provides a negative amount, preserve it.
  if (rawAmount < 0) return rawAmount;

  // Unsigned positive amounts on outflow types become negative.
  if (
    t.includes("PAYMENT") ||
    t.includes("WITHDRAWAL") ||
    t.includes("PURCHASE") ||
    t.includes("TRANSFER_OUT") ||
    t.includes("DEBIT")
  ) {
    return -Math.abs(rawAmount);
  }
  return rawAmount;
}

export function normalizeBankTransactions(raws: SageBankTransaction[]): BankTransaction[] {
  const seenIds = new Set<string>();
  const seenTransfers = new Set<string>();
  const out: BankTransaction[] = [];

  for (const raw of raws) {
    if (raw.is_duplicate_credit) continue;

    const sourceId = optionalStr(raw.id);
    const bankAccId = optionalStr(raw.bank_account?.id);
    const date = optionalDate(raw.date);
    const currency = isoCurrency(raw.currency);
    const rawAmt = Number(raw.total_amount ?? raw.amount);
    if (!sourceId || !bankAccId || !date || !currency || !Number.isFinite(rawAmt)) continue;

    const id = canonicalId(sourceId);
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const amount = signedBankAmount(raw, rawAmt);

    // Prevent double-counting mirrored transfer/credit legs on the same bank account.
    const transferId = optionalStr(raw.transfer_id);
    if (transferId) {
      const transferKey = `${transferId}:${bankAccId}:${amount}`;
      if (seenTransfers.has(transferKey)) continue;
      seenTransfers.add(transferKey);
    }

    const txn: BankTransaction = {
      id,
      source: "sage",
      sourceId,
      bankAccountId: canonicalId(bankAccId),
      date,
      amount,
      currency,
      description: optionalStr(raw.description ?? raw.reference ?? raw.displayed_as) ?? "Bank transaction",
    };

    const accountId = optionalStr(raw.ledger_account?.id);
    if (accountId) txn.accountId = canonicalId(accountId);

    const partyId = optionalStr(raw.contact?.id);
    if (partyId) txn.partyId = canonicalId(partyId);

    const updatedAt = optionalStr(raw.updated_at);
    if (updatedAt) txn.sourceUpdatedAt = updatedAt;

    out.push(txn);
  }

  return out;
}
