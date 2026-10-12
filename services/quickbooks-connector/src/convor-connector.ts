// Convor QuickBooks connector: serves a READ-ONLY subset of Intuit's official
// QuickBooks Online MCP server over Streamable HTTP for LibreChat.
import { configured, missing } from "./convor-preflight.js";
import http from "http";
import crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { RegisterTool } from "./helpers/register-tool.js";
import { QuickbooksClient, quickbooksClient } from "./clients/quickbooks-client.js";
import { getQuickbooksCompanyInfo } from "./handlers/get-quickbooks-company-info.handler.js";

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

const VERSION = "1.0.0";
const PORT = Number(process.env.PORT || 8080);
const MAX_RESULT_CHARS = 150_000;
const KEEPALIVE_MS = 6 * 60 * 60 * 1000;
const RECONNECT_MSG =
  "The QuickBooks connection has expired or was revoked. Reconnect it: get a new refresh token in the Intuit OAuth Playground " +
  "and paste it into the quickbooks-connector service's QUICKBOOKS_REFRESH_TOKEN variable in Railway.";

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
];

// Belt and braces: refuse to serve anything that is not a read.
const READ_ONLY = /^(get|search|read)[_-]/;
for (const t of TOOLS) {
  if (!t || typeof t.name !== "string" || typeof t.handler !== "function") throw new Error("Bad tool definition");
  if (!READ_ONLY.test(t.name)) throw new Error("Refusing to serve non-read tool " + t.name);
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
      try { text = JSON.stringify(JSON.parse(trimmed)); } catch { /* leave as is */ }
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

const SERVED = TOOLS.map((t) => ({
  ...t,
  handler: async (...args: any[]) => {
    try {
      return tidy(await t.handler(...args));
    } catch (e: any) {
      return { isError: true, content: [{ type: "text", text: redact("Error: " + (e?.message || String(e))) }] };
    }
  },
}));

function buildServer(): McpServer {
  const server = new McpServer(
    { name: "Convor QuickBooks (read-only)", version: VERSION },
    { capabilities: { tools: {} } },
  );
  for (const t of SERVED) RegisterTool(server, t);
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
