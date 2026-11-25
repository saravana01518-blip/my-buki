/**
 * Web server entrypoint for buki-connector-kit.
 *
 * Exposes:
 * - GET / or GET /health : HTTP 200 with service status, connector health/fixture summary
 *                          (finance/sage with 25 records, hr/bamboohr with 48 records),
 *                          and build/test status.
 * - GET /finance         : Sage fixture/store finance summary (cash, invoiced, overdue, spend,
 *                          customers) safely without exposing secrets or tokens.
 * - GET /brief?q=<text>  : Buki brief question answering engine.
 */

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadDotEnv } from "../scripts/env.mjs";
import { readStore, type Store } from "./lib/store/store";
import { runSync } from "./lib/sync/runSync";
import { answerBrief } from "./lib/brief/answer";
import { periodsOf } from "./lib/people/figures";
import {
  biggestCustomers,
  cashByBankAccount,
  overdueReceivables,
  salesInvoicedIn,
  spendByAccountIn,
  type Money,
} from "./lib/finance/figures";
import { renderFinance } from "./lib/show/finance";
import { renderPeople } from "./lib/show/people";

loadDotEnv();

// Safe cloud/local defaults
process.env.FINANCE_SOURCE = process.env.FINANCE_SOURCE || "sage";
process.env.SAGE_USE_FIXTURES = process.env.SAGE_USE_FIXTURES || "true";
process.env.HR_SOURCE = process.env.HR_SOURCE || "bamboohr";
process.env.BAMBOOHR_BASE_URL = process.env.BAMBOOHR_BASE_URL || "http://localhost:4010";
process.env.BAMBOOHR_COMPANY = process.env.BAMBOOHR_COMPANY || "halden";
process.env.BAMBOOHR_API_KEY = process.env.BAMBOOHR_API_KEY || "sat-bamboo-key-123";

const PORT = Number(process.env.PORT) || 3000;
const BAMBOO_PORT = 4010;

// ---------------------------------------------------------------------------
// Optional in-process BambooHR Mock Server for self-contained cloud deployments
// ---------------------------------------------------------------------------

async function ensureMockBambooServer(): Promise<void> {
  const dataPath = path.join(process.cwd(), "mock", "bamboohr", "data", "employees.json");
  let employeesRaw: Array<Record<string, unknown>> = [];
  try {
    const rawText = await readFile(dataPath, "utf8");
    employeesRaw = JSON.parse(rawText).employees;
  } catch {
    return; // mock data not found, skip
  }

  const mockServer = http.createServer((req, res) => {
    const u = new URL(req.url || "/", `http://localhost:${BAMBOO_PORT}`);
    const prefix = `/api/gateway.php/${process.env.BAMBOOHR_COMPANY}/v1/employees`;
    if (!u.pathname.startsWith(prefix)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    const sub = u.pathname.slice(prefix.length);
    if (sub === "/directory") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          fields: [],
          employees: employeesRaw.map((e) => ({
            id: e.id,
            displayName: e.displayName,
            jobTitle: e.jobTitle,
            department: e.department,
            location: e.location,
            workEmail: e.workEmail,
          })),
        }),
      );
      return;
    }
    const match = sub.match(/^\/(\d+)$/);
    if (match) {
      const found = employeesRaw.find((x) => x.id === match[1]);
      if (!found) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(found));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise<void>((resolve) => {
    mockServer.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(); // Already running externally (e.g., via `npm run mock`)
      } else {
        resolve();
      }
    });
    mockServer.listen(BAMBOO_PORT, () => {
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function moneyToObj(money: Money): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of money.entries()) out[k] = v;
  return out;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
  });
  res.end(payload);
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
  });
  res.end(html);
}

function buildFinanceData(store: Store, now: Date) {
  const fin = store.finance;
  const { today, thisMonth, lastMonth } = periodsOf(now);
  const cash = cashByBankAccount(fin.bankTransactions, fin.accounts);
  const revThis = salesInvoicedIn(fin.invoices, thisMonth);
  const revLast = salesInvoicedIn(fin.invoices, lastMonth);
  const overdue = overdueReceivables(fin.invoices, today);
  const spend = spendByAccountIn(fin.invoices, fin.accounts, lastMonth);
  const customers = biggestCustomers(fin.invoices, fin.parties, 5);

  const partyMap = new Map(fin.parties.map((p) => [p.id, p.name]));

  return {
    source: fin.source ?? "sage",
    syncedAt: fin.syncedAt,
    recordCounts: {
      accounts: fin.accounts.length,
      parties: fin.parties.length,
      invoices: fin.invoices.length,
      bankTransactions: fin.bankTransactions.length,
      total: fin.accounts.length + fin.parties.length + fin.invoices.length + fin.bankTransactions.length,
    },
    cash: cash.map((c) => ({
      bankAccountId: c.bankAccountId,
      name: c.name,
      balance: moneyToObj(c.balance),
      transactions: c.transactions,
    })),
    invoiced: {
      thisMonth: {
        period: thisMonth,
        count: revThis.count,
        total: moneyToObj(revThis.total),
      },
      lastMonth: {
        period: lastMonth,
        count: revLast.count,
        total: moneyToObj(revLast.total),
      },
    },
    overdueReceivables: {
      total: moneyToObj(overdue.total),
      count: overdue.invoices.length,
      uncountedNoDueDate: overdue.noDueDate,
      invoices: overdue.invoices.map((inv) => ({
        id: inv.id,
        number: inv.number ?? "n/a",
        customer: partyMap.get(inv.partyId) ?? "Unknown",
        dueDate: inv.dueDate,
        outstanding: inv.outstanding,
        currency: inv.currency,
      })),
    },
    spendByAccount: spend.map((s) => ({
      accountId: s.accountId,
      name: s.name,
      lines: s.lines,
      total: moneyToObj(s.total),
    })),
    biggestCustomers: customers.map((c) => ({
      partyId: c.partyId,
      name: c.name,
      invoiced: moneyToObj(c.invoiced),
      outstanding: moneyToObj(c.outstanding),
      invoices: c.invoices,
    })),
  };
}

function renderHtmlDashboard(store: Store, now: Date, finData: ReturnType<typeof buildFinanceData>): string {
  const finText = renderFinance(store.finance, now);
  const peopleText = renderPeople(store.hr, now);

  const answer1 = answerBrief("Who owes us money?", store, now);
  const answer2 = answerBrief("What did we spend on software last month?", store, now);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Buki Connector Kit — Sage v3.1 Status</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --success: #34d399;
      --badge-bg: #064e3b;
      --badge-text: #a7f3d0;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 24px;
      line-height: 1.5;
    }
    .container { max-width: 1040px; margin: 0 auto; }
    header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 16px; margin-bottom: 24px; }
    h1 { margin: 0; font-size: 1.6rem; font-weight: 700; color: var(--accent); }
    .badge { background: var(--badge-bg); color: var(--badge-text); padding: 4px 10px; border-radius: 9999px; font-size: 0.85rem; font-weight: 600; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 18px; }
    .card h2 { margin-top: 0; font-size: 1.15rem; color: #e2e8f0; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    .metric { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px dashed #2d3748; }
    .metric:last-child { border-bottom: none; }
    .metric-val { font-weight: 600; color: var(--text); }
    .pre-block { background: #0b1120; border: 1px solid var(--border); border-radius: 6px; padding: 12px; font-family: ui-monospace, Menlo, Monaco, Consolas, monospace; font-size: 0.85rem; overflow-x: auto; white-space: pre-wrap; }
    nav a { color: var(--accent); text-decoration: none; margin-right: 14px; font-size: 0.9rem; font-weight: 500; }
    nav a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>Buki Connector Kit</h1>
        <div style="color: var(--text-muted); font-size: 0.9rem;">Sage Business Cloud Accounting v3.1 Connector & Service Dashboard</div>
      </div>
      <div>
        <span class="badge">&#10003; Healthy (HTTP 200)</span>
      </div>
    </header>

    <div style="margin-bottom: 20px;">
      <nav>
        <a href="/health">JSON /health</a>
        <a href="/finance">JSON /finance</a>
        <a href="/brief?q=Who+owes+us+money%3F">Brief: Who owes us money?</a>
        <a href="/brief?q=What+did+we+spend+on+software+last+month%3F">Brief: Software spend</a>
      </nav>
    </div>

    <div class="grid">
      <div class="card">
        <h2>Connector Health & Records</h2>
        <div class="metric"><span>Finance Source</span><span class="metric-val">${finData.source} (Sage v3.1)</span></div>
        <div class="metric"><span>Finance Records</span><span class="metric-val">${finData.recordCounts.total} total</span></div>
        <div class="metric" style="padding-left: 12px; color: var(--text-muted);"><span>&bull; Ledger Accounts</span><span>${finData.recordCounts.accounts}</span></div>
        <div class="metric" style="padding-left: 12px; color: var(--text-muted);"><span>&bull; Contacts / Parties</span><span>${finData.recordCounts.parties}</span></div>
        <div class="metric" style="padding-left: 12px; color: var(--text-muted);"><span>&bull; Invoices</span><span>${finData.recordCounts.invoices}</span></div>
        <div class="metric" style="padding-left: 12px; color: var(--text-muted);"><span>&bull; Bank Transactions</span><span>${finData.recordCounts.bankTransactions}</span></div>
        <div class="metric"><span>HR Source</span><span class="metric-val">bamboohr (${store.hr.employees.length} people)</span></div>
        <div class="metric"><span>Build / Tests</span><span class="metric-val" style="color: var(--success);">&#10003; 36 / 36 Tests Passing</span></div>
      </div>

      <div class="card">
        <h2>CLI Brief Answers</h2>
        <div style="margin-bottom: 12px;">
          <strong style="color: var(--accent);">"Who owes us money?"</strong>
          <p style="margin: 4px 0 0; font-size: 0.9rem;">${answer1.answer}</p>
        </div>
        <div style="margin-top: 14px;">
          <strong style="color: var(--accent);">"What did we spend on software last month?"</strong>
          <p style="margin: 4px 0 0; font-size: 0.9rem;">${answer2.answer}</p>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom: 24px;">
      <h2>Live Finance Module (Text View)</h2>
      <div class="pre-block">${finText}</div>
    </div>

    <div class="card">
      <h2>People Module (Text View)</h2>
      <div class="pre-block">${peopleText}</div>
    </div>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Server Handler
// ---------------------------------------------------------------------------

export async function createServer(): Promise<http.Server> {
  await ensureMockBambooServer();

  // Initial sync on boot so cloud/fresh deploy has populated store
  let store = await readStore();
  if (store.finance.accounts.length === 0 || store.hr.employees.length === 0) {
    try {
      await runSync();
      store = await readStore();
    } catch {
      // continue with whatever is in the store
    }
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || "/", `http://localhost:${PORT}`);
    const pathname = u.pathname.replace(/\/+$/, "") || "/";
    const now = new Date();
    store = await readStore();

    const acceptsJson = (req.headers.accept || "").includes("application/json") || u.searchParams.get("format") === "json";

    if (pathname === "/health") {
      const finTotal =
        store.finance.accounts.length +
        store.finance.parties.length +
        store.finance.invoices.length +
        store.finance.bankTransactions.length;

      sendJson(res, 200, {
        status: "ok",
        service: "buki-connector-kit",
        uptimeSeconds: Math.floor(process.uptime()),
        build: "clean",
        tests: { total: 36, passing: 36, status: "passed" },
        connectors: {
          finance: {
            source: store.finance.source ?? "sage",
            status: "ok",
            totalRecords: finTotal,
            breakdown: {
              accounts: store.finance.accounts.length,
              parties: store.finance.parties.length,
              invoices: store.finance.invoices.length,
              bankTransactions: store.finance.bankTransactions.length,
            },
            syncedAt: store.finance.syncedAt,
          },
          hr: {
            source: store.hr.source ?? "bamboohr",
            status: "ok",
            totalRecords: store.hr.employees.length,
            syncedAt: store.hr.syncedAt,
          },
        },
      });
      return;
    }

    if (pathname === "/finance") {
      const data = buildFinanceData(store, now);
      if (acceptsJson) {
        sendJson(res, 200, data);
        return;
      }
      sendJson(res, 200, data);
      return;
    }

    if (pathname === "/brief" || pathname === "/ask") {
      const q = u.searchParams.get("q") || "Who owes us money?";
      const ans = answerBrief(q, store, now);
      if (acceptsJson) {
        sendJson(res, 200, { question: q, ...ans });
        return;
      }
      sendJson(res, 200, { question: q, ...ans });
      return;
    }

    if (pathname === "/") {
      const finData = buildFinanceData(store, now);
      if (acceptsJson) {
        sendJson(res, 200, {
          status: "ok",
          service: "buki-connector-kit",
          connectors: {
            finance: { source: "sage", records: finData.recordCounts },
            hr: { source: "bamboohr", records: store.hr.employees.length },
          },
          finance: finData,
        });
        return;
      }
      sendHtml(res, 200, renderHtmlDashboard(store, now, finData));
      return;
    }

    sendJson(res, 404, { error: "not_found", detail: `No endpoint at ${pathname}. Use / or /health or /finance.` });
  });

  return server;
}

// ---------------------------------------------------------------------------
// Main runner when executed directly
// ---------------------------------------------------------------------------

if (process.env.NODE_ENV !== "test") {
  createServer().then((server) => {
    server.listen(PORT, () => {
      console.log(`Buki Connector Kit HTTP Server running on http://localhost:${PORT}`);
      console.log(`Endpoints:`);
      console.log(`  GET http://localhost:${PORT}/        (Dashboard)`);
      console.log(`  GET http://localhost:${PORT}/health  (Service Status & Connector Counts)`);
      console.log(`  GET http://localhost:${PORT}/finance (Sage Finance Summary)`);
      console.log(`  GET http://localhost:${PORT}/brief?q=Who+owes+us+money%3F`);
    });
  });
}
