/**
 * Re-exports the pure Sage v3.1 mapper functions under normalize.ts
 * to match the kit's BambooHR naming convention alongside mapper.ts.
 */
export {
  canonicalId,
  normalizeLedgerAccount,
  normalizeParty,
  normalizeInvoice,
  normalizeBankTransactions,
} from "./mapper";
