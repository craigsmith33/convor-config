// Convor QuickBooks connector: serves a READ-ONLY subset of Intuit's official
// QuickBooks Online MCP server over Streamable HTTP for LibreChat.
import { configured, missing } from "./convor-preflight.js";
import http from "http";
import crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isToolDisabled, knownParamKeys, unsupportedParamsWarning } from "./helpers/register-tool.js";
import { QuickbooksClient, quickbooksClient } from "./clients/quickbooks-client.js";
import { getQuickbooksCompanyInfo } from "./handlers/get-quickbooks-company-info.handler.js";
import { searchQuickbooksCustomers } from "./handlers/search-quickbooks-customers.handler.js";
import { searchQuickbooksVendors } from "./handlers/search-quickbooks-vendors.handler.js";
import { z } from "zod";
import { flattenReport, isQuickBooksReport } from "./convor-reports.js";
import { calculateAll } from "./convor-calc.js";
import { compactSearchResult } from "./convor-lists.js";

// Reports
import { GetProfitAndLossTool } from "./tools/get-profit-and-loss.tool.js";
import { GetBalanceSheetTool } from "./tools/get-balance-sheet.tool.js";
import { GetCashFlowTool } from "./tools/get-cash-flow.tool.js";
import { GetTrialBalanceTool } from "./tools/get-trial-balance.tool.js";
import { GetAgedReceivablesTool } from "./tools/get-aged-receivables.tool.js";
import { GetAgedPayablesTool } from "./tools/get-aged-payables.tool.js";
import { GetCustomerBalanceTool } from "./tools/get-customer-balance.tool.js";
import { GetVendorBalanceTool } from "./tools/get-vendor-balance.tool.js";
import { GetCustomerSalesTool } from "./tools/get-customer-sales.tool.js";
import { GetVendorExpensesTool } from "./tools/get-vendor-expenses.tool.js";
// Company
import { GetCompanyInfoTool } from "./tools/get-company-info.tool.js";
// Customers and receivables
import { SearchCustomersTool } from "./tools/search-customers.tool.js";
import { GetCustomerTool } from "./tools/get-customer.tool.js";
import { SearchInvoicesTool } from "./tools/search-invoices.tool.js";
import { ReadInvoiceTool } from "./tools/read-invoice.tool.js";
import { SearchPaymentsTool } from "./tools/search-payments.tool.js";
import { GetPaymentTool } from "./tools/get-payment.tool.js";
import { SearchEstimatesTool } from "./tools/search-estimates.tool.js";
import { GetEstimateTool } from "./tools/get-estimate.tool.js";
import { SearchCreditMemosTool } from "./tools/search-credit-memos.tool.js";
import { SearchSalesReceiptsTool } from "./tools/search-sales-receipts.tool.js";
// Vendors and payables
import { SearchVendorsTool } from "./tools/search-vendors.tool.js";
import { GetVendorTool } from "./tools/get-vendor.tool.js";
import { SearchBillsTool } from "./tools/search-bills.tool.js";
import { GetBillTool } from "./tools/get-bill.tool.js";
import { SearchBillPaymentsTool } from "./tools/search-bill-payments.tool.js";
import { SearchPurchasesTool } from "./tools/search-purchases.tool.js";
import { GetPurchaseTool } from "./tools/get-purchase.tool.js";
import { SearchPurchaseOrdersTool } from "./tools/search-purchase-orders.tool.js";
// Accounts and reference data
import { SearchAccountsTool } from "./tools/search-accounts.tool.js";
import { GetAccountTool } from "./tools/get-account.tool.js";
import { SearchItemsTool } from "./tools/search-items.tool.js";
import { ReadItemTool } from "./tools/read-item.tool.js";
import { SearchBudgetsTool } from "./tools/search-budgets.tool.js";
import { SearchDepositsTool } from "./tools/search-deposits.tool.js";
import { SearchClassesTool } from "./tools/search-classes.tool.js";
import { SearchDepartmentsTool } from "./tools/search-departments.tool.js";
import { SearchTermsTool } from "./tools/search-terms.tool.js";

const VERSION = "1.4.0";
const PORT = Number(process.env.PORT || 8080);
const MAX_RESULT_CHARS = 150_000;
const KEEPALIVE_MS = 6 * 60 * 60 * 1000;
const RECONNECT_MSG =
  "The QuickBooks connection has expired or was revoked. Reconnect it: get a new refresh token in the Intuit OAuth Playground " +
  "and paste it into the quickbooks-connector service's QUICKBOOKS_REFRESH_TOKEN variable in Railway.";

// Convor addition: one read-only lookup across BOTH customers and vendors, so a
// name is never reported missing just because the wrong list was searched.
const lookupSchema = z.object({
  name: z.string().min(1).describe("All or part of the customer's or vendor's name, for example \"paulsen\""),
});
function compactParty(type: "customer" | "vendor", r: any) {
  const out: any = { type, Id: r?.Id, DisplayName: r?.DisplayName };
  if (r?.FullyQualifiedName && r.FullyQualifiedName !== r.DisplayName) out.FullyQualifiedName = r.FullyQualifiedName;
  if (r?.CompanyName && r.CompanyName !== r.DisplayName) out.CompanyName = r.CompanyName;
  if (r?.Balance !== undefined) out.Balance = r.Balance;
  if (type === "customer" && r?.BalanceWithJobs !== undefined && r.BalanceWithJobs !== r.Balance) out.BalanceWithJobs = r.BalanceWithJobs;
  if (r?.Job) { out.IsSubCustomer = true; if (r?.ParentRef?.value) out.ParentId = r.ParentRef.value; }
  if (r?.PrimaryEmailAddr?.Address) out.Email = r.PrimaryEmailAddr.Address;
  if (r?.PrimaryPhone?.FreeFormNumber) out.Phone = r.PrimaryPhone.FreeFormNumber;
  if (r?.Active === false) out.Active = false;
  return out;
}
async function lookupBoth(term: string) {
  const crit = [{ field: "DisplayName", value: `%${term}%`, operator: "LIKE" }, { field: "limit", value: 25 }];
  const [c, v] = await Promise.all([searchQuickbooksCustomers(crit), searchQuickbooksVendors(crit)]);
  if (c.isError && v.isError) throw new Error(String(c.error || v.error));
  return {
    customers: Array.isArray(c.result) ? c.result.map((r: any) => compactParty("customer", r)) : [],
    vendors: Array.isArray(v.result) ? v.result.map((r: any) => compactParty("vendor", r)) : [],
    errors: [c.isError ? "customers: " + c.error : "", v.isError ? "vendors: " + v.error : ""].filter(Boolean),
  };
}
const SearchCustomerOrVendorTool = {
  name: "search_customer_or_vendor",
  description:
    "Find a customer or a vendor by name in one step. Searches BOTH lists with a partial, case-insensitive name match: " +
    "customers (who buy from us and owe us money) and vendors (businesses we pay). Returns each match's type, Id, name, balance and email. " +
    "Use the Id with other tools (for example search_invoices with CustomerRef, or search_bills with VendorRef).",
  schema: lookupSchema,
  handler: async ({ params }: any) => {
    const name = String(params?.name ?? "").replace(/[\u2018\u2019]/g, "'").replace(/[%_]/g, " ").replace(/\s+/g, " ").trim();
    if (!name) return { isError: true, content: [{ type: "text" as const, text: "Error: give part of a name to search for." }] };
    let found = await lookupBoth(name);
    let searched = [name];
    if (!found.customers.length && !found.vendors.length) {
      // Fall back to each distinctive word, e.g. "Paulsen Medical Supplies Inc" -> "Paulsen".
      const words = [...new Set(name.split(" ").filter((w) => w.replace(/[^\p{L}\p{N}]/gu, "").length >= 3))].slice(0, 4);
      if (words.length > 1 || (words.length === 1 && words[0] !== name)) {
        const seen = new Set<string>();
        const merged: any = { customers: [], vendors: [], errors: [] };
        for (const w of words) {
          const r = await lookupBoth(w);
          for (const k of ["customers", "vendors"]) for (const x of r[k as "customers" | "vendors"]) {
            const key = x.type + ":" + x.Id;
            if (!seen.has(key)) { seen.add(key); merged[k].push(x); }
          }
          merged.errors.push(...r.errors);
        }
        found = merged;
        searched = words;
      }
    }
    const summary = {
      searchedFor: searched,
      customers: found.customers,
      vendors: found.vendors,
      ...(found.errors.length ? { errors: found.errors } : {}),
      note: found.customers.length || found.vendors.length
        ? "Customers owe us money; vendors are paid by us. Id is internal: use it in other tools, never show it as an account or invoice number."
        : "No customer or vendor matched. Try a shorter or different spelling.",
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(summary) }] };
  },
};

// Convor addition: exact decimal arithmetic in one call, so the assistant never
// does mental math on money. Pure computation; it does not touch QuickBooks.
const calcSchema = z.object({
  calculations: z.array(z.object({
    label: z.string().optional().describe("What this number is, for example \"Net margin Nov 2025\""),
    expression: z.string().describe("Arithmetic using numbers, + - * / and parentheses, for example \"1680.78 / 6915.88 * 100\""),
  })).min(1).max(60).describe("Every calculation the answer needs, all in this one call"),
  decimals: z.number().int().min(0).max(6).optional().describe("Decimal places to round results to (default 2)"),
});
const CalculateTool = {
  name: "calculate",
  description:
    "Exact calculator for money, percentages and ratios. Put every calculation the answer needs into one call " +
    "(totals, differences, percentage changes, margins, ratios). Expressions use numbers, + - * / and parentheses; " +
    "$ signs and thousands commas are fine. Returns each result rounded (default 2 decimals) and unrounded. " +
    "Use these results exactly; never work numbers out yourself. This tool does not read or change QuickBooks.",
  schema: calcSchema,
  handler: async ({ params }: any) => {
    const items = Array.isArray(params?.calculations) ? params.calculations : [];
    if (!items.length) return { isError: true, content: [{ type: "text" as const, text: "Error: give at least one calculation." }] };
    const results = calculateAll(items.slice(0, 60), params?.decimals ?? 2);
    return { content: [{ type: "text" as const, text: JSON.stringify({ results }) }] };
  },
};

const TOOLS: any[] = [
  GetProfitAndLossTool, GetBalanceSheetTool, GetCashFlowTool, GetTrialBalanceTool, GetAgedReceivablesTool,
  GetAgedPayablesTool, GetCustomerBalanceTool, GetVendorBalanceTool, GetCustomerSalesTool, GetVendorExpensesTool,
  GetCompanyInfoTool,
  SearchCustomersTool, GetCustomerTool, SearchInvoicesTool, ReadInvoiceTool, SearchPaymentsTool, GetPaymentTool,
  SearchEstimatesTool, GetEstimateTool, SearchCreditMemosTool, SearchSalesReceiptsTool,
  SearchVendorsTool, GetVendorTool, SearchBillsTool, GetBillTool, SearchBillPaymentsTool, SearchPurchasesTool,
  GetPurchaseTool, SearchPurchaseOrdersTool,
  SearchAccountsTool, GetAccountTool, SearchItemsTool, ReadItemTool, SearchBudgetsTool, SearchDepositsTool,
  SearchClassesTool, SearchDepartmentsTool, SearchTermsTool,
  SearchCustomerOrVendorTool, CalculateTool,
];

// Belt and braces: refuse to serve anything that is not a read (plus the
// Convor-only calculator, which never calls QuickBooks).
const READ_ONLY = /^(get|search|read)[_-]/;
const LOCAL_ONLY = new Set(["calculate"]);
for (const t of TOOLS) {
  if (!t || typeof t.name !== "string" || typeof t.handler !== "function") throw new Error("Bad tool definition");
  if (!READ_ONLY.test(t.name) && !(LOCAL_ONLY.has(t.name) && t === CalculateTool)) throw new Error("Refusing to serve non-read tool " + t.name);
}

// Never fall back to Intuit's interactive browser login inside a server: it
// would hang every request. Fail fast with instructions instead.
(quickbooksClient as any).startOAuthFlow = async () => {
  throw new Error(RECONNECT_MSG);
};

function secretsToRedact(): string[] {
  const c: any = quickbooksClient;
  return [process.env.QUICKBOOKS_CLIENT_SECRET, process.env.QUICKBOOKS_REFRESH_TOKEN, c.refreshToken, c.accessToken, process.env.MCP_SHARED_SECRET]
    .filter((s): s is string => typeof s === "string" && s.length >= 12);
}

function redact(text: string): string {
  let out = text;
  for (const s of secretsToRedact()) out = out.split(s).join("[redacted]");
  return out;
}

// Lossless compaction (QuickBooks JSON is pretty-printed), a size cap, and redaction.
function tidy(result: any): any {
  if (!result || !Array.isArray(result.content)) return result;
  let total = 0;
  for (const item of result.content) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    let text = item.text;
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        text = JSON.stringify(parsed);
        if (isQuickBooksReport(parsed)) {
          try {
            const flat = flattenReport(parsed);
            if (flat) text = JSON.stringify(flat);
          } catch (e: any) {
            console.log("[connector] report kept in original form: " + (e?.message || String(e)).slice(0, 200));
          }
        }
      } catch { /* leave as is */ }
    }
    if (total + text.length > MAX_RESULT_CHARS) {
      text = text.slice(0, Math.max(0, MAX_RESULT_CHARS - total)) +
        "\n[Truncated: this result was too large. Narrow the date range or add filters and try again.]";
    }
    item.text = redact(text);
    total += item.text.length;
  }
  return result;
}

function logCall(name: string, args: any[], ms: number, result: any) {
  try {
    const params = redact(JSON.stringify(args?.[0]?.params ?? {})).slice(0, 300);
    const content = Array.isArray(result?.content) ? result.content : [];
    const chars = content.reduce((n: number, c: any) => n + (typeof c?.text === "string" ? c.text.length : 0), 0);
    const failed = !!result?.isError || content.some((c: any) => typeof c?.text === "string" && /^Error/.test(c.text));
    console.log(`[tool] ${name} ${failed ? "ERROR" : "ok"} ms=${ms} chars=${chars} params=${params}`);
  } catch { /* logging must never break a call */ }
}

const SERVED = TOOLS.map((t) => ({
  ...t,
  handler: async (...args: any[]) => {
    const t0 = Date.now();
    let result: any;
    try {
      const raw = await t.handler(...args);
      let compact: any = null;
      try { compact = compactSearchResult(t.name, raw); } catch (e: any) {
        console.log("[connector] " + t.name + " kept in original form: " + (e?.message || String(e)).slice(0, 200));
      }
      result = tidy(compact ?? raw);
    } catch (e: any) {
      result = { isError: true, content: [{ type: "text", text: redact("Error: " + (e?.message || String(e))) }] };
    }
    logCall(t.name, args, Date.now() - t0, result);
    return result;
  },
}));

// Convor change (1.3): tools take their arguments at the top level, for example
// {"end_date": "2026-09-30"}. Upstream wraps every tool's arguments in a single
// "params" object, which models often leave out on the first try, so the call
// fails validation and has to be retried. The handlers still receive
// { params }, exactly as upstream expects. For tools with no required
// arguments, a call that still sends the old { "params": { ... } } shape is
// unwrapped and validated against the same schema. Unknown keys are reported
// and stripped before the handler runs, as upstream does.
function registerFlat(server: McpServer, t: any) {
  if (isToolDisabled(t.name)) return;
  const known = knownParamKeys(t.schema);
  if (!known) throw new Error("Tool " + t.name + " does not have an object schema");
  const input = t.schema.passthrough();
  server.registerTool(t.name, { description: t.description, inputSchema: input }, async (args: any, extra: any) => {
    let params: Record<string, unknown> = args && typeof args === "object" && !Array.isArray(args) ? { ...args } : {};
    const nested = params.params;
    if (!known.has("params") && nested && typeof nested === "object" && !Array.isArray(nested)) {
      const { params: _drop, ...rest } = params;
      params = { ...(nested as Record<string, unknown>), ...rest };
      const check = input.safeParse(params);
      if (!check.success) {
        const why = check.error.issues.map((i: any) => (i.path.join(".") || "arguments") + ": " + i.message).join("; ");
        return { isError: true, content: [{ type: "text" as const, text: `Error: invalid arguments for ${t.name}: ${why}` }] };
      }
      params = check.data;
    }
    const warning = unsupportedParamsWarning(t.name, known, params);
    if (warning) params = Object.fromEntries(Object.entries(params).filter(([k]) => known.has(k)));
    const result = await t.handler({ params }, extra);
    if (warning && result && Array.isArray(result.content)) result.content.unshift({ type: "text" as const, text: warning });
    return result;
  });
}

function buildServer(): McpServer {
  const server = new McpServer(
    { name: "Convor QuickBooks (read-only)", version: VERSION },
    { capabilities: { tools: {} } },
  );
  for (const t of SERVED) registerFlat(server, t);
  return server;
}

// ---- self test (no network): prints what would be served and exits
if (process.env.CONNECTOR_SELFTEST === "1") {
  const s: any = buildServer();
  const c: any = quickbooksClient;
  const sha = (v?: string) => (v ? crypto.createHash("sha256").update(v).digest("hex").slice(0, 12) : "none");
  console.log(JSON.stringify({
    configured, missing,
    tools: Object.keys(s._registeredTools || {}).sort(),
    refreshTokenSha: sha(c.refreshToken), realmId: c.realmId, environment: c.environment,
  }));
  process.exit(0);
}

// ---- connection status, checked at start and every 6 hours (also keeps the
// refresh token rotating so an idle demo does not lose its connection)
let status: { state: string; company?: string; checkedAt?: string; detail?: string } = {
  state: configured ? "starting" : "not_configured",
  ...(configured ? {} : { detail: "Missing or placeholder values: " + missing.join(", ") }),
};

async function checkConnection() {
  try {
    const r = await getQuickbooksCompanyInfo();
    if (r.isError) throw new Error(String(r.error));
    const name = r.result?.CompanyName || r.result?.CompanyInfo?.CompanyName || "unknown";
    status = { state: "connected", company: name, checkedAt: new Date().toISOString() };
    console.log(`[connector] QuickBooks connected: ${name} (${process.env.QUICKBOOKS_ENVIRONMENT || "sandbox"})`);
  } catch (e: any) {
    status = { state: "error", checkedAt: new Date().toISOString(), detail: redact(e?.message || String(e)).slice(0, 300) };
    console.log("[connector] QuickBooks check failed: " + status.detail);
  }
}

function send(res: http.ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function authorized(header: string | undefined): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header || "");
  if (!m) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(process.env.MCP_SHARED_SECRET || "");
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const httpServer = http.createServer(async (req, res) => {
  const path = (req.url || "/").split("?")[0];
  try {
    if (path === "/health") return send(res, 200, { service: "quickbooks-connector", version: VERSION, readOnly: true, ...status });
    if (path !== "/mcp") return send(res, 404, { error: "not found" });
    if (!configured) return send(res, 503, { error: "QuickBooks is not connected yet" });
    if (!authorized(req.headers.authorization)) return send(res, 401, { error: "unauthorized" });
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }, { Allow: "POST" });
    let body: unknown;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: "invalid JSON body" }); }
    // Stateless: a fresh MCP server and transport per request.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req as any, res, body);
  } catch (e: any) {
    console.log("[connector] request error: " + redact(e?.message || String(e)).slice(0, 300));
    send(res, 500, { error: "internal error" });
  }
});

// Listen on IPv6 + IPv4 (Railway private networking); fall back to IPv4-only
// hosts. Any other listen failure exits so Railway restarts the service.
let host = "::";
httpServer.on("error", (e: any) => {
  if (e?.code === "EAFNOSUPPORT" && host === "::") {
    host = "0.0.0.0";
    httpServer.listen(PORT, host);
    return;
  }
  console.log("[connector] server error: " + (e?.message || String(e)));
  process.exit(1);
});
httpServer.on("listening", () => {
  console.log(`[connector] Convor QuickBooks connector ${VERSION} listening on [${host}]:${PORT}; read-only tools: ${SERVED.length}; configured: ${configured}`);
  if (!configured) console.log("[connector] Waiting for keys. Missing: " + missing.join(", "));
});
httpServer.listen(PORT, host);

if (configured) {
  checkConnection();
  setInterval(checkConnection, KEEPALIVE_MS);
}
