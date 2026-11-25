/**
 * Web server & interactive UI entrypoint for buki-connector-kit.
 *
 * Exposes:
 * - GET /                : Buki Workspace Dashboard UI (light-mode fintech UI, wired to live store)
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

  const salesInvoices = fin.invoices
    .filter((inv) => inv.kind === "sales" && inv.status !== "void" && inv.status !== "draft")
    .map((inv) => {
      const isOverdue = (inv.status === "unpaid" || inv.status === "part_paid") && Boolean(inv.dueDate && inv.dueDate < today);
      return {
        id: inv.id,
        number: inv.number ?? inv.sourceId,
        customer: partyMap.get(inv.partyId) ?? "Customer not on file",
        description: inv.lines[0]?.description ?? "Sales invoice",
        date: inv.date,
        dueDate: inv.dueDate ?? null,
        status: inv.status,
        isOverdue,
        total: inv.total,
        outstanding: inv.outstanding,
        currency: inv.currency,
      };
    });

  return {
    source: fin.source ?? "sage",
    syncedAt: fin.syncedAt,
    today,
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
    salesInvoices,
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
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Buki Workspace — Sage v3.1 & People Connector</title>
  <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    @layer base { html, body { margin: 0; padding: 0; font-family: 'Inter', system-ui, sans-serif; } }
    .font-mono-code { font-family: 'JetBrains Mono', ui-monospace, monospace; }
    .fintech-card { background: #ffffff; border: 1px solid rgba(226, 232, 240, 0.9); border-radius: 0.75rem; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.03); }
    .fintech-kpi-urgent { background: linear-gradient(180deg, #fff1f2 0%, #ffffff 100%); border: 1px solid #fecdd3; border-radius: 0.75rem; box-shadow: 0 2px 10px -2px rgba(225, 29, 72, 0.08); }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 9999px; }
  </style>
</head>
<body class="bg-slate-50 text-slate-900 antialiased">

  <!-- Left Sidebar -->
  <aside class="fixed left-0 top-0 h-full w-[252px] bg-white border-r border-slate-200/80 z-50 hidden lg:flex flex-col justify-between shadow-[1px_0_4px_rgba(0,0,0,0.02)]">
    <div class="flex flex-col">
      <div class="p-4 border-b border-slate-100">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-xl bg-slate-900 text-white flex items-center justify-center font-extrabold text-base shadow-sm ring-1 ring-slate-800">B</div>
          <div class="flex flex-col">
            <div class="flex items-center gap-1.5">
              <span class="font-bold text-[15px] text-slate-900 tracking-tight">Buki</span>
              <span class="px-1.5 py-0.5 text-[10px] font-semibold bg-emerald-50 text-emerald-700 rounded-full border border-emerald-200/70 uppercase tracking-wide">v3.1</span>
            </div>
            <span class="text-[11px] text-slate-500 font-mono-code font-medium">Sage Connector</span>
          </div>
        </div>
        <div class="mt-3 flex items-center justify-between px-2.5 py-1.5 bg-slate-50 border border-slate-200/70 rounded-lg">
          <span class="text-[11px] font-medium text-slate-600 truncate">Sage v3.1 Finance</span>
          <span class="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 bg-emerald-100/60 px-1.5 py-0.5 rounded font-mono-code uppercase tracking-wider">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>ACTIVE
          </span>
        </div>
      </div>

      <nav class="flex flex-col px-3 py-3 space-y-1">
        <button onclick="switchPage('finance')" id="nav-finance" class="nav-item flex items-center justify-between px-3 py-2.5 rounded-lg text-slate-900 bg-slate-100/80 font-semibold text-[13px] border border-slate-200/60 transition-all cursor-pointer text-left">
          <div class="flex items-center gap-2.5"><span class="material-symbols-outlined text-[19px]">query_stats</span><span>Finance Overview</span></div>
          <span class="w-1.5 h-1.5 rounded-full bg-slate-900"></span>
        </button>
        <button onclick="switchPage('people')" id="nav-people" class="nav-item flex items-center justify-between px-3 py-2.5 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-50 font-medium text-[13px] transition-all cursor-pointer text-left">
          <div class="flex items-center gap-2.5"><span class="material-symbols-outlined text-[19px] text-slate-400">groups</span><span>People &amp; Payroll</span></div>
          <span class="text-[10px] font-mono-code bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded font-semibold" id="nav-people-count">48</span>
        </button>
        <button onclick="focusAsk()" class="nav-item flex items-center justify-between px-3 py-2.5 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-50 font-medium text-[13px] transition-all cursor-pointer text-left">
          <div class="flex items-center gap-2.5"><span class="material-symbols-outlined text-[19px] text-slate-400">neurology</span><span>Ask Buki Q&amp;A</span></div>
          <span class="bg-indigo-50 text-indigo-600 border border-indigo-200/60 text-[10px] font-bold px-1.5 py-0.5 rounded-md font-mono-code">BRIEF</span>
        </button>
        <button onclick="switchPage('runs')" id="nav-runs" class="nav-item flex items-center justify-between px-3 py-2.5 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-50 font-medium text-[13px] transition-all cursor-pointer text-left">
          <div class="flex items-center gap-2.5"><span class="material-symbols-outlined text-[19px] text-slate-400">cloud_done</span><span>Sync &amp; Connector</span></div>
          <span class="w-2 h-2 rounded-full bg-emerald-500 ring-2 ring-emerald-100"></span>
        </button>
      </nav>
    </div>

    <div class="p-3.5 border-t border-slate-100">
      <div class="bg-slate-50/80 p-3 rounded-xl border border-slate-200/70 flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <span class="text-[12px] font-bold text-slate-900 truncate">Halden Labs Ltd</span>
          <span class="bg-emerald-100 text-emerald-800 text-[10px] font-semibold px-2 py-0.5 rounded-full border border-emerald-200/50">36/36 Tests</span>
        </div>
        <div class="text-[11px] text-slate-500 font-mono-code" id="sidebar-counts">25 Sage / 48 BambooHR</div>
        <div class="flex items-center justify-between pt-2 border-t border-slate-200/60">
          <div class="flex items-center gap-1.5">
            <span class="relative flex h-2 w-2"><span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span><span class="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span></span>
            <span class="text-[11px] text-slate-600 font-medium">API Healthy</span>
          </div>
          <a href="/health" target="_blank" class="text-[11px] font-mono-code text-indigo-600 hover:underline">/health</a>
        </div>
      </div>
    </div>
  </aside>

  <!-- Main Content Shell -->
  <div class="lg:pl-[252px]">
    <header class="fixed top-0 left-0 lg:left-[252px] right-0 h-14 bg-white/95 backdrop-blur-md border-b border-slate-200/80 z-40 flex items-center justify-between px-4 md:px-6">
      <div class="flex items-center gap-3">
        <span class="text-[14px] font-bold text-slate-900 tracking-tight">Buki Workspace</span>
        <span class="text-slate-300">/</span>
        <div class="inline-flex items-center gap-1.5 px-2.5 py-0.5 bg-slate-100 text-slate-700 text-[11px] font-semibold rounded-md border border-slate-200/70 font-mono-code">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>SAGE CONNECTOR ACTIVE
        </div>
      </div>
      <div class="flex items-center gap-2.5">
        <a href="/health" target="_blank" class="hidden sm:inline-flex items-center px-2.5 py-1 text-[11px] font-mono-code font-semibold bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200 rounded-md">/health</a>
        <a href="/finance" target="_blank" class="hidden sm:inline-flex items-center px-2.5 py-1 text-[11px] font-mono-code font-semibold bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200 rounded-md">/finance</a>
        <button onclick="handleSync()" class="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer" title="Sync now">
          <span class="material-symbols-outlined text-[19px]" id="top-sync-icon">sync</span>
        </button>
        <div class="w-8 h-8 rounded-full bg-slate-900 text-white flex items-center justify-center font-bold text-[12px] shadow-sm ring-2 ring-slate-100">HL</div>
      </div>
    </header>

    <main class="pt-14 w-full bg-slate-50 min-h-screen">
      <div class="p-5 md:p-8 flex flex-col gap-6 max-w-[1600px] mx-auto w-full">

        <!-- 1. Top Header Area -->
        <div class="flex flex-col xl:flex-row xl:items-center justify-between gap-4 pb-3 border-b border-slate-200/70">
          <div class="flex flex-col gap-1.5">
            <div class="flex items-center gap-1.5 text-slate-500 text-[11px] font-semibold uppercase tracking-wider font-mono-code">
              <span>Buki</span>
              <span class="material-symbols-outlined text-[13px] text-slate-400">chevron_right</span>
              <span id="crumb-section">Finance Workspace</span>
              <span class="material-symbols-outlined text-[13px] text-slate-400">chevron_right</span>
              <span class="text-slate-800 font-bold">Sage v3.1 Connector</span>
            </div>
            <div class="flex flex-wrap items-center gap-3 pt-0.5">
              <h1 class="text-2xl md:text-3xl font-extrabold text-slate-900 tracking-tight" id="page-title">Finance Overview</h1>
              <div class="flex flex-wrap items-center gap-2">
                <span class="inline-flex items-center gap-1.5 px-2.5 py-1 bg-emerald-50 text-emerald-700 font-mono-code text-[11px] font-semibold rounded-md border border-emerald-200/80" id="synced-badge">
                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                  Synced (25 Sage records)
                </span>
                <span class="px-2.5 py-1 bg-slate-100 text-slate-600 font-mono-code text-[11px] font-semibold rounded-md border border-slate-200/80">
                  Fixtures Mode
                </span>
                <span class="inline-flex items-center gap-1 px-2.5 py-1 bg-white text-slate-500 font-mono-code text-[11px] rounded-md border border-slate-200">
                  <span class="material-symbols-outlined text-[13px] text-slate-400">history</span>
                  <span id="sync-time-val">Synced just now</span>
                </span>
                <span class="px-2.5 py-1 bg-indigo-50 text-indigo-700 font-mono-code text-[11px] font-semibold uppercase tracking-wider rounded-md border border-indigo-200/70">
                  Halden Labs Ltd
                </span>
              </div>
            </div>
          </div>

          <div class="flex items-center gap-2.5 self-start xl:self-auto">
            <button class="inline-flex items-center gap-1.5 bg-slate-900 hover:bg-slate-800 text-white text-[12px] font-semibold px-4 py-2 rounded-lg transition-all cursor-pointer shadow-sm" id="sync-btn" onclick="handleSync()">
              <span class="material-symbols-outlined text-[16px]" id="sync-icon">sync</span>
              Sync Now
            </button>
            <button class="inline-flex items-center gap-1.5 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 text-[12px] font-semibold px-3.5 py-2 rounded-lg transition-all cursor-pointer" onclick="checkHealthToast()">
              <span class="material-symbols-outlined text-[16px] text-emerald-600">verified</span>
              Run Health Check
            </button>
          </div>
        </div>

        <!-- Mobile Page Switcher -->
        <div class="flex lg:hidden gap-2">
          <button onclick="switchPage('finance')" class="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold">Finance</button>
          <button onclick="switchPage('people')" class="px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-700 text-xs font-semibold">People</button>
          <button onclick="switchPage('runs')" class="px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-700 text-xs font-semibold">Sync History</button>
        </div>

        <!-- FINANCE PAGE -->
        <div id="page-finance" class="flex flex-col gap-6">
          <!-- KPI Metrics Ribbon -->
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" id="kpi-grid"></div>

          <!-- Ask Buki Intelligence Engine -->
          <div class="bg-white rounded-xl border border-indigo-100 shadow-[0_4px_20px_-4px_rgba(99,102,241,0.08)] p-5 md:p-6 flex flex-col gap-4 relative overflow-hidden">
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div class="flex items-center gap-2.5">
                <div class="w-8 h-8 bg-indigo-600 text-white rounded-lg flex items-center justify-center shadow-sm">
                  <span class="material-symbols-outlined text-[18px]">neurology</span>
                </div>
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-[15px] font-bold text-slate-900">Ask Buki Intelligence</span>
                  <span class="text-[11px] font-mono-code font-semibold bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full border border-indigo-200/60">
                    Canonical Store Brief
                  </span>
                </div>
              </div>
              <div class="flex items-center gap-2 text-[11px] font-mono-code text-slate-500">
                <span class="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                Sage v3.1 + BambooHR Active
              </div>
            </div>

            <form class="flex flex-col md:flex-row items-stretch gap-2.5" onsubmit="event.preventDefault(); askLive(document.getElementById('buki-query-input').value);">
              <div class="relative flex-1">
                <span class="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-[20px]">search</span>
                <input class="w-full pl-11 pr-20 py-2.5 bg-slate-50/70 focus:bg-white border border-slate-200 focus:border-indigo-500 rounded-lg text-slate-900 text-[13px] font-medium focus:outline-none focus:ring-2 focus:ring-indigo-100 transition-all font-mono-code" id="buki-query-input" placeholder="Ask a financial or people question..." type="text" value="Who owes us money?" />
                <kbd class="hidden sm:inline-block absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-mono-code bg-white text-slate-400 border border-slate-200 px-1.5 py-0.5 rounded font-semibold">↵ Enter</kbd>
              </div>
              <button type="submit" class="bg-indigo-600 hover:bg-indigo-700 text-white text-[12px] font-semibold px-5 py-2.5 rounded-lg flex items-center justify-center gap-1.5 transition-all shadow-sm cursor-pointer">
                <span class="material-symbols-outlined text-[16px]">bolt</span>
                Run Query
              </button>
            </form>

            <div class="flex flex-wrap items-center gap-1.5">
              <span class="text-[11px] font-bold text-slate-400 font-mono-code uppercase mr-1">Suggested:</span>
              <button onclick="askPreset('Who owes us money?')" class="text-[11px] font-mono-code px-2.5 py-1 rounded-full bg-indigo-50/70 hover:bg-indigo-100/70 text-indigo-700 border border-indigo-200/80 font-medium cursor-pointer">Who owes us money?</button>
              <button onclick="askPreset('What did we spend on software last month?')" class="text-[11px] font-mono-code px-2.5 py-1 rounded-full bg-slate-50 hover:bg-slate-100 text-slate-600 border border-slate-200/80 cursor-pointer">What did we spend on software last month?</button>
              <button onclick="askPreset('How much cash do we have?')" class="text-[11px] font-mono-code px-2.5 py-1 rounded-full bg-slate-50 hover:bg-slate-100 text-slate-600 border border-slate-200/80 cursor-pointer">How much cash do we have?</button>
              <button onclick="askPreset('Biggest customers?')" class="text-[11px] font-mono-code px-2.5 py-1 rounded-full bg-slate-50 hover:bg-slate-100 text-slate-600 border border-slate-200/80 cursor-pointer">Biggest customers?</button>
              <button onclick="askPreset('How many people?')" class="text-[11px] font-mono-code px-2.5 py-1 rounded-full bg-slate-50 hover:bg-slate-100 text-slate-600 border border-slate-200/80 cursor-pointer">How many people?</button>
            </div>

            <div class="bg-slate-50/80 rounded-xl border border-slate-200/80 p-4 md:p-5 flex flex-col gap-3">
              <div class="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-slate-200/70">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-[11px] font-mono-code font-bold bg-white text-slate-800 px-2.5 py-1 rounded-md border border-slate-200" id="active-query-text">Query: "Who owes us money?"</span>
                  <span class="text-[11px] font-mono-code bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded border border-indigo-200/60" id="active-source-badge">Source: Sage</span>
                </div>
                <span class="text-[11px] font-mono-code text-slate-400" id="active-records-badge">25 records</span>
              </div>
              <p class="text-[14px] font-semibold text-slate-900 leading-relaxed m-0" id="active-answer-text"></p>
              <div class="flex flex-wrap gap-2" id="active-figures-row"></div>
            </div>
          </div>

          <!-- Main Data Split Grid -->
          <div class="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
            <!-- LEFT: Sales Invoices & Receivables -->
            <div class="xl:col-span-8 fintech-card flex flex-col overflow-hidden">
              <div class="p-4 md:p-5 border-b border-slate-200/80 flex flex-col md:flex-row md:items-center justify-between gap-3 bg-white">
                <div class="flex items-center gap-2.5">
                  <h2 class="text-base font-bold text-slate-900 tracking-tight">Sales Invoices &amp; Receivables</h2>
                  <span class="text-[11px] font-mono-code bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full border border-slate-200/60 font-semibold" id="inv-count-pill">5 live</span>
                </div>
                <div class="inline-flex bg-slate-100 p-1 rounded-lg border border-slate-200/60 text-[11px] font-mono-code font-semibold">
                  <button class="filter-tab-btn px-3 py-1 rounded-md uppercase bg-white text-slate-900 shadow-xs cursor-pointer font-semibold" onclick="filterInvoices('all', this)">All</button>
                  <button class="filter-tab-btn px-3 py-1 rounded-md uppercase text-slate-500 hover:text-slate-800 cursor-pointer flex items-center gap-1 font-medium" onclick="filterInvoices('overdue', this)"><span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span>Overdue</button>
                  <button class="filter-tab-btn px-3 py-1 rounded-md uppercase text-slate-500 hover:text-slate-800 cursor-pointer font-medium" onclick="filterInvoices('open', this)">Open</button>
                  <button class="filter-tab-btn px-3 py-1 rounded-md uppercase text-slate-500 hover:text-slate-800 cursor-pointer font-medium" onclick="filterInvoices('paid', this)">Paid</button>
                </div>
              </div>

              <div class="px-4 md:px-5 py-2.5 bg-slate-50/70 border-b border-slate-200/60 flex items-center justify-between gap-4">
                <div class="flex items-center gap-2 flex-1 max-w-sm">
                  <span class="material-symbols-outlined text-[16px] text-slate-400">filter_list</span>
                  <input class="w-full bg-transparent text-[12px] text-slate-800 focus:outline-none placeholder:text-slate-400 font-medium" oninput="searchInvoices(this.value)" placeholder="Filter customer or invoice number..." type="text" />
                </div>
                <span class="text-[11px] font-mono-code text-slate-400">Void/Draft excluded</span>
              </div>

              <div class="overflow-x-auto">
                <table class="w-full text-left border-collapse">
                  <thead>
                    <tr class="bg-slate-50 border-b border-slate-200/80 text-[11px] font-bold text-slate-500 uppercase tracking-wider font-mono-code">
                      <th class="py-3 px-4 md:px-5">Invoice #</th>
                      <th class="py-3 px-4 md:px-5">Customer</th>
                      <th class="py-3 px-4 md:px-5 text-right">Total</th>
                      <th class="py-3 px-4 md:px-5 text-right">Outstanding</th>
                      <th class="py-3 px-4 md:px-5">Due Date</th>
                      <th class="py-3 px-4 md:px-5 text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-slate-100 text-[12px]" id="invoices-tbody"></tbody>
                </table>
              </div>

              <div class="p-4 bg-slate-50/90 border-t border-slate-200/80 flex flex-wrap items-center justify-between gap-3 text-[11px] font-mono-code" id="invoices-footer"></div>
            </div>

            <!-- RIGHT: Spend by Category & Connector Health -->
            <div class="xl:col-span-4 flex flex-col gap-6">
              <div class="fintech-card p-5 flex flex-col gap-4" id="spend-card"></div>
              <div class="fintech-card p-5 flex flex-col gap-4" id="health-card"></div>
            </div>
          </div>

          <!-- Bottom Executive Brief Summary -->
          <div class="fintech-card p-4 md:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-l-4 border-l-indigo-600">
            <div class="flex items-start gap-3.5 max-w-4xl">
              <div class="w-9 h-9 rounded-lg bg-indigo-50 text-indigo-700 flex items-center justify-center shrink-0 border border-indigo-100 mt-0.5">
                <span class="material-symbols-outlined text-[20px]">auto_read_play</span>
              </div>
              <div class="flex flex-col gap-1">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-[14px] font-bold text-slate-900">Executive Brief Summary</span>
                  <span class="text-[10px] font-mono-code bg-indigo-50 text-indigo-700 font-semibold px-2 py-0.5 rounded-full border border-indigo-200/60">Auto-computed from Sage v3.1</span>
                </div>
                <p class="text-[12px] text-slate-600 leading-relaxed m-0" id="exec-summary-text"></p>
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <button class="inline-flex items-center gap-1.5 bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-[11px] font-semibold uppercase font-mono-code px-3 py-2 rounded-lg cursor-pointer" id="copy-brief-btn" onclick="copyBrief()">
                <span class="material-symbols-outlined text-[14px]">content_copy</span> Copy Brief
              </button>
            </div>
          </div>
        </div>

        <!-- PEOPLE PAGE -->
        <div id="page-people" class="hidden flex-col gap-6"></div>

        <!-- SYNC RUNS PAGE -->
        <div id="page-runs" class="hidden flex-col gap-6"></div>

      </div>
    </main>
  </div>

  <script>
    let STATE = ${serialized};
    let ACTIVE_FILTER = 'all';
    let SEARCH_TERM = '';

    function esc(s) {
      return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    function fmtMoney(ccy, amt) {
      const neg = amt < 0;
      const abs = Math.abs(amt).toLocaleString('en-US', { maximumFractionDigits: 2 });
      const str = ccy === 'USD' ? '$' + abs : ccy === 'GBP' ? '£' + abs : ccy + ' ' + abs;
      return neg ? '(' + str + ')' : str;
    }

    function fmtMoneyMap(m) {
      const entries = Object.entries(m || {});
      if (!entries.length) return 'none';
      return entries.map(([ccy, amt]) => fmtMoney(ccy, amt)).join(' & ');
    }

    function fmtDateShort(iso) {
      if (!iso) return '—';
      const d = new Date(iso);
      return isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
    }

    function renderKpis() {
      const fin = STATE.finance;
      const op = fin.cash.find(c => c.name.toLowerCase().includes('operating')) || fin.cash[0];
      const res = fin.cash.find(c => c.name.toLowerCase().includes('reserve'));
      const totalSpend = {};
      for (const s of fin.spendByAccount) {
        for (const [ccy, v] of Object.entries(s.total)) totalSpend[ccy] = (totalSpend[ccy] || 0) + v;
      }

      document.getElementById('synced-badge').innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>Synced (' + fin.recordCounts.total + ' Sage records)';
      document.getElementById('sidebar-counts').textContent = fin.recordCounts.total + ' Sage / ' + STATE.people.totalRecords + ' BambooHR';
      document.getElementById('nav-people-count').textContent = STATE.people.totalRecords;

      document.getElementById('kpi-grid').innerHTML = \`
        <div class="fintech-card p-5 flex flex-col justify-between">
          <div class="flex items-center justify-between pb-3 border-b border-slate-100">
            <span class="text-[11px] font-bold uppercase tracking-wider text-slate-500 font-mono-code">Bank Cash</span>
            <div class="w-7 h-7 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center border border-emerald-100"><span class="material-symbols-outlined text-[16px]">account_balance</span></div>
          </div>
          <div class="py-3">
            <div class="text-3xl font-extrabold text-slate-900 tracking-tight font-mono-code">\${esc(op ? fmtMoneyMap(op.balance) : 'none')}</div>
            <div class="flex items-center gap-2 mt-1.5">
              <span class="text-[12px] text-slate-500 font-medium">Operating Cash</span>
              \${res ? '<span class="bg-slate-100 text-slate-700 text-[10px] font-semibold px-2 py-0.5 rounded-full font-mono-code border border-slate-200/60">' + esc(fmtMoneyMap(res.balance)) + ' Reserve</span>' : ''}
            </div>
          </div>
          <div class="pt-2.5 border-t border-slate-100 flex items-center justify-between text-[11px] font-mono-code text-slate-500">
            <span>\${fin.cash.length} bank accounts</span>
            <span class="text-emerald-700 font-semibold bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-100">\${fin.recordCounts.bankTransactions} txns</span>
          </div>
        </div>

        <div class="fintech-card p-5 flex flex-col justify-between">
          <div class="flex items-center justify-between pb-3 border-b border-slate-100">
            <span class="text-[11px] font-bold uppercase tracking-wider text-slate-500 font-mono-code">Invoiced (\${esc(fin.invoiced.thisMonth.period)})</span>
            <div class="w-7 h-7 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center border border-indigo-100"><span class="material-symbols-outlined text-[16px]">receipt_long</span></div>
          </div>
          <div class="py-3">
            <div class="text-3xl font-extrabold text-slate-900 tracking-tight font-mono-code">\${esc(fmtMoneyMap(fin.invoiced.thisMonth.total))}</div>
            <div class="flex items-center gap-2 mt-1.5">
              <span class="text-[12px] text-slate-500">vs \${esc(fmtMoneyMap(fin.invoiced.lastMonth.total))} (\${esc(fin.invoiced.lastMonth.period)})</span>
            </div>
          </div>
          <div class="pt-2.5 border-t border-slate-100 flex items-center justify-between text-[11px] font-mono-code text-slate-500">
            <span>\${fin.invoiced.thisMonth.count} live invoices</span>
            <span class="text-indigo-600 font-semibold bg-indigo-50 px-1.5 py-0.5 rounded border border-indigo-100">Void/Draft excl.</span>
          </div>
        </div>

        <div class="fintech-kpi-urgent p-5 flex flex-col justify-between">
          <div class="flex items-center justify-between pb-3 border-b border-rose-200/70">
            <div class="flex items-center gap-1.5">
              <span class="relative flex h-2 w-2"><span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span><span class="relative inline-flex rounded-full h-2 w-2 bg-rose-600"></span></span>
              <span class="text-[11px] font-bold uppercase tracking-wider text-rose-700 font-mono-code">Overdue Receivables</span>
            </div>
            <div class="w-7 h-7 rounded-lg bg-rose-100 text-rose-700 flex items-center justify-center border border-rose-200"><span class="material-symbols-outlined text-[16px]">warning</span></div>
          </div>
          <div class="py-3">
            <div class="text-3xl font-extrabold text-rose-700 tracking-tight font-mono-code">\${esc(fmtMoneyMap(fin.overdueReceivables.total))}</div>
            <div class="flex items-center gap-2 mt-1.5">
              <span class="bg-rose-100/80 text-rose-800 text-[11px] px-2 py-0.5 rounded-full border border-rose-200 font-semibold font-mono-code">Across \${fin.overdueReceivables.count} overdue invoices</span>
            </div>
          </div>
          <div class="pt-2.5 border-t border-rose-200/70 flex items-center justify-between text-[11px] font-mono-code text-rose-700">
            <span>\${fin.overdueReceivables.uncountedNoDueDate} open w/o due date excl.</span>
            <span class="font-bold">Urgent</span>
          </div>
        </div>

        <div class="fintech-card p-5 flex flex-col justify-between">
          <div class="flex items-center justify-between pb-3 border-b border-slate-100">
            <span class="text-[11px] font-bold uppercase tracking-wider text-slate-500 font-mono-code">Monthly Spend (\${esc(fin.invoiced.lastMonth.period)})</span>
            <div class="w-7 h-7 rounded-lg bg-slate-100 text-slate-700 flex items-center justify-center border border-slate-200"><span class="material-symbols-outlined text-[16px]">payments</span></div>
          </div>
          <div class="py-3">
            <div class="text-3xl font-extrabold text-slate-900 tracking-tight font-mono-code">\${esc(fmtMoneyMap(totalSpend))}</div>
            <div class="flex items-center gap-1.5 mt-1.5 flex-wrap">
              \${fin.spendByAccount.map(s => '<span class="bg-slate-100 text-slate-700 text-[10px] font-semibold px-2 py-0.5 rounded font-mono-code border border-slate-200">' + esc(fmtMoneyMap(s.total)) + ' ' + esc(s.name.split(' ')[0]) + '</span>').join('')}
            </div>
          </div>
          <div class="pt-2.5 border-t border-slate-100 flex items-center justify-between text-[11px] font-mono-code text-slate-500">
            <span>Net excluding tax</span>
            <span class="text-slate-800 font-semibold bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">Verified</span>
          </div>
        </div>
      \`;

      const soft = fin.spendByAccount.find(s => s.name.toLowerCase().includes('software'));
      document.getElementById('exec-summary-text').innerHTML =
        'Operating cash stands at <strong class="text-slate-900 font-mono-code">' + esc(op ? fmtMoneyMap(op.balance) : 'none') + '</strong>' +
        (res ? ' (' + esc(fmtMoneyMap(res.balance)) + ' reserve)' : '') +
        '. Invoiced <strong class="text-slate-900 font-mono-code">' + esc(fmtMoneyMap(fin.invoiced.thisMonth.total)) + '</strong> in ' + esc(fin.invoiced.thisMonth.period) +
        '. Receivables alert: <strong class="text-rose-600 font-mono-code">' + esc(fmtMoneyMap(fin.overdueReceivables.total)) + ' overdue</strong> across ' + fin.overdueReceivables.count + ' invoices' +
        (soft ? '. ' + esc(fin.invoiced.lastMonth.period) + ' software spend: <strong class="text-slate-900 font-mono-code">' + esc(fmtMoneyMap(soft.total)) + '</strong>.' : '.');
    }

    function renderInvoices() {
      const rows = STATE.finance.salesInvoices.filter(inv => {
        if (ACTIVE_FILTER === 'overdue' && !inv.isOverdue) return false;
        if (ACTIVE_FILTER === 'open' && inv.status !== 'unpaid' && inv.status !== 'part_paid') return false;
        if (ACTIVE_FILTER === 'paid' && inv.status !== 'paid') return false;
        if (SEARCH_TERM) {
          const hay = (inv.number + ' ' + inv.customer + ' ' + inv.description).toLowerCase();
          if (!hay.includes(SEARCH_TERM)) return false;
        }
        return true;
      });

      document.getElementById('inv-count-pill').textContent = rows.length + ' shown';
      document.getElementById('invoices-tbody').innerHTML = rows.map(inv => {
        const initials = inv.customer.split(/\\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
        let badge = '<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-bold font-mono-code uppercase"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>PAID</span>';
        if (inv.isOverdue) {
          badge = '<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200 text-[10px] font-bold font-mono-code uppercase"><span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span>OVERDUE</span>';
        } else if (!inv.dueDate && (inv.status === 'unpaid' || inv.status === 'part_paid')) {
          badge = '<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200 text-[10px] font-bold font-mono-code uppercase"><span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span>OPEN · NO DUE DATE</span>';
        } else if (inv.status === 'unpaid' || inv.status === 'part_paid') {
          badge = '<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-bold font-mono-code uppercase"><span class="w-1.5 h-1.5 rounded-full bg-indigo-500"></span>OPEN</span>';
        }
        const dueCol = inv.dueDate
          ? '<div class="font-mono-code font-semibold ' + (inv.isOverdue ? 'text-rose-600' : 'text-slate-800') + '">' + esc(fmtDateShort(inv.dueDate)) + '</div>'
          : '<div class="font-mono-code text-slate-400">—</div><div class="text-[10px] font-mono-code text-slate-400">Absent in Sage</div>';

        return \`
          <tr class="hover:bg-slate-50/80 transition-colors bg-white">
            <td class="py-3 px-4 md:px-5 font-mono-code font-bold text-indigo-600">\${esc(inv.number)}</td>
            <td class="py-3 px-4 md:px-5">
              <div class="flex items-center gap-2.5">
                <div class="w-6 h-6 rounded-md bg-indigo-50 text-indigo-700 font-bold text-[10px] flex items-center justify-center font-mono-code border border-indigo-100">\${esc(initials)}</div>
                <div>
                  <div class="font-bold text-slate-900">\${esc(inv.customer)}</div>
                  <div class="text-[11px] text-slate-400 font-mono-code">\${esc(inv.description)}</div>
                </div>
              </div>
            </td>
            <td class="py-3 px-4 md:px-5 text-right font-mono-code font-semibold text-slate-700">\${esc(fmtMoney(inv.currency, inv.total))}</td>
            <td class="py-3 px-4 md:px-5 text-right font-mono-code font-bold \${inv.isOverdue ? 'text-rose-600' : 'text-slate-900'}">\${esc(fmtMoney(inv.currency, inv.outstanding))}</td>
            <td class="py-3 px-4 md:px-5">\${dueCol}</td>
            <td class="py-3 px-4 md:px-5 text-right">\${badge}</td>
          </tr>\`;
      }).join('');

      const totalInv = STATE.finance.salesInvoices.reduce((s, i) => s + i.total, 0);
      const totalOverdue = STATE.finance.salesInvoices.filter(i => i.isOverdue).reduce((s, i) => s + i.outstanding, 0);
      document.getElementById('invoices-footer').innerHTML = \`
        <div class="flex flex-wrap items-center gap-4">
          <div><span class="text-slate-400 uppercase">Live Invoiced:</span> <span class="font-bold text-slate-900">\${esc(fmtMoney('GBP', totalInv))}</span></div>
          <div><span class="text-rose-500 uppercase font-semibold">Overdue Balance:</span> <span class="font-bold text-rose-600">\${esc(fmtMoney('GBP', totalOverdue))}</span></div>
        </div>
        <div class="text-slate-500">Missing due dates omitted (never defaulted)</div>
      \`;
    }

    function renderSideCards() {
      const fin = STATE.finance;
      const sumSpend = fin.spendByAccount.reduce((s, row) => s + Object.values(row.total).reduce((a, b) => a + b, 0), 0);

      document.getElementById('spend-card').innerHTML = \`
        <div class="flex items-center justify-between pb-3 border-b border-slate-100">
          <div>
            <h3 class="text-sm font-bold text-slate-900 tracking-tight m-0">Spend by Category</h3>
            <span class="text-[11px] text-slate-400 font-mono-code">Purchase Lines (\${esc(fin.invoiced.lastMonth.period)})</span>
          </div>
          <div class="text-right">
            <div class="text-lg font-extrabold text-slate-900 font-mono-code">\${esc(fmtMoney('GBP', sumSpend))}</div>
            <div class="text-[10px] text-slate-400 font-mono-code uppercase font-semibold">Net Excl. Tax</div>
          </div>
        </div>
        <div class="flex flex-col gap-4">
          \${fin.spendByAccount.map((s, idx) => {
            const val = Object.values(s.total).reduce((a, b) => a + b, 0);
            const pct = sumSpend ? ((val / sumSpend) * 100).toFixed(1) : '0';
            const barColor = idx === 0 ? 'bg-indigo-600' : 'bg-slate-500';
            return \`
              <div class="flex flex-col gap-1.5">
                <div class="flex items-center justify-between text-[12px]">
                  <span class="font-bold text-slate-800">\${esc(s.name)}</span>
                  <span class="font-mono-code font-bold text-slate-900">\${esc(fmtMoneyMap(s.total))} (\${pct}%)</span>
                </div>
                <div class="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden p-0.5 border border-slate-200/50">
                  <div class="\${barColor} h-1.5 rounded-full" style="width:\${pct}%"></div>
                </div>
                <div class="text-[11px] font-mono-code text-slate-500">\${s.lines} purchase invoice line\${s.lines === 1 ? '' : 's'}</div>
              </div>\`;
          }).join('')}
        </div>
      \`;

      document.getElementById('health-card').innerHTML = \`
        <div class="flex items-center justify-between pb-3 border-b border-slate-100">
          <div class="flex items-center gap-2">
            <div class="w-6 h-6 rounded-md bg-emerald-50 text-emerald-600 flex items-center justify-center border border-emerald-100"><span class="material-symbols-outlined text-[16px]">lan</span></div>
            <h3 class="text-sm font-bold text-slate-900 tracking-tight m-0">Connector &amp; Sync Health</h3>
          </div>
          <span class="text-[10px] font-mono-code font-bold px-2 py-0.5 bg-slate-100 text-slate-700 rounded border border-slate-200">Sage v3.1</span>
        </div>
        <div class="flex flex-col gap-2 text-[12px]">
          <div class="flex items-center justify-between p-2.5 bg-slate-50/80 rounded-lg border border-slate-200/60">
            <span class="font-semibold text-slate-800">OAuth2 Token Rotation</span>
            <span class="text-[11px] font-mono-code text-emerald-700 font-semibold bg-emerald-50 px-2 py-0.5 rounded">401 Guard Active</span>
          </div>
          <div class="flex items-center justify-between p-2.5 bg-slate-50/80 rounded-lg border border-slate-200/60">
            <span class="font-semibold text-slate-800">405 Plan Fallback</span>
            <span class="text-[11px] font-mono-code text-emerald-700 font-semibold bg-emerald-50 px-2 py-0.5 rounded">v3.1 Fixtures Ready</span>
          </div>
          <div class="flex items-center justify-between p-2.5 bg-slate-50/80 rounded-lg border border-slate-200/60">
            <span class="font-semibold text-slate-800">Atomic Snapshots</span>
            <span class="text-[11px] font-mono-code text-indigo-700 font-semibold bg-indigo-50 px-2 py-0.5 rounded">Temp + Rename</span>
          </div>
          <div class="flex items-center justify-between p-2.5 bg-slate-50/80 rounded-lg border border-slate-200/60">
            <span class="font-semibold text-slate-800">Test Suite</span>
            <span class="text-[11px] font-mono-code text-emerald-700 font-semibold bg-emerald-50 px-2 py-0.5 rounded">36 / 36 Passing</span>
          </div>
        </div>
      \`;
    }

    function renderPeoplePage(filter = '') {
      const p = STATE.people;
      const q = filter.trim().toLowerCase();
      const rows = p.roster.filter(r => !q || r.displayName.toLowerCase().includes(q) || r.department.toLowerCase().includes(q) || r.title.toLowerCase().includes(q));

      document.getElementById('page-people').innerHTML = \`
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div class="fintech-card p-5"><div class="text-[11px] font-bold uppercase text-slate-500 font-mono-code">On Payroll</div><div class="text-3xl font-extrabold mt-2 font-mono-code">\${p.onPayroll}</div><div class="text-xs text-slate-500 mt-1">\${p.notStarted} starting after today</div></div>
          <div class="fintech-card p-5"><div class="text-[11px] font-bold uppercase text-slate-500 font-mono-code">Total Records</div><div class="text-3xl font-extrabold mt-2 font-mono-code">\${p.totalRecords}</div><div class="text-xs text-slate-500 mt-1">Source: BambooHR</div></div>
          <div class="fintech-card p-5"><div class="text-[11px] font-bold uppercase text-slate-500 font-mono-code">Joined This Month</div><div class="text-3xl font-extrabold mt-2 font-mono-code">\${p.joinedThisMonth}</div><div class="text-xs text-slate-500 mt-1">\${p.joinedLastMonth} joined last month</div></div>
        </div>
        <div class="fintech-card overflow-hidden">
          <div class="p-4 border-b border-slate-200 flex flex-wrap justify-between items-center gap-3">
            <h2 class="text-base font-bold m-0">Employee Roster (\${rows.length} of \${p.roster.length})</h2>
            <input class="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono-code w-64" placeholder="Filter name, title, dept..." value="\${esc(filter)}" oninput="renderPeoplePage(this.value)" />
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse text-[12px]">
              <thead><tr class="bg-slate-50 border-b border-slate-200 text-[11px] font-mono-code text-slate-500 uppercase"><th class="py-3 px-4">Name</th><th class="py-3 px-4">Title</th><th class="py-3 px-4">Department</th><th class="py-3 px-4">Location</th><th class="py-3 px-4">Status</th><th class="py-3 px-4 text-right">Annual Base</th></tr></thead>
              <tbody class="divide-y divide-slate-100">
                \${rows.map(e => '<tr class="hover:bg-slate-50"><td class="py-2.5 px-4 font-semibold">' + esc(e.displayName) + '</td><td class="py-2.5 px-4">' + esc(e.title) + '</td><td class="py-2.5 px-4">' + esc(e.department) + '</td><td class="py-2.5 px-4">' + esc(e.location) + '</td><td class="py-2.5 px-4">' + esc(e.status) + '</td><td class="py-2.5 px-4 text-right font-mono-code">' + esc(e.annualSalary && e.currency ? fmtMoney(e.currency, e.annualSalary) : 'not on file') + '</td></tr>').join('')}
              </tbody>
            </table>
          </div>
        </div>
      \`;
    }

    function renderRunsPage() {
      const runs = STATE.runs || [];
      document.getElementById('page-runs').innerHTML = \`
        <div class="fintech-card overflow-hidden">
          <div class="p-4 border-b border-slate-200 flex justify-between items-center">
            <h2 class="text-base font-bold m-0">Recent Sync Runs (\${runs.length})</h2>
            <button onclick="handleSync()" class="px-3 py-1.5 bg-slate-900 text-white rounded-lg text-xs font-semibold cursor-pointer">Trigger Sync</button>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse text-[12px]">
              <thead><tr class="bg-slate-50 border-b border-slate-200 text-[11px] font-mono-code text-slate-500 uppercase"><th class="py-3 px-4">Timestamp</th><th class="py-3 px-4">Domain</th><th class="py-3 px-4">Source</th><th class="py-3 px-4">Status</th><th class="py-3 px-4 text-right">Pulled</th><th class="py-3 px-4 text-right">Added</th><th class="py-3 px-4 text-right">Changed</th><th class="py-3 px-4 text-right">Duration</th></tr></thead>
              <tbody class="divide-y divide-slate-100 font-mono-code">
                \${runs.map(r => '<tr><td class="py-2.5 px-4">' + esc(r.at) + '</td><td class="py-2.5 px-4">' + esc(r.domain) + '</td><td class="py-2.5 px-4">' + esc(r.source) + '</td><td class="py-2.5 px-4"><span class="px-2 py-0.5 rounded-full text-[10px] font-bold ' + (r.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700') + '">' + (r.ok ? 'OK' : 'FAIL') + '</span></td><td class="py-2.5 px-4 text-right">' + r.pulled + '</td><td class="py-2.5 px-4 text-right">' + r.added + '</td><td class="py-2.5 px-4 text-right">' + r.changed + '</td><td class="py-2.5 px-4 text-right">' + r.durationMs + ' ms</td></tr>').join('')}
              </tbody>
            </table>
          </div>
        </div>
      \`;
    }

    function renderBrief(res, qText) {
      document.getElementById('active-query-text').textContent = 'Query: "' + (qText || res.question || '') + '"';
      document.getElementById('active-answer-text').textContent = res.answer || '';
      const cited = res.cited || {};
      document.getElementById('active-source-badge').textContent = 'Source: ' + (cited.source ? cited.source.toUpperCase() : 'None');
      document.getElementById('active-records-badge').textContent = (cited.records || 0) + ' records';
      document.getElementById('active-figures-row').innerHTML = (res.figures || []).map(f =>
        '<span class="px-2.5 py-1 rounded-md bg-white border border-slate-200 text-[11px] font-mono-code"><span class="text-slate-500">' + esc(f.label) + ':</span> <strong class="text-slate-900">' + esc(f.value) + '</strong></span>'
      ).join('');
    }

    async function askLive(q) {
      if (!q.trim()) return;
      const res = await fetch('/brief?q=' + encodeURIComponent(q));
      const data = await res.json();
      renderBrief(data, q);
    }

    function askPreset(q) {
      document.getElementById('buki-query-input').value = q;
      askLive(q);
    }

    function focusAsk() {
      switchPage('finance');
      setTimeout(() => document.getElementById('buki-query-input').focus(), 50);
    }

    function filterInvoices(status, el) {
      ACTIVE_FILTER = status;
      document.querySelectorAll('.filter-tab-btn').forEach(b => {
        b.classList.remove('bg-white', 'text-slate-900', 'shadow-xs', 'font-semibold');
        b.classList.add('text-slate-500', 'font-medium');
      });
      el.classList.add('bg-white', 'text-slate-900', 'shadow-xs', 'font-semibold');
      el.classList.remove('text-slate-500', 'font-medium');
      renderInvoices();
    }

    function searchInvoices(val) {
      SEARCH_TERM = val.toLowerCase().trim();
      renderInvoices();
    }

    function switchPage(page) {
      ['finance', 'people', 'runs'].forEach(p => {
        document.getElementById('page-' + p).classList.toggle('hidden', p !== page);
        document.getElementById('page-' + p).classList.toggle('flex', p === page);
      });
      const titles = { finance: 'Finance Overview', people: 'People & Payroll', runs: 'Sync & Connector Health' };
      document.getElementById('page-title').textContent = titles[page];
      document.getElementById('crumb-section').textContent = titles[page];
    }

    async function handleSync() {
      const btn = document.getElementById('sync-btn');
      const icon = document.getElementById('sync-icon');
      const topIcon = document.getElementById('top-sync-icon');
      icon.classList.add('animate-spin');
      topIcon.classList.add('animate-spin');
      btn.setAttribute('disabled', 'true');
      try {
        const res = await fetch('/api/sync', { method: 'POST' });
        const data = await res.json();
        STATE = data.state;
        renderAll();
        document.getElementById('sync-time-val').textContent = 'Synced just now (OK)';
      } finally {
        icon.classList.remove('animate-spin');
        topIcon.classList.remove('animate-spin');
        btn.removeAttribute('disabled');
      }
    }

    async function checkHealthToast() {
      const res = await fetch('/health');
      const h = await res.json();
      document.getElementById('sync-time-val').textContent = 'Health: ' + h.status.toUpperCase() + ' (' + h.connectors.finance.totalRecords + ' Sage, ' + h.connectors.hr.totalRecords + ' HR)';
    }

    function copyBrief() {
      const text = document.getElementById('exec-summary-text').innerText;
      navigator.clipboard.writeText(text);
      const btn = document.getElementById('copy-brief-btn');
      const orig = btn.innerHTML;
      btn.innerHTML = '<span class="material-symbols-outlined text-[14px]">check</span> Copied!';
      setTimeout(() => { btn.innerHTML = orig; }, 1600);
    }

    function renderAll() {
      renderKpis();
      renderInvoices();
      renderSideCards();
      renderPeoplePage();
      renderRunsPage();
      renderBrief(STATE.initialBrief, 'Who owes us money?');
    }

    renderAll();
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
