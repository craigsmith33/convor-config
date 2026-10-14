// Convor addition (1.6): answer-ready finance tools.
//
// Each tool gathers the QuickBooks data a common question needs and does the
// sorting, ranking, aging and arithmetic in code (exact cents), so the
// assistant only has to present the result. This is faster (one call instead
// of several, and much less to read) and safer (no ranking or adding done by
// the model). All tools are read-only.
import { z } from "zod";
import { getQuickbooksBalanceSheet } from "./handlers/get-quickbooks-balance-sheet.handler.js";
import { getQuickbooksProfitAndLoss } from "./handlers/get-quickbooks-profit-and-loss.handler.js";
import { getQuickbooksAgedReceivables } from "./handlers/get-quickbooks-aged-receivables.handler.js";
import { getQuickbooksAgedPayables } from "./handlers/get-quickbooks-aged-payables.handler.js";
import { getQuickbooksCustomerSales } from "./handlers/get-quickbooks-customer-sales.handler.js";
import { getQuickbooksVendorExpenses } from "./handlers/get-quickbooks-vendor-expenses.handler.js";
import { searchQuickbooksInvoices } from "./handlers/search-quickbooks-invoices.handler.js";
import { searchQuickbooksBills } from "./handlers/search-quickbooks-bills.handler.js";
import { readQuickbooksInvoice } from "./handlers/read-quickbooks-invoice.handler.js";
import { flattenReport } from "./convor-reports.js";

// ---------------------------------------------------------------- exact money

export function toCents(v: unknown): bigint {
  if (v === undefined || v === null || v === "") return 0n;
  const s = (typeof v === "number" ? String(v) : String(v)).replace(/[$,\s]/g, "");
  const m = /^(-?)(\d*)(?:\.(\d+))?$/.exec(s);
  if (!m || (m[2] === "" && !m[3])) throw new Error("not an amount: " + String(v).slice(0, 40));
  const frac = (m[3] || "").padEnd(3, "0");
  let cents = BigInt(m[2] || "0") * 100n + BigInt(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1n;
  return m[1] === "-" ? -cents : cents;
}

export function money(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  const s = (a / 100n).toString() + "." + (a % 100n).toString().padStart(2, "0");
  return neg ? "-" + s : s;
}

/** num / den * 100, rounded half away from zero to 2 decimals; null when den is 0. */
export function pct(num: bigint, den: bigint): string | null {
  if (den === 0n) return null;
  const neg = (num < 0n) !== (den < 0n) && num !== 0n;
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  const q = (n * 10000n * 2n + d) / (2n * d); // percent * 100
  const s = (q / 100n).toString() + "." + (q % 100n).toString().padStart(2, "0");
  return neg ? "-" + s : s;
}

/** num / den rounded to 2 decimals (for ratios such as the current ratio). */
function ratio(num: bigint, den: bigint): string | null {
  if (den === 0n) return null;
  const neg = (num < 0n) !== (den < 0n) && num !== 0n;
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  const q = (n * 100n * 2n + d) / (2n * d);
  const s = (q / 100n).toString() + "." + (q % 100n).toString().padStart(2, "0");
  return neg ? "-" + s : s;
}

// ---------------------------------------------------------------- dates

const TZ = process.env.CONVOR_TIMEZONE || "America/New_York";
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function todayISO(): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

function addDays(iso: string, n: number): string {
  return new Date((dayNumber(iso) + n) * 86400000).toISOString().slice(0, 10);
}

function checkDate(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const s = String(v).trim();
  if (!ISO.test(s) || isNaN(dayNumber(s))) throw new Error(`${name} must be a date written YYYY-MM-DD`);
  return s;
}

/** The same calendar dates one year earlier (Feb 29 becomes Feb 28). */
function yearEarlier(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dd = m === 2 && d === 29 ? 28 : d;
  return `${y - 1}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

function humanDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${d}, ${y}`;
}

// ---------------------------------------------------------------- QuickBooks access

async function report(fn: (o: any) => Promise<any>, opts: any, what: string): Promise<any> {
  const r = await fn(opts);
  if (r.isError) throw new Error(`${what}: ${r.error}`);
  const flat = flattenReport(r.result);
  if (!flat) throw new Error(`${what}: unexpected report format`);
  return flat;
}

type Row = { kind: string; group?: string; label: string; values: Record<string, string> };

function rowsOf(flat: any): Row[] {
  return (flat.rows || []).map((r: any) => ({ kind: r.kind, group: r.group || "", label: r.label || "", values: r.values || {} }));
}

/** The single row with this label (and group, if given); throws if missing or ambiguous. */
function one(rows: Row[], label: string, group?: string): Row {
  const hits = rows.filter((r) => r.label === label && (group === undefined || r.group === group));
  if (hits.length !== 1) throw new Error(`expected one '${label}' row${group !== undefined ? ` in '${group}'` : ""}, found ${hits.length}`);
  return hits[0];
}

function maybe(rows: Row[], label: string, group?: string): Row | null {
  const hits = rows.filter((r) => r.label === label && (group === undefined || r.group === group));
  return hits.length === 1 ? hits[0] : null;
}

function col(row: Row | null, title = "Total"): bigint {
  return row ? toCents(row.values[title]) : 0n;
}

async function allRecords(fn: (c: any) => Promise<any>, criteria: any[], what: string): Promise<any[]> {
  const r = await fn([...criteria, { field: "fetchAll", value: true }]);
  if (r.isError) throw new Error(`${what}: ${r.error}`);
  if (!Array.isArray(r.result)) throw new Error(`${what}: unexpected result`);
  return r.result;
}

const AGE_COLS = ["Current", "1 - 30", "31 - 60", "61 - 90", "91 and over"] as const;
function bucketFor(daysPast: number): (typeof AGE_COLS)[number] {
  if (daysPast <= 0) return "Current";
  if (daysPast <= 30) return "1 - 30";
  if (daysPast <= 60) return "31 - 60";
  if (daysPast <= 90) return "61 - 90";
  return "91 and over";
}

function agingTotals(report: any): Record<string, string> {
  const rows = rowsOf(report);
  const total = one(rows, "TOTAL");
  const out: Record<string, string> = {};
  for (const c of [...AGE_COLS, "Total"]) out[c] = money(toCents(total.values[c]));
  return out;
}

function text(obj: any) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj) }] };
}

function fail(e: any) {
  return { isError: true, content: [{ type: "text" as const, text: "Error: " + (e?.message || String(e)) }] };
}

// ---------------------------------------------------------------- finance snapshot

const snapshotSchema = z.object({
  as_of: z.string().optional().describe("Date to report as of (YYYY-MM-DD). Leave empty for today."),
});

async function financeSnapshot(params: any) {
  const asOf = checkDate(params?.as_of, "as_of") || todayISO();
  const year = asOf.slice(0, 4);
  const ytdStart = `${year}-01-01`;
  const [bs, ar, ap, pl, plPrior] = await Promise.all([
    report(getQuickbooksBalanceSheet, { end_date: asOf, accounting_method: "Accrual", summarize_column_by: "Total" }, "balance sheet"),
    report(getQuickbooksAgedReceivables, { report_date: asOf, aging_method: "Report_Date", days_per_aging_period: 30, num_periods: 4 }, "receivables aging"),
    report(getQuickbooksAgedPayables, { report_date: asOf, aging_method: "Report_Date", days_per_aging_period: 30, num_periods: 4 }, "payables aging"),
    report(getQuickbooksProfitAndLoss, { start_date: ytdStart, end_date: asOf, accounting_method: "Accrual", summarize_column_by: "Total" }, "profit and loss"),
    report(getQuickbooksProfitAndLoss, { start_date: yearEarlier(ytdStart), end_date: yearEarlier(asOf), accounting_method: "Accrual", summarize_column_by: "Total" }, "profit and loss, prior year"),
  ]);
  const b = rowsOf(bs);
  const bankLines = b.filter((r) => r.kind === "line" && /(^|> )Bank Accounts$/.test(r.group || ""));
  const cash = col(maybe(b, "Total Bank Accounts"));
  const arTotal = col(maybe(b, "Total Accounts Receivable"));
  const apTotal = col(maybe(b, "Total Accounts Payable"));
  const curA = col(one(b, "Total Current Assets"));
  const curL = col(maybe(b, "Total Current Liabilities"));
  const totL = col(one(b, "Total Liabilities"));
  const liabilityLines = b
    .filter((r) => r.kind === "line" && (r.group || "").includes("Liabilities") && toCents(r.values.Total) !== 0n)
    .map((r) => ({ account: r.label, section: (r.group || "").split(" > ").slice(-1)[0], balance: money(toCents(r.values.Total)) }));
  const borrowing = b
    .filter((r) => r.kind === "line" && (r.group || "").includes("Liabilities") && /loan|line of credit|note payable|mortgage/i.test(r.label))
    .reduce((s, r) => s + toCents(r.values.Total), 0n);

  const arAge = agingTotals(ar);
  const apAge = agingTotals(ap);
  const arOver60 = toCents(arAge["61 - 90"]) + toCents(arAge["91 and over"]);
  const arPastDue = toCents(arAge.Total) - toCents(arAge.Current);
  const apPastDue = toCents(apAge.Total) - toCents(apAge.Current);

  const p = rowsOf(pl), pp = rowsOf(plPrior);
  const line = (rows: Row[], label: string, group?: string) => col(maybe(rows, label, group));
  const inc = line(p, "Total Income"), incP = line(pp, "Total Income");
  const gp = line(p, "Gross Profit"), gpP = line(pp, "Gross Profit");
  const ni = line(p, "Net Income"), niP = line(pp, "Net Income");

  return text({
    asOf,
    basis: "Accrual",
    cash: { totalInBank: money(cash), accounts: bankLines.map((r) => ({ account: r.label, balance: money(toCents(r.values.Total)) })) },
    receivables: {
      total: money(toCents(arAge.Total)),
      aging: arAge,
      pastDue: money(arPastDue),
      moreThan60DaysPastDue: money(arOver60),
      moreThan60DaysPastDuePercentOfTotal: pct(arOver60, toCents(arAge.Total)),
    },
    payables: { total: money(toCents(apAge.Total)), aging: apAge, pastDue: money(apPastDue) },
    balanceSheet: {
      totalCurrentAssets: money(curA),
      totalCurrentLiabilities: money(curL),
      currentRatio: ratio(curA, curL),
      totalLiabilities: money(totL),
      borrowing: money(borrowing),
      liabilities: liabilityLines,
      accountsReceivableOnBalanceSheet: money(arTotal),
      accountsPayableOnBalanceSheet: money(apTotal),
    },
    cashMinusOpenBills: money(cash - toCents(apAge.Total)),
    yearToDate: {
      period: `${humanDate(ytdStart)} to ${humanDate(asOf)}`,
      income: money(inc), grossProfit: money(gp), netIncome: money(ni),
      grossMarginPercent: pct(gp, inc), netMarginPercent: pct(ni, inc),
    },
    samePeriodLastYear: {
      period: `${humanDate(yearEarlier(ytdStart))} to ${humanDate(yearEarlier(asOf))}`,
      income: money(incP), grossProfit: money(gpP), netIncome: money(niP),
      incomeChange: money(inc - incP), incomeChangePercent: pct(inc - incP, incP),
      netIncomeChange: money(ni - niP), netIncomeChangePercent: pct(ni - niP, niP),
    },
    note: "All figures come from QuickBooks reports and are computed exactly by the connector; use them as given. " +
      "Aging is by due date as of asOf. borrowing is the loan and line-of-credit balances.",
  });
}

export const GetFinanceSnapshotTool = {
  name: "get_finance_snapshot",
  description:
    "One-call finance overview: cash in each bank account, receivables and payables with aging and past-due amounts, " +
    "current ratio, liabilities and borrowing, cash minus open bills, and year-to-date income, gross profit and net income " +
    "compared with the same period last year. Use it for a snapshot, cash, debt, short-term obligations or how the year is going. " +
    "Every figure is computed exactly from QuickBooks.",
  schema: snapshotSchema,
  handler: async ({ params }: any) => { try { return await financeSnapshot(params); } catch (e) { return fail(e); } },
};

// ---------------------------------------------------------------- receivables

const arSchema = z.object({
  as_of: z.string().optional().describe("Date to age invoices to (YYYY-MM-DD). Leave empty for today."),
  customer_id: z.string().optional().describe("Only this customer (QuickBooks customer Id from search_customer_or_vendor)"),
  top: z.number().int().min(1).max(50).optional().describe("How many customers to list (default 10)"),
});

async function receivables(params: any) {
  const asOf = checkDate(params?.as_of, "as_of") || todayISO();
  const top = params?.top ?? 10;
  const crit: any[] = [{ field: "Balance", value: "0", operator: ">" }];
  if (params?.customer_id) crit.push({ field: "CustomerRef", value: String(params.customer_id) });
  const [invs, aging] = await Promise.all([
    allRecords(searchQuickbooksInvoices, crit, "open invoices"),
    report(getQuickbooksAgedReceivables, { report_date: asOf, aging_method: "Report_Date", days_per_aging_period: 30, num_periods: 4, ...(params?.customer_id ? { customer: String(params.customer_id) } : {}) }, "receivables aging"),
  ]);
  const today = dayNumber(asOf);
  const rows = invs.map((r: any) => {
    const due = r.DueDate || r.TxnDate;
    const daysPast = today - dayNumber(due);
    return {
      invoice: r.DocNumber || null, customer: r.CustomerRef?.name ?? null, customerId: r.CustomerRef?.value ?? null,
      date: r.TxnDate, dueDate: due, total: toCents(r.TotalAmt), balance: toCents(r.Balance),
      daysPastDue: Math.max(daysPast, 0), agingColumn: bucketFor(daysPast), partlyPaid: toCents(r.Balance) !== toCents(r.TotalAmt),
    };
  });
  const byCol: Record<string, bigint> = Object.fromEntries([...AGE_COLS, "Total"].map((c) => [c, 0n]));
  const cust = new Map<string, any>();
  for (const r of rows) {
    byCol[r.agingColumn] += r.balance; byCol.Total += r.balance;
    const k = r.customerId || r.customer;
    if (!cust.has(k)) cust.set(k, { customer: r.customer, customerId: r.customerId, owed: 0n, pastDue: 0n, openInvoices: 0, aging: Object.fromEntries(AGE_COLS.map((c) => [c, 0n])) });
    const c = cust.get(k); c.owed += r.balance; c.openInvoices++; c.aging[r.agingColumn] += r.balance; if (r.daysPastDue > 0) c.pastDue += r.balance;
  }
  const qbo = agingTotals(aging);
  const matches = AGE_COLS.every((c) => toCents(qbo[c]) === byCol[c]) && toCents(qbo.Total) === byCol.Total;
  const fmt = (r: any) => ({ invoice: r.invoice, customer: r.customer, date: r.date, dueDate: r.dueDate, balance: money(r.balance), ...(r.partlyPaid ? { invoiceTotal: money(r.total), partlyPaid: true } : {}), daysPastDue: r.daysPastDue, agingColumn: r.agingColumn });
  const over60 = rows.filter((r) => r.daysPastDue > 60).sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : b.daysPastDue - a.daysPastDue));
  const other = rows.filter((r) => r.daysPastDue > 0 && r.daysPastDue <= 60).sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : b.daysPastDue - a.daysPastDue));
  const dueSoon = rows.filter((r) => r.daysPastDue === 0 && dayNumber(r.dueDate) - today <= 14).sort((a, b) => dayNumber(a.dueDate) - dayNumber(b.dueDate));
  const customers = [...cust.values()].sort((a, b) => (b.owed > a.owed ? 1 : b.owed < a.owed ? -1 : 0));
  const pastDueRows = rows.filter((r) => r.daysPastDue > 0);
  return text({
    asOf,
    totalOwed: money(byCol.Total),
    openInvoices: rows.length,
    customersWithBalance: customers.length,
    aging: Object.fromEntries([...AGE_COLS, "Total"].map((c) => [c, money(byCol[c])])),
    pastDue: money(byCol.Total - byCol.Current),
    matchesQuickBooksAgingReport: matches,
    ...(matches ? {} : { quickBooksAgingReport: qbo }),
    collectFirst: {
      rule: "Largest balances more than 60 days past due first, then other past-due balances by size.",
      moreThan60DaysPastDue: over60.map(fmt),
      pastDue1To60Days: other.slice(0, 15).map(fmt),
      ...(other.length > 15 ? { morePastDue1To60Days: `${other.length - 15} more past-due invoices totalling ${money(other.slice(15).reduce((s, r) => s + r.balance, 0n))}` } : {}),
    },
    pastDueInvoiceCount: pastDueRows.length,
    dueInNext14Days: { count: dueSoon.length, total: money(dueSoon.reduce((s, r) => s + r.balance, 0n)), largest: dueSoon.slice().sort((a, b) => (b.balance > a.balance ? 1 : -1)).slice(0, 5).map(fmt) },
    customersRankedByAmountOwed: customers.slice(0, top).map((c, i) => ({
      rank: i + 1, customer: c.customer, owed: money(c.owed), pastDue: money(c.pastDue), openInvoices: c.openInvoices,
      aging: Object.fromEntries(AGE_COLS.map((k) => [k, money(c.aging[k])])),
    })),
    note: "Computed exactly by the connector from every open invoice, aged by due date as of asOf; lists are already sorted. " +
      "Use these figures and this order as given. For a reminder email, get the contact with get_customer.",
  });
}

export const GetReceivablesSummaryTool = {
  name: "get_receivables_summary",
  description:
    "Who owes us money, in one call: total owed, aging (Current, 1 - 30, 31 - 60, 61 - 90, 91 and over), past-due total, " +
    "the collect-first list (invoice number, customer, due date, days past due, balance, already in priority order), invoices due in the next 14 days, " +
    "and customers ranked by amount owed. Pass customer_id for one customer's open invoices (for a payment reminder). Computed exactly from every open invoice.",
  schema: arSchema,
  handler: async ({ params }: any) => { try { return await receivables(params); } catch (e) { return fail(e); } },
};

// ---------------------------------------------------------------- payables

const apSchema = z.object({
  as_of: z.string().optional().describe("Date to age bills to (YYYY-MM-DD). Leave empty for today."),
  vendor_id: z.string().optional().describe("Only this vendor (QuickBooks vendor Id from search_customer_or_vendor)"),
  due_within_days: z.number().int().min(0).max(90).optional().describe("Also list bills due within this many days (default 7)"),
  top: z.number().int().min(1).max(50).optional().describe("How many vendors to list (default 10)"),
});

async function payables(params: any) {
  const asOf = checkDate(params?.as_of, "as_of") || todayISO();
  const within = params?.due_within_days ?? 7;
  const top = params?.top ?? 10;
  const crit: any[] = [{ field: "Balance", value: "0", operator: ">" }];
  if (params?.vendor_id) crit.push({ field: "VendorRef", value: String(params.vendor_id) });
  const [bills, aging] = await Promise.all([
    allRecords(searchQuickbooksBills, crit, "open bills"),
    report(getQuickbooksAgedPayables, { report_date: asOf, aging_method: "Report_Date", days_per_aging_period: 30, num_periods: 4, ...(params?.vendor_id ? { vendor: String(params.vendor_id) } : {}) }, "payables aging"),
  ]);
  const today = dayNumber(asOf);
  const rows = bills.map((r: any) => {
    const due = r.DueDate || r.TxnDate;
    const d = today - dayNumber(due);
    return { bill: r.DocNumber || null, vendor: r.VendorRef?.name ?? null, vendorId: r.VendorRef?.value ?? null, date: r.TxnDate, dueDate: due, balance: toCents(r.Balance), daysPastDue: Math.max(d, 0), daysUntilDue: Math.max(-d, 0), agingColumn: bucketFor(d) };
  });
  const byCol: Record<string, bigint> = Object.fromEntries([...AGE_COLS, "Total"].map((c) => [c, 0n]));
  const vend = new Map<string, any>();
  for (const r of rows) {
    byCol[r.agingColumn] += r.balance; byCol.Total += r.balance;
    const k = r.vendorId || r.vendor;
    if (!vend.has(k)) vend.set(k, { vendor: r.vendor, owed: 0n, pastDue: 0n, openBills: 0 });
    const v = vend.get(k); v.owed += r.balance; v.openBills++; if (r.daysPastDue > 0) v.pastDue += r.balance;
  }
  const qbo = agingTotals(aging);
  const matches = AGE_COLS.every((c) => toCents(qbo[c]) === byCol[c]) && toCents(qbo.Total) === byCol.Total;
  const fmt = (r: any) => ({ bill: r.bill, vendor: r.vendor, date: r.date, dueDate: r.dueDate, balance: money(r.balance), ...(r.daysPastDue > 0 ? { daysPastDue: r.daysPastDue } : { daysUntilDue: r.daysUntilDue }) });
  const overdue = rows.filter((r) => r.daysPastDue > 0).sort((a, b) => dayNumber(a.dueDate) - dayNumber(b.dueDate) || (b.balance > a.balance ? 1 : -1));
  const dueToday = rows.filter((r) => r.daysPastDue === 0 && r.daysUntilDue === 0);
  const dueSoon = rows.filter((r) => r.daysPastDue === 0 && r.daysUntilDue > 0 && r.daysUntilDue <= within).sort((a, b) => dayNumber(a.dueDate) - dayNumber(b.dueDate));
  const sum = (l: any[]) => money(l.reduce((s, r) => s + r.balance, 0n));
  const vendors = [...vend.values()].sort((a, b) => (b.owed > a.owed ? 1 : b.owed < a.owed ? -1 : 0));
  return text({
    asOf,
    totalOwed: money(byCol.Total),
    openBills: rows.length,
    vendorsOwed: vendors.length,
    aging: Object.fromEntries([...AGE_COLS, "Total"].map((c) => [c, money(byCol[c])])),
    matchesQuickBooksAgingReport: matches,
    ...(matches ? {} : { quickBooksAgingReport: qbo }),
    pastDue: { count: overdue.length, total: sum(overdue), bills: overdue.map(fmt) },
    dueToday: { count: dueToday.length, total: sum(dueToday), bills: dueToday.map(fmt) },
    dueSoon: { withinDays: within, count: dueSoon.length, total: sum(dueSoon), bills: dueSoon.slice(0, 20).map(fmt) },
    pastDueOrDueToday: sum([...overdue, ...dueToday]),
    vendorsRankedByAmountOwed: vendors.slice(0, top).map((v, i) => ({ rank: i + 1, vendor: v.vendor, owed: money(v.owed), pastDue: money(v.pastDue), openBills: v.openBills })),
    note: "Computed exactly by the connector from every open bill, aged by due date as of asOf; lists are already sorted (past-due bills oldest first). " +
      "Use these figures as given. A bill number of null means the bill has no number in QuickBooks: describe it by vendor, date and amount.",
  });
}

export const GetPayablesSummaryTool = {
  name: "get_payables_summary",
  description:
    "What we owe vendors, in one call: total owed, aging, past-due bills (oldest first), bills due today, bills due in the next N days, " +
    "the total past due or due today, and vendors ranked by amount owed. Pass vendor_id for one vendor. Computed exactly from every open bill.",
  schema: apSchema,
  handler: async ({ params }: any) => { try { return await payables(params); } catch (e) { return fail(e); } },
};

// ---------------------------------------------------------------- rankings

const rankSchema = z.object({
  start_date: z.string().describe("Start date (YYYY-MM-DD)"),
  end_date: z.string().describe("End date (YYYY-MM-DD)"),
  top: z.number().int().min(1).max(50).optional().describe("How many to list (default 10)"),
});

/** Ranks a by-name report (customer sales, vendor expenses); sub-customers roll up into their parent's total row. */
function ranked(flat: any, nameKey: string, unassignedLabels: string[]) {
  const rows = rowsOf(flat);
  const grand = one(rows, "TOTAL");
  const entries: { name: string; amount: bigint }[] = [];
  for (const r of rows) {
    if (r.label === "TOTAL") continue;
    if (r.kind === "line" && !r.group) entries.push({ name: r.label, amount: toCents(r.values.Total) });
    if (r.kind === "total" && r.group && !r.group.includes(" > ")) entries.push({ name: r.group, amount: toCents(r.values.Total) });
  }
  const assigned = entries.filter((e) => !unassignedLabels.includes(e.name));
  const unassigned = entries.filter((e) => unassignedLabels.includes(e.name));
  const total = toCents(grand.values.Total);
  const check = entries.reduce((s, e) => s + e.amount, 0n);
  if (check !== total) throw new Error(`report rows (${money(check)}) do not add up to the report total (${money(total)})`);
  assigned.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : a.name.localeCompare(b.name)));
  return { total, assigned, unassigned };
}

async function topCustomers(params: any) {
  const start = checkDate(params?.start_date, "start_date")!, end = checkDate(params?.end_date, "end_date")!;
  const top = params?.top ?? 10;
  const flat = await report(getQuickbooksCustomerSales, { start_date: start, end_date: end, summarize_column_by: "Total" }, "customer sales");
  const { total, assigned } = ranked(flat, "customer", []);
  const shown = assigned.slice(0, top);
  const shownSum = shown.reduce((s, e) => s + e.amount, 0n);
  return text({
    period: `${humanDate(start)} to ${humanDate(end)}`,
    totalSales: money(total),
    customersWithSales: assigned.length,
    ranking: shown.map((e, i) => ({ rank: i + 1, customer: e.name, sales: money(e.amount), percentOfTotal: pct(e.amount, total) })),
    topListTotal: money(shownSum),
    topListPercentOfTotal: pct(shownSum, total),
    note: "From the QuickBooks Customer Sales report; ranked and computed exactly by the connector. Keep this order and these figures.",
  });
}

export const GetTopCustomersTool = {
  name: "get_top_customers",
  description: "Biggest customers by sales for a period, already ranked, with each customer's share of total sales (from the Customer Sales report).",
  schema: rankSchema,
  handler: async ({ params }: any) => { try { return await topCustomers(params); } catch (e) { return fail(e); } },
};

async function topVendors(params: any) {
  const start = checkDate(params?.start_date, "start_date")!, end = checkDate(params?.end_date, "end_date")!;
  const top = params?.top ?? 10;
  const flat = await report(getQuickbooksVendorExpenses, { start_date: start, end_date: end, accounting_method: "Accrual", summarize_column_by: "Total" }, "vendor expenses");
  const { total, assigned, unassigned } = ranked(flat, "vendor", ["Not Specified"]);
  const shown = assigned.slice(0, top);
  return text({
    period: `${humanDate(start)} to ${humanDate(end)}`,
    basis: "Accrual",
    totalSpend: money(total),
    vendorsWithSpend: assigned.length,
    ranking: shown.map((e, i) => ({ rank: i + 1, vendor: e.name, spend: money(e.amount), percentOfTotal: pct(e.amount, total) })),
    ...(unassigned.length ? { noVendorRecorded: money(unassigned.reduce((s, e) => s + e.amount, 0n)), noVendorNote: "Spending with no vendor on it (for example journal entries such as depreciation); not a vendor, so not ranked." } : {}),
    note: "From the QuickBooks Expenses by Vendor report; ranked and computed exactly by the connector. Keep this order and these figures.",
  });
}

export const GetTopVendorsTool = {
  name: "get_top_vendors",
  description: "Vendors we spent the most with for a period, already ranked, with each vendor's share of total spending (from the Expenses by Vendor report).",
  schema: rankSchema,
  handler: async ({ params }: any) => { try { return await topVendors(params); } catch (e) { return fail(e); } },
};

// ---------------------------------------------------------------- profit comparison

const cmpSchema = z.object({
  start_date: z.string().describe("Start of the period (YYYY-MM-DD)"),
  end_date: z.string().describe("End of the period (YYYY-MM-DD)"),
  compare_start_date: z.string().optional().describe("Start of the period to compare with (default: the same dates one year earlier)"),
  compare_end_date: z.string().optional().describe("End of the period to compare with (default: the same dates one year earlier)"),
});

const TOTALS: [string, string, string | undefined][] = [
  ["income", "Total Income", undefined],
  ["costOfGoodsSold", "Total Cost of Goods Sold", "Cost of Goods Sold"],
  ["grossProfit", "Gross Profit", undefined],
  ["operatingExpenses", "Total Expenses", undefined],
  ["netOperatingIncome", "Net Operating Income", undefined],
  ["otherIncome", "Total Other Income", undefined],
  ["otherExpenses", "Total Other Expenses", undefined],
  ["netIncome", "Net Income", undefined],
];

async function profitComparison(params: any) {
  const s = checkDate(params?.start_date, "start_date")!, e = checkDate(params?.end_date, "end_date")!;
  const cs = checkDate(params?.compare_start_date, "compare_start_date") || yearEarlier(s);
  const ce = checkDate(params?.compare_end_date, "compare_end_date") || yearEarlier(e);
  const [cur, pri] = await Promise.all([
    report(getQuickbooksProfitAndLoss, { start_date: s, end_date: e, accounting_method: "Accrual", summarize_column_by: "Total" }, "profit and loss"),
    report(getQuickbooksProfitAndLoss, { start_date: cs, end_date: ce, accounting_method: "Accrual", summarize_column_by: "Total" }, "profit and loss (comparison)"),
  ]);
  const a = rowsOf(cur), b = rowsOf(pri);
  const pair = (x: bigint, y: bigint) => ({ period: money(x), comparePeriod: money(y), change: money(x - y), changePercent: pct(x - y, y) });
  const totals: any = {};
  const T: Record<string, [bigint, bigint]> = {};
  for (const [k, label, group] of TOTALS) {
    const x = col(maybe(a, label, group)), y = col(maybe(b, label, group));
    T[k] = [x, y];
    totals[k] = pair(x, y);
  }
  const margin = (n: bigint, d: bigint) => pct(n, d);
  const gm = [margin(T.grossProfit[0], T.income[0]), margin(T.grossProfit[1], T.income[1])];
  const nm = [margin(T.netIncome[0], T.income[0]), margin(T.netIncome[1], T.income[1])];
  const pp = (x: string | null, y: string | null) => (x === null || y === null ? null : money(toCents(x) - toCents(y)));

  // Account lines matched by group + label across both periods.
  const lines = (section: RegExp) => {
    const key = (r: Row) => (r.group || "") + "|" + r.label;
    const m = new Map<string, { account: string; group: string; x: bigint; y: bigint }>();
    for (const [rows, i] of [[a, 0], [b, 1]] as [Row[], number][]) {
      for (const r of rows) {
        if (r.kind !== "line" || !section.test(r.group || "")) continue;
        const k = key(r);
        if (!m.has(k)) m.set(k, { account: r.label, group: (r.group || "").split(" > ").slice(1).join(" > "), x: 0n, y: 0n });
        const v = m.get(k)!; if (i === 0) v.x += toCents(r.values.Total); else v.y += toCents(r.values.Total);
      }
    }
    return [...m.values()];
  };
  const fmtLine = (l: any) => ({ account: l.account, ...(l.group ? { under: l.group } : {}), period: money(l.x), comparePeriod: money(l.y), change: money(l.x - l.y), changePercent: pct(l.x - l.y, l.y) });
  const byGrowth = (l: any[]) => l.slice().sort((p, q) => {
    if (p.y === 0n || q.y === 0n) return p.y === 0n ? 1 : -1;
    const lp = (p.x - p.y) * q.y, lq = (q.x - q.y) * p.y; // compare growth ratios without rounding
    return lq > lp ? 1 : lq < lp ? -1 : 0;
  });
  const bySize = (l: any[]) => l.slice().sort((p, q) => (q.x > p.x ? 1 : q.x < p.x ? -1 : 0));
  const byChange = (l: any[]) => l.slice().sort((p, q) => { const dp = p.x - p.y, dq = q.x - q.y; return dq > dp ? 1 : dq < dp ? -1 : 0; });
  const income = lines(/^Income( > |$)/);
  const cogs = lines(/^Cost of Goods Sold( > |$)/);
  const expenses = lines(/^Expenses( > |$)/);
  const other = lines(/^Other (Income|Expenses)( > |$)/);
  return text({
    period: `${humanDate(s)} to ${humanDate(e)}`,
    comparePeriod: `${humanDate(cs)} to ${humanDate(ce)}`,
    basis: "Accrual",
    totals,
    grossMarginPercent: { period: gm[0], comparePeriod: gm[1], changePoints: pp(gm[0], gm[1]) },
    netMarginPercent: { period: nm[0], comparePeriod: nm[1], changePoints: pp(nm[0], nm[1]) },
    incomeLinesByGrowth: byGrowth(income).map(fmtLine),
    costOfGoodsSoldLinesByChange: byChange(cogs).map(fmtLine),
    expenseLinesBySize: bySize(expenses).map(fmtLine),
    ...(other.length ? { otherIncomeAndExpenseLines: bySize(other).map(fmtLine) } : {}),
    note: "From two QuickBooks Profit and Loss reports; every change, percentage and margin is computed exactly by the connector and every list is already sorted " +
      "(income lines fastest growth first; cost lines biggest increase first; expense lines largest first). Use these figures and orders as given. " +
      "Cost of goods sold is not an operating expense. changePoints is the change in percentage points.",
  });
}

export const GetProfitComparisonTool = {
  name: "get_profit_comparison",
  description:
    "Compare profit for two periods in one call (default: the same dates one year earlier): income, cost of goods sold, gross profit, operating expenses, " +
    "net income, gross and net margin, each with the change and percent change, plus income lines ranked by growth, cost lines ranked by increase and " +
    "expense lines ranked by size. Use it for month-over-month, year-over-year, fastest-growing product lines, margin changes and biggest expenses.",
  schema: cmpSchema,
  handler: async ({ params }: any) => { try { return await profitComparison(params); } catch (e) { return fail(e); } },
};

// ---------------------------------------------------------------- what a customer bought

const buySchema = z.object({
  customer_id: z.string().describe("QuickBooks customer Id (from search_customer_or_vendor)"),
  start_date: z.string().describe("Start date (YYYY-MM-DD)"),
  end_date: z.string().describe("End date (YYYY-MM-DD)"),
});

async function customerPurchases(params: any) {
  const s = checkDate(params?.start_date, "start_date")!, e = checkDate(params?.end_date, "end_date")!;
  const id = String(params?.customer_id || "").trim();
  if (!id) throw new Error("customer_id is required");
  const invs = await allRecords(searchQuickbooksInvoices, [
    { field: "CustomerRef", value: id },
    { field: "TxnDate", value: s, operator: ">=" },
    { field: "TxnDate", value: e, operator: "<=" },
  ], "invoices");
  if (invs.length > 40) throw new Error(`${invs.length} invoices in this period; choose a shorter period (at most 40 invoices)`);
  const full = await Promise.all(invs.map(async (i: any) => {
    const r = await readQuickbooksInvoice(String(i.Id));
    if (r.isError) throw new Error("invoice " + (i.DocNumber || i.Id) + ": " + r.error);
    return r.result;
  }));
  const items = new Map<string, { item: string; quantity: number; amount: bigint; invoices: Set<string> }>();
  const list: any[] = [];
  let total = 0n;
  for (const inv of full.sort((p: any, q: any) => String(p.TxnDate).localeCompare(String(q.TxnDate)) || String(p.DocNumber).localeCompare(String(q.DocNumber)))) {
    let lineSum = 0n;
    const invLines: any[] = [];
    for (const l of inv.Line || []) {
      if (l.DetailType !== "SalesItemLineDetail") continue;
      const name = l.SalesItemLineDetail?.ItemRef?.name || l.Description || "Other";
      const amt = toCents(l.Amount);
      const qty = Number(l.SalesItemLineDetail?.Qty ?? 0);
      lineSum += amt;
      if (!items.has(name)) items.set(name, { item: name, quantity: 0, amount: 0n, invoices: new Set() });
      const it = items.get(name)!; it.quantity += qty; it.amount += amt; it.invoices.add(inv.DocNumber || inv.Id);
      invLines.push({ item: name, description: l.Description || undefined, quantity: qty, amount: money(amt) });
    }
    total += toCents(inv.TotalAmt);
    list.push({ invoice: inv.DocNumber || null, date: inv.TxnDate, total: money(toCents(inv.TotalAmt)), balance: money(toCents(inv.Balance)), lines: invLines.length, largestLines: invLines.sort((p, q) => Number(toCents(q.amount) - toCents(p.amount))).slice(0, 4) });
  }
  const ranked = [...items.values()].sort((p, q) => (q.amount > p.amount ? 1 : q.amount < p.amount ? -1 : 0));
  return text({
    customer: full[0]?.CustomerRef?.name ?? null,
    period: `${humanDate(s)} to ${humanDate(e)}`,
    invoiceCount: list.length,
    totalSales: money(total),
    invoices: list,
    itemsBySales: ranked.slice(0, 15).map((r, i) => ({ rank: i + 1, item: r.item, quantity: r.quantity, sales: money(r.amount), percentOfTotal: pct(r.amount, total), invoices: [...r.invoices] })),
    ...(ranked.length > 15 ? { otherItems: `${ranked.length - 15} more items totalling ${money(ranked.slice(15).reduce((p, r) => p + r.amount, 0n))}` } : {}),
    note: "Invoices dated in the period, read line by line by the connector; totals and rankings computed exactly. Use them as given.",
  });
}

export const GetCustomerPurchasesTool = {
  name: "get_customer_purchases",
  description: "What one customer bought in a period, in one call: each invoice (number, date, total, balance, largest lines), the total, and items ranked by sales with quantities.",
  schema: buySchema,
  handler: async ({ params }: any) => { try { return await customerPurchases(params); } catch (e) { return fail(e); } },
};

export const ANSWER_TOOLS = [
  GetFinanceSnapshotTool, GetReceivablesSummaryTool, GetPayablesSummaryTool, GetTopCustomersTool,
  GetTopVendorsTool, GetProfitComparisonTool, GetCustomerPurchasesTool,
];
