# Pre-Code Test Plan (`TEST_LIST.md`)

Structured test matrix written **before** any `src/` implementation.

| # | Test Case | Scope / What It Verifies | Status |
| --- | --- | --- | --- |
| 1 | **OAuth2 Code Exchange & `X-Business` Resolution** | `exchangeCode` posts form-encoded grant to `https://oauth.accounting.sage.com/token`, persists tokens, and `GET /businesses` resolves the `business_id` sent as `X-Business` on subsequent calls (and omitted on `GET /businesses`). | `[ ] Pending` |
| 2 | **401 Token Refresh & Dual Token Rotation** | On `HTTP 401` (expired 5-min TTL token, including up to 2,048-byte tokens), client refreshes via `refresh_token`, atomically persists **both** new `access_token` and rotated `refresh_token`, and retries the failed request once. | `[ ] Pending` |
| 3 | **Multi-Page Pagination (`$next === null`)** | List endpoints request `items_per_page=100` and follow `$page` / `$next` across multiple pages until `$next === null`, returning all items without duplicates. | `[ ] Pending` |
| 4 | **Rate Limit (`429`) & Transient `5xx` Backoff** | Client honors `Retry-After` header on `HTTP 429` and retries transient `5xx` responses with exponential backoff up to 3 attempts before failing. | `[ ] Pending` |
| 5 | **Sage `HTTP 405` Fallback to Recorded v3.1 Fixtures** | When `GET /purchase_invoices` returns `HTTP 405` (Sage Start/Sole Trader restriction) or `SAGE_USE_FIXTURES=true`, provider falls back cleanly to `fixtures/sage-v3.1/` with clear logging. | `[ ] Pending` |
| 6 | **Canonical Mapping & Strict `undefined` Rules** | `normalize.ts` maps `LedgerAccount`, `Party`, `Invoice`, and `BankTransaction`: missing `due_date` stays omitted (`undefined`), ISO 4217 currencies are preserved verbatim, `net_amount` excludes tax, bank inflows/outflows have accurate signs, and bank credits/transfers are not double-counted. Passes `validateFinanceSet`. | `[ ] Pending` |
| 7 | **Atomic Snapshot Rollback on Mid-Sync Failure** | If one endpoint fails mid-sync (e.g., `bankTransactions` throws after `accounts` and `invoices` succeed), `runSync` records `ok: false` and leaves the prior complete `.data/store.json` snapshot untouched. | `[ ] Pending` |
| 8 | **Scheduled Sync Live-Edit Pickup (`--watch` / Interval)** | Running scheduled sync detects an edited invoice in Sage or `fixtures/sage-v3.1/` after initial sync, updates the existing record in place (`changed: 1`), and creates zero duplicate IDs. | `[ ] Pending` |
| 9 | **CLI Brief 1: "Who owes us money?"** | Lists ONLY overdue open sales invoices (`dueDate < today` and `outstanding > 0`), reports open invoices with missing `dueDate` as uncounted, while still storing valid not-yet-due open invoices. | `[ ] Pending` |
| 10 | **CLI Brief 2: "What did we spend on software last month?"** | Sums `net` (excluding tax) from October 2026 purchase-invoice lines posted to Software/IT ledger accounts, excluding November 2026 and non-software lines. | `[ ] Pending` |
| 11 | **Clean Fresh-Clone Setup & Execution** | `.env.example`, `npm test`, `npm run typecheck`, `npm run sync`, `npm run show -- finance`, and `npm run ask` execute cleanly from a fresh setup. | `[ ] Pending` |
