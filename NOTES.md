# Submission Note — Sage Business Cloud Accounting v3.1 Connector

## What I pulled, and what I left out
- **Pulled from Sage v3.1 (`https://api.accounting.sage.com/v3.1`):**
  - `GET /businesses` -> resolves `business_id` for the `X-Business` header (omitted on `/businesses` itself).
  - `GET /ledger_accounts` -> `LedgerAccount` (`id: "sage:${id}"`, `displayed_as` -> `name`, `nominal_code` -> `code` when present, `ledger_account_type.id` -> canonical `type`).
  - `GET /contacts` -> `Party` (`id: "sage:${id}"`, `name`, `contact_types` -> `customer | supplier | both`, optional `email`).
  - `GET /sales_invoices` & `GET /purchase_invoices` -> `Invoice` (`kind`, `partyId`, optional `number`, `date`, optional `dueDate` strictly omitted when `null`/absent, `status`, exact ISO 4217 `currency`, `total`, `outstanding`, and `lines` using `net_amount` excluding tax linked to `sage:${ledger_account.id}`).
  - `GET /bank_transactions` -> `BankTransaction` (signed `amount` with inflows positive and outflows negative, deduplicated by canonical `id` and `transfer_id` so bank credits and inter-account transfers are never double-counted).
- **Left out and why:**
  - Tax breakdown (`tax_amount`) on invoice lines is excluded from `InvoiceLine.net` because Buki's spend figures track net pre-tax expense (`net_amount`).
  - Draft/void invoices are still synced with their canonical status so downstream `isLive()` filters them out consistently, while unreferenced Sage resources (journals, quotes, stock items) are omitted because Buki's canonical finance model does not consume them.

## How it stays in sync
- `npm run sync` calls `runSync()`, which pulls all four finance collections (`accounts`, `parties`, `invoices`, `bankTransactions`) in parallel before computing diffs (`diffRecords`) and atomically writing `.data/store.json` via temp-file + rename.
- `npm run sync -- --watch` and `npm run cron` run `runSync()` on a configurable interval (`SAGE_SYNC_INTERVAL_MS` or `SYNC_INTERVAL_SECONDS`), detecting edits in Sage or `fixtures/sage-v3.1/` and updating existing records in place by canonical ID without duplicates.

## When Sage is slow, down, or returns something unexpected
- **HTTP 401 (5-minute TTL):** `SageClient` refreshes via `POST https://oauth.accounting.sage.com/token` using a single-flight lock, atomically persists **both** the new `access_token` and rotated `refresh_token` to `.data/sage-tokens.json`, and retries the failed request once.
- **HTTP 429 & 5xx:** Honors `Retry-After` on `429` and applies exponential backoff (up to 3 retries) on `5xx`, with 15s request timeouts.
- **HTTP 405 (plan-gated endpoint):** On Sage Start/Sole Trader trials where `/purchase_invoices` returns `405`, or when `SAGE_USE_FIXTURES=true`, the client logs a diagnostic warning and falls back cleanly to labeled recorded v3.1 fixtures in `fixtures/sage-v3.1/`.
- **Mid-sync failure:** `runSync()` records `ok: false` in `runs` and leaves the prior complete `.data/store.json` snapshot untouched—never writing partial state or synthetic zeros.

## What I would still worry about
- Multi-currency bank transfers or foreign-exchange gain/loss adjustments across differently denominated accounts.
- Very large accounts where full-set syncs without `updated_or_created_since` incremental watermarks hit rate limits, and token rotation if multiple external processes share the same `.data/sage-tokens.json`.
