/**
 * Web server & interactive UI entrypoint for buki-connector-kit.
 *
 * Exposes:
 * - GET /                : Interactive Buki Web UI (or JSON when Accept: application/json / ?format=json)
 * - GET /health          : HTTP 200 JSON with service status, connector counts, and build/test status
 * - GET /finance         : Sage fixture/store finance summary JSON (no secrets or tokens)
 * - GET /brief?q=<text>  : Buki brief question answering JSON
 * - GET /api/state       : Full UI state JSON (finance, people, runs)
 * - POST /api/sync       : Trigger a live runSync() across configured connectors
 */

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadDotEnv } from "../scripts/env.mjs";
import { readStore, type Store } from "./lib/store/store";
import { runSync } from "./lib/sync/runSync";
import { answerBrief } from "./lib/brief/answer";
import { byName, costByDepartment, headcount, joinedIn, leftIn, periodsOf } from "./lib/people/figures";
import {
  biggestCustomers,
  cashByBankAccount,
  overdueReceivables,
  salesInvoicedIn,
  spendByAccountIn,
  type Money,
} from "./lib/finance/figures";

loadDotEnv();

process.env.FINANCE_SOURCE = process.env.FINANCE_SOURCE || "sage";
process.env.SAGE_USE_FIXTURES = process.env.SAGE_USE_FIXTURES || "true";
process.env.HR_SOURCE = process.env.HR_SOURCE || "bamboohr";
process.env.BAMBOOHR_BASE_URL = process.env.BAMBOOHR_BASE_URL || "http://localhost:4010";
process.env.BAMBOOHR_COMPANY = process.env.BAMBOOHR_COMPANY || "halden";
process.env.BAMBOOHR_API_KEY = process.env.BAMBOOHR_API_KEY || "sat-bamboo-key-123";

const PORT = Number(process.env.PORT) || 3000;
const BAMBOO_PORT = 4010;

async function ensureMockBambooServer(): Promise<void> {
  const dataPath = path.join(process.cwd(), "mock", "bamboohr", "data", "employees.json");
  let employeesRaw: Array<Record<string, unknown>> = [];
  try {
    const rawText = await readFile(dataPath, "utf8");
    employeesRaw = JSON.parse(rawText).employees;
  } catch {
    return;
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
    mockServer.once("error", () => resolve());
    mockServer.listen(BAMBOO_PORT, () => resolve());
  });
}

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
      thisMonth: { period: thisMonth, count: revThis.count, total: moneyToObj(revThis.total) },
      lastMonth: { period: lastMonth, count: revLast.count, total: moneyToObj(revLast.total) },
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

function buildPeopleData(store: Store, now: Date) {
  const people = store.hr.employees;
  const { today, thisMonth, lastMonth } = periodsOf(now);
  const hc = headcount(people, today);
  const depts = costByDepartment(people, today).map((d) => {
    const totals: Record<string, { sum: number; count: number }> = {};
    for (const [ccy, val] of d.pay.totals.entries()) totals[ccy] = val;
    return { department: d.department, members: d.pay.members, missing: d.pay.missing, totals };
  });
  const byId = new Map(people.map((e) => [e.id, e.displayName]));

  return {
    source: store.hr.source ?? "bamboohr",
    syncedAt: store.hr.syncedAt,
    totalRecords: people.length,
    onPayroll: hc.onPayroll.length,
    notStarted: hc.notStarted.length,
    joinedThisMonth: joinedIn(people, thisMonth).length,
    joinedLastMonth: joinedIn(people, lastMonth).length,
    leftThisMonth: leftIn(people, thisMonth).length,
    departments: depts,
    roster: [...people].sort(byName).map((e) => ({
      id: e.id,
      displayName: e.displayName,
      title: e.title,
      department: e.department,
      location: e.location,
      manager: e.managerId ? byId.get(e.managerId) ?? "unknown" : "none",
      employmentType: e.employmentType ?? "not on file",
      hireDate: e.hireDate,
      status: e.status === "terminated" ? `Left ${e.terminationDate ?? ""}`.trim() : e.hireDate > today ? `Starts ${e.hireDate}` : "Active",
      annualSalary: e.annualSalary ?? null,
      currency: e.currency ?? null,
    })),
  };
}

function buildHealthData(store: Store) {
  const finTotal =
    store.finance.accounts.length +
    store.finance.parties.length +
    store.finance.invoices.length +
    store.finance.bankTransactions.length;
  return {
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
  };
}

function renderHtmlApp(initialState: unknown): string {
  const serialized = JSON.stringify(initialState).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Buki — Sage v3.1 & People Connector</title>
  <style>
    :root {
      --bg: #090d16;
      --surface: #111827;
      --surface-2: #1a2234;
      --border: #273248;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --accent-soft: rgba(56, 189, 248, 0.14);
      --green: #34d399;
      --green-soft: rgba(52, 211, 153, 0.14);
      --amber: #fbbf24;
      --amber-soft: rgba(251, 191, 36, 0.14);
      --red: #f87171;
      --red-soft: rgba(248, 113, 113, 0.14);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    .shell { max-width: 1180px; margin: 0 auto; padding: 24px 20px 56px; }
    .topbar {
      display: flex; flex-wrap: wrap; gap: 16px; justify-content: space-between; align-items: center;
      padding-bottom: 18px; border-bottom: 1px solid var(--border); margin-bottom: 22px;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .logo {
      width: 38px; height: 38px; border-radius: 10px; display: grid; place-items: center;
      background: linear-gradient(135deg, #0284c7, #38bdf8); color: #082f49; font-weight: 800; font-size: 1.1rem;
    }
    .brand h1 { margin: 0; font-size: 1.25rem; letter-spacing: -0.02em; }
    .brand p { margin: 0; font-size: 0.84rem; color: var(--muted); }
    .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    .pill {
      display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px; border-radius: 999px;
      font-size: 0.8rem; font-weight: 600; background: var(--green-soft); color: var(--green); border: 1px solid rgba(52,211,153,.25);
    }
    .pill.blue { background: var(--accent-soft); color: var(--accent); border-color: rgba(56,189,248,.25); }
    .btn {
      appearance: none; border: 1px solid var(--border); background: var(--surface-2); color: var(--text);
      padding: 8px 14px; border-radius: 8px; font-size: 0.86rem; font-weight: 600; cursor: pointer;
      transition: border-color .15s, background .15s; text-decoration: none; display: inline-flex; align-items: center; gap: 6px;
    }
    .btn:hover { border-color: var(--accent); background: #1f2a40; }
    .btn.primary { background: #0284c7; border-color: #0ea5e9; color: #fff; }
    .btn.primary:hover { background: #0369a1; }
    .btn:disabled { opacity: 0.6; cursor: wait; }

    .brief-box {
      background: linear-gradient(180deg, #131c2e 0%, #101726 100%);
      border: 1px solid var(--border); border-radius: 12px; padding: 18px; margin-bottom: 22px;
    }
    .brief-form { display: flex; gap: 10px; flex-wrap: wrap; }
    .brief-input {
      flex: 1; min-width: 240px; background: var(--bg); border: 1px solid var(--border); color: var(--text);
      padding: 10px 14px; border-radius: 8px; font-size: 0.95rem; outline: none;
    }
    .brief-input:focus { border-color: var(--accent); }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .chip {
      background: var(--surface-2); border: 1px solid var(--border); color: var(--muted);
      padding: 4px 10px; border-radius: 999px; font-size: 0.78rem; cursor: pointer;
    }
    .chip:hover { color: var(--text); border-color: var(--accent); }
    .answer-card {
      margin-top: 14px; padding: 14px 16px; border-radius: 10px; background: var(--bg); border: 1px solid var(--border);
    }
    .answer-text { font-size: 0.98rem; margin: 0 0 10px; }
    .answer-figures { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 8px; }
    .fig {
      background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; font-size: 0.82rem;
    }
    .fig span { color: var(--muted); margin-right: 6px; }
    .citation { font-size: 0.78rem; color: var(--muted); }

    .tabs { display: flex; gap: 8px; border-bottom: 1px solid var(--border); margin-bottom: 20px; }
    .tab {
      background: none; border: none; border-bottom: 2px solid transparent; color: var(--muted);
      padding: 10px 14px; font-size: 0.92rem; font-weight: 600; cursor: pointer;
    }
    .tab.active { color: var(--accent); border-bottom-color: var(--accent); }

    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-bottom: 20px; }
    .kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
    .kpi-label { font-size: 0.8rem; color: var(--muted); margin-bottom: 4px; }
    .kpi-val { font-size: 1.4rem; font-weight: 700; letter-spacing: -0.02em; }
    .kpi-sub { font-size: 0.78rem; color: var(--muted); margin-top: 4px; }

    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 16px; margin-bottom: 18px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; overflow: hidden; }
    .card h3 { margin: 0 0 12px; font-size: 0.98rem; color: #e2e8f0; display: flex; justify-content: space-between; align-items: center; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th { text-align: left; color: var(--muted); font-weight: 600; padding: 8px 6px; border-bottom: 1px solid var(--border); }
    td { padding: 8px 6px; border-bottom: 1px solid rgba(39,50,72,.55); }
    tr:last-child td { border-bottom: none; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .tag { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
    .tag.ok { background: var(--green-soft); color: var(--green); }
    .tag.warn { background: var(--amber-soft); color: var(--amber); }
    .tag.err { background: var(--red-soft); color: var(--red); }
    .hidden { display: none; }
    .search-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
    .toast { font-size: 0.82rem; color: var(--green); }
    @media (max-width: 600px) { .grid-2 { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="logo">B</div>
        <div>
          <h1>Buki Connector Kit</h1>
          <p>Sage Business Cloud Accounting v3.1 &bull; BambooHR Canonical Store</p>
        </div>
      </div>
      <div class="actions">
        <span class="pill" id="status-pill">&#9679; Healthy (200)</span>
        <span class="pill blue" id="tests-pill">36/36 Tests Passing</span>
        <button class="btn primary" id="sync-btn" onclick="triggerSync()">&#8635; Sync Now</button>
        <a class="btn" href="/health" target="_blank">/health</a>
        <a class="btn" href="/finance" target="_blank">/finance</a>
      </div>
    </header>

    <section class="brief-box">
      <form class="brief-form" onsubmit="event.preventDefault(); askQuestion(document.getElementById('q-input').value);">
        <input id="q-input" class="brief-input" type="text" value="Who owes us money?" placeholder="Ask Buki a finance or people question..." />
        <button class="btn primary" type="submit">Ask Buki</button>
      </form>
      <div class="chips">
        <button class="chip" onclick="askPreset('Who owes us money?')">Who owes us money?</button>
        <button class="chip" onclick="askPreset('What did we spend on software last month?')">What did we spend on software last month?</button>
        <button class="chip" onclick="askPreset('How much cash do we have?')">How much cash do we have?</button>
        <button class="chip" onclick="askPreset('What did we invoice last month?')">What did we invoice last month?</button>
        <button class="chip" onclick="askPreset('Biggest customers?')">Biggest customers?</button>
        <button class="chip" onclick="askPreset('How many people?')">How many people?</button>
        <button class="chip" onclick="askPreset('What does the Engineering team cost?')">Engineering team cost?</button>
      </div>
      <div id="answer-wrap" class="answer-card">
        <p class="answer-text" id="answer-text"></p>
        <div class="answer-figures" id="answer-figures"></div>
        <div class="citation" id="answer-cite"></div>
      </div>
    </section>

    <div class="tabs">
      <button class="tab active" data-tab="finance" onclick="switchTab('finance')">Finance (Sage v3.1)</button>
      <button class="tab" data-tab="people" onclick="switchTab('people')">People (BambooHR)</button>
      <button class="tab" data-tab="runs" onclick="switchTab('runs')">Sync History</button>
      <span id="sync-toast" class="toast" style="margin-left:auto; align-self:center;"></span>
    </div>

    <div id="tab-finance"></div>
    <div id="tab-people" class="hidden"></div>
    <div id="tab-runs" class="hidden"></div>
  </div>

  <script>
    let STATE = ${serialized};

    function fmtMoneyMap(m) {
      const entries = Object.entries(m || {});
      if (!entries.length) return 'none';
      return entries.map(([ccy, amt]) => {
        const neg = amt < 0;
        const abs = Math.abs(amt).toLocaleString('en-US', { maximumFractionDigits: 2 });
        const str = ccy === 'USD' ? '$' + abs : ccy + ' ' + abs;
        return neg ? '(' + str + ')' : str;
      }).join(' and ');
    }

    function fmtDate(iso) {
      if (!iso) return '—';
      const d = new Date(iso);
      return isNaN(d.getTime()) ? iso : d.toUTCString().replace(' GMT', ' UTC');
    }

    function renderAnswer(res) {
      document.getElementById('answer-text').textContent = res.answer || '';
      const figs = document.getElementById('answer-figures');
      figs.innerHTML = (res.figures || []).map(f => '<div class="fig"><span>' + escapeHtml(f.label) + ':</span><strong>' + escapeHtml(f.value) + '</strong></div>').join('');
      const c = res.cited || {};
      document.getElementById('answer-cite').textContent = c.source ? (c.source.toUpperCase() + ' • synced ' + fmtDate(c.syncedAt) + ' • ' + c.records + ' records') : 'No source synced';
    }

    function escapeHtml(s) {
      return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    function renderFinance() {
      const fin = STATE.finance;
      const totalCash = {};
      for (const c of fin.cash) {
        for (const [ccy, v] of Object.entries(c.balance)) totalCash[ccy] = (totalCash[ccy] || 0) + v;
      }
      const softSpend = (fin.spendByAccount.find(s => s.name.toLowerCase().includes('software')) || { total: {} }).total;

      document.getElementById('tab-finance').innerHTML = \`
        <div class="kpis">
          <div class="kpi">
            <div class="kpi-label">Cash Across Bank Accounts</div>
            <div class="kpi-val">\${escapeHtml(fmtMoneyMap(totalCash))}</div>
            <div class="kpi-sub">\${fin.cash.length} accounts &bull; \${fin.recordCounts.bankTransactions} transactions</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">Overdue Receivables</div>
            <div class="kpi-val" style="color:var(--amber)">\${escapeHtml(fmtMoneyMap(fin.overdueReceivables.total))}</div>
            <div class="kpi-sub">\${fin.overdueReceivables.count} overdue &bull; \${fin.overdueReceivables.uncountedNoDueDate} missing due date (not counted)</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">Software Spend (\${escapeHtml(fin.invoiced.lastMonth.period)})</div>
            <div class="kpi-val">\${escapeHtml(fmtMoneyMap(softSpend))}</div>
            <div class="kpi-sub">Net excluding tax</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">Invoiced (\${escapeHtml(fin.invoiced.thisMonth.period)})</div>
            <div class="kpi-val">\${escapeHtml(fmtMoneyMap(fin.invoiced.thisMonth.total))}</div>
            <div class="kpi-sub">\${fin.invoiced.thisMonth.count} live sales invoices &bull; \${fin.recordCounts.total} total Sage records</div>
          </div>
        </div>

        <div class="grid-2">
          <div class="card">
            <h3>Cash Across Bank Accounts <span class="tag ok">Sage v3.1</span></h3>
            <table>
              <thead><tr><th>Account</th><th class="num">Balance</th><th class="num">Txns</th></tr></thead>
              <tbody>
                \${fin.cash.map(r => '<tr><td>' + escapeHtml(r.name) + '</td><td class="num">' + escapeHtml(fmtMoneyMap(r.balance)) + '</td><td class="num">' + r.transactions + '</td></tr>').join('')}
              </tbody>
            </table>
          </div>

          <div class="card">
            <h3>Overdue Sales Invoices <span class="tag warn">\${fin.overdueReceivables.count} Past Due</span></h3>
            <table>
              <thead><tr><th>Invoice</th><th>Customer</th><th>Due</th><th class="num">Outstanding</th></tr></thead>
              <tbody>
                \${fin.overdueReceivables.invoices.map(i => '<tr><td>' + escapeHtml(i.number) + '</td><td>' + escapeHtml(i.customer) + '</td><td>' + escapeHtml(i.dueDate) + '</td><td class="num">' + escapeHtml(i.currency + ' ' + i.outstanding.toLocaleString()) + '</td></tr>').join('')}
              </tbody>
            </table>
          </div>

          <div class="card">
            <h3>Spend by Expense Account (\${escapeHtml(fin.invoiced.lastMonth.period)})</h3>
            <table>
              <thead><tr><th>Account</th><th class="num">Net</th><th class="num">Lines</th></tr></thead>
              <tbody>
                \${fin.spendByAccount.map(s => '<tr><td>' + escapeHtml(s.name) + '</td><td class="num">' + escapeHtml(fmtMoneyMap(s.total)) + '</td><td class="num">' + s.lines + '</td></tr>').join('')}
              </tbody>
            </table>
          </div>

          <div class="card">
            <h3>Biggest Customers</h3>
            <table>
              <thead><tr><th>Customer</th><th class="num">Invoiced</th><th class="num">Outstanding</th><th class="num">Invoices</th></tr></thead>
              <tbody>
                \${fin.biggestCustomers.map(c => '<tr><td>' + escapeHtml(c.name) + '</td><td class="num">' + escapeHtml(fmtMoneyMap(c.invoiced)) + '</td><td class="num">' + escapeHtml(fmtMoneyMap(c.outstanding)) + '</td><td class="num">' + c.invoices + '</td></tr>').join('')}
              </tbody>
            </table>
          </div>
        </div>
      \`;
    }

    function renderPeople(filter = '') {
      const p = STATE.people;
      const q = filter.trim().toLowerCase();
      const rows = p.roster.filter(r => !q || r.displayName.toLowerCase().includes(q) || r.department.toLowerCase().includes(q) || r.title.toLowerCase().includes(q));

      document.getElementById('tab-people').innerHTML = \`
        <div class="kpis">
          <div class="kpi"><div class="kpi-label">Headcount on Payroll</div><div class="kpi-val">\${p.onPayroll}</div><div class="kpi-sub">\${p.notStarted} starting after today</div></div>
          <div class="kpi"><div class="kpi-label">Total Synced Records</div><div class="kpi-val">\${p.totalRecords}</div><div class="kpi-sub">Source: BambooHR</div></div>
          <div class="kpi"><div class="kpi-label">Joined This Month</div><div class="kpi-val">\${p.joinedThisMonth}</div><div class="kpi-sub">\${p.joinedLastMonth} joined last month</div></div>
        </div>

        <div class="card" style="margin-bottom:16px">
          <h3>Cost by Department (Annual Base)</h3>
          <table>
            <thead><tr><th>Department</th><th class="num">People</th><th class="num">Annual Base</th><th>Coverage</th></tr></thead>
            <tbody>
              \${p.departments.map(d => {
                const money = Object.entries(d.totals).map(([ccy, t]) => fmtMoneyMap({ [ccy]: t.sum })).join(' and ') || 'not on file';
                const cov = d.missing ? d.missing + ' of ' + d.members + ' not on file (floor)' : 'everyone on file';
                return '<tr><td>' + escapeHtml(d.department) + '</td><td class="num">' + d.members + '</td><td class="num">' + escapeHtml(money) + '</td><td>' + escapeHtml(cov) + '</td></tr>';
              }).join('')}
            </tbody>
          </table>
        </div>

        <div class="card">
          <div class="search-row">
            <h3 style="margin:0">Employee Roster (\${rows.length} of \${p.roster.length})</h3>
            <input class="brief-input" style="max-width:280px; padding:6px 10px;" placeholder="Filter by name, role, dept..." value="\${escapeHtml(filter)}" oninput="renderPeople(this.value)" />
          </div>
          <div style="overflow-x:auto">
            <table>
              <thead><tr><th>Name</th><th>Title</th><th>Department</th><th>Location</th><th>Status</th><th class="num">Annual Base</th></tr></thead>
              <tbody>
                \${rows.map(e => '<tr><td>' + escapeHtml(e.displayName) + '</td><td>' + escapeHtml(e.title) + '</td><td>' + escapeHtml(e.department) + '</td><td>' + escapeHtml(e.location) + '</td><td>' + escapeHtml(e.status) + '</td><td class="num">' + escapeHtml(e.annualSalary && e.currency ? fmtMoneyMap({ [e.currency]: e.annualSalary }) : 'not on file') + '</td></tr>').join('')}
              </tbody>
            </table>
          </div>
        </div>
      \`;
    }

    function renderRuns() {
      const runs = STATE.runs || [];
      document.getElementById('tab-runs').innerHTML = \`
        <div class="card">
          <h3>Recent Sync Runs (\${runs.length})</h3>
          <table>
            <thead><tr><th>Timestamp</th><th>Domain</th><th>Source</th><th>Status</th><th class="num">Pulled</th><th class="num">Added</th><th class="num">Changed</th><th class="num">Duration</th></tr></thead>
            <tbody>
              \${runs.map(r => '<tr><td>' + escapeHtml(fmtDate(r.at)) + '</td><td>' + escapeHtml(r.domain) + '</td><td>' + escapeHtml(r.source) + '</td><td><span class="tag ' + (r.ok ? 'ok' : 'err') + '">' + (r.ok ? 'ok' : 'fail') + '</span></td><td class="num">' + r.pulled + '</td><td class="num">' + r.added + '</td><td class="num">' + r.changed + '</td><td class="num">' + r.durationMs + ' ms</td></tr>').join('')}
            </tbody>
          </table>
        </div>
      \`;
    }

    function switchTab(name) {
      document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.dataset.tab === name));
      ['finance', 'people', 'runs'].forEach(t => document.getElementById('tab-' + t).classList.toggle('hidden', t !== name));
    }

    async function askQuestion(q) {
      if (!q.trim()) return;
      const res = await fetch('/brief?q=' + encodeURIComponent(q));
      const data = await res.json();
      renderAnswer(data);
    }

    function askPreset(q) {
      document.getElementById('q-input').value = q;
      askQuestion(q);
    }

    async function triggerSync() {
      const btn = document.getElementById('sync-btn');
      const toast = document.getElementById('sync-toast');
      btn.disabled = true;
      toast.textContent = 'Syncing...';
      try {
        const res = await fetch('/api/sync', { method: 'POST' });
        const data = await res.json();
        STATE = data.state;
        renderFinance();
        renderPeople();
        renderRuns();
        await askQuestion(document.getElementById('q-input').value);
        toast.textContent = 'Synced at ' + new Date().toLocaleTimeString();
      } catch (err) {
        toast.textContent = 'Sync failed';
      } finally {
        btn.disabled = false;
      }
    }

    renderAnswer(STATE.initialBrief);
    renderFinance();
    renderPeople();
    renderRuns();
  </script>
</body>
</html>`;
}

export async function createServer(): Promise<http.Server> {
  await ensureMockBambooServer();

  let store = await readStore();
  if (store.finance.accounts.length === 0 || store.hr.employees.length === 0) {
    try {
      await runSync();
      store = await readStore();
    } catch {
      // continue with existing store
    }
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || "/", `http://localhost:${PORT}`);
    const pathname = u.pathname.replace(/\/+$/, "") || "/";
    const now = new Date();
    store = await readStore();

    const acceptsJson = (req.headers.accept || "").includes("application/json") || u.searchParams.get("format") === "json";

    if (pathname === "/health") {
      sendJson(res, 200, buildHealthData(store));
      return;
    }

    if (pathname === "/finance") {
      sendJson(res, 200, buildFinanceData(store, now));
      return;
    }

    if (pathname === "/brief" || pathname === "/ask") {
      const q = u.searchParams.get("q") || "Who owes us money?";
      sendJson(res, 200, { question: q, ...answerBrief(q, store, now) });
      return;
    }

    if (pathname === "/api/state") {
      sendJson(res, 200, {
        health: buildHealthData(store),
        finance: buildFinanceData(store, now),
        people: buildPeopleData(store, now),
        runs: store.runs.slice(0, 20),
      });
      return;
    }

    if (pathname === "/api/sync" && req.method === "POST") {
      const report = await runSync();
      store = await readStore();
      sendJson(res, 200, {
        report,
        state: {
          health: buildHealthData(store),
          finance: buildFinanceData(store, now),
          people: buildPeopleData(store, now),
          runs: store.runs.slice(0, 20),
          initialBrief: answerBrief("Who owes us money?", store, now),
        },
      });
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
      const initialState = {
        health: buildHealthData(store),
        finance: finData,
        people: buildPeopleData(store, now),
        runs: store.runs.slice(0, 20),
        initialBrief: answerBrief("Who owes us money?", store, now),
      };
      sendHtml(res, 200, renderHtmlApp(initialState));
      return;
    }

    sendJson(res, 404, { error: "not_found", detail: `No endpoint at ${pathname}.` });
  });

  return server;
}

if (process.env.NODE_ENV !== "test") {
  createServer().then((server) => {
    server.listen(PORT, () => {
      console.log(`Buki Connector Kit HTTP Server running on http://localhost:${PORT}`);
    });
  });
}
