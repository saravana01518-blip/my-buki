# Workspace Rules (`AGENTS.md`)

These rules govern all work on the **Sage Business Cloud Accounting v3.1** connector in `buki-connector-kit`.

## 1. Canonical Data Integrity (Absent, Never Defaulted)
- **Leave missing optional fields absent (`undefined` / omitted from object keys).** Never default `dueDate`, `code`, `email`, `number`, `accountId`, `partyId`, or `sourceUpdatedAt` to `0`, `""`, `null`, `"undefined"`, or synthetic dates.
- Specifically, if Sage returns `due_date: null` or omits `due_date` on an invoice, `Invoice.dueDate` MUST be omitted (`undefined`). `validateFinanceSet` (`npm run check`) treats `null`, `""`, `"null"`, and `"undefined"` as errors.
- **Canonical ID rule:** Every record `id` MUST be `sage:${sourceId}`, and every reference (`partyId`, `accountId`, `bankAccountId`) MUST use that same `sage:${sourceId}` format.
- **Exact ISO 4217 currencies:** Preserve the exact 3-letter uppercase ISO 4217 currency code from Sage (e.g., `GBP`, `USD`, `EUR`). Never convert currencies or invent a default currency when missing.

## 2. Bank Transactions & Double-Counting Prevention
- Map inflows as positive `amount` (`> 0`) and outflows as negative `amount` (`< 0`).
- Deduplicate by canonical `id` (`sage:${sourceId}`).
- Never double-count bank credits, refunds, or inter-account transfers (e.g., if Sage returns linked/mirrored transferlegs or duplicate credit entries, normalize each distinct movement once with its true signed amount on its `bankAccountId`).

## 3. Sage v3.1 API, OAuth2 & Resilience
- **Endpoints:**
  - Base API URL: `https://api.accounting.sage.com/v3.1`
  - OAuth2 Token URL: `https://oauth.accounting.sage.com/token`
- **Headers:** Attach `Authorization: Bearer <access_token>` on all requests, and `X-Business: <business_id>` on all requests except `GET /businesses`.
- **Rotating Refresh Tokens (`HTTP 401`):** Sage access tokens have a 5-minute (300s) TTL and tokens can be up to 2,048 bytes. On `HTTP 401`, refresh using `refresh_token`, atomically persist **BOTH** the new `access_token` and the rotated `refresh_token` to `.data/sage-tokens.json` (temp file + rename), and retry the failed request once.
- **Pagination:** Paginate all list endpoints with `items_per_page=100` and `page` / `$next` until `$next === null`.
- **Rate Limits & Transient Errors:** Honor `Retry-After` on `HTTP 429` and use exponential backoff (up to 3 retries) on transient `5xx` responses.
- **Trial Plan `HTTP 405` Fallback:** If `GET /purchase_invoices` (or another plan-gated endpoint) returns `HTTP 405`, or if `SAGE_USE_FIXTURES=true`, fall back cleanly to labeled recorded v3.1 fixtures in `fixtures/sage-v3.1/` with clear diagnostic logging.

## 4. Atomic Snapshots & Sync Safety
- Never write partial sync state. `runSync` pulls all four finance collections (`accounts`, `parties`, `invoices`, `bankTransactions`) before updating the store.
- All file writes to `.data/store.json` and `.data/sage-tokens.json` MUST use atomic write-to-temp-file-then-rename so a mid-sync crash or failure preserves the prior complete snapshot intact.
- Scheduled sync (`npm run cron` / `--watch` / `SAGE_SYNC_INTERVAL_MS` or `SYNC_INTERVAL_SECONDS`) must detect live edits in Sage or fixture files and update records in place by canonical ID without creating duplicates.
