// Convor: one-time loader for the QuickBooks SANDBOX demo company.
//
// Runs inside the quickbooks-connector container, before the connector starts
// (see README "Loading the Tallmark sample books"). It shares the connector's
// saved QuickBooks login (the token store on /data), so the refresh token it
// rotates is written back where the connector will pick it up.
//
// The connector itself stays read-only. This loader is the only thing that
// writes, it refuses to run against anything but a sandbox company, and it
// keeps its progress in /data/convor-seed so an interrupted run resumes.
//
// SEED_MODE:
//   probe    read-only: company, preferences, counts, accounts, terms, items
//   cleanup  back up, then delete Intuit's sample transactions and make the
//            sample customers, vendors and items inactive
//   setup    rename the company; create accounts, terms, items, customers, vendors
//   load     opening balances, then all transactions (resumable)
//   report   read-only: totals to compare with the dataset's expectations
import fs from "fs";
import path from "path";
import crypto from "crypto";

const MODE = (process.env.SEED_MODE || "probe").trim();
const BUDGET_MS = Number(process.env.SEED_MAX_MINUTES || 20) * 60_000;
const T0 = Date.now();
const STATE_DIR = "/data/convor-seed";
const STATE_FILE = path.join(STATE_DIR, "state.json");
const ALLOWED_COMPANIES = ["Sandbox Company_US_1", "Tallmark Industrial Supply"];
const MINOR = "minorversion=75";

const log = (...a) => console.log("SEED|" + a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const timeLeft = () => BUDGET_MS - (Date.now() - T0);

for (const k of ["QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET", "QUICKBOOKS_REFRESH_TOKEN", "QUICKBOOKS_REALM_ID", "QUICKBOOKS_TOKEN_STORE_PATH", "QUICKBOOKS_ENVIRONMENT"]) {
  if (typeof process.env[k] === "string") process.env[k] = process.env[k].trim();
}
const ENVIRONMENT = process.env.QUICKBOOKS_ENVIRONMENT || "sandbox";
const REALM = process.env.QUICKBOOKS_REALM_ID;
const STORE = process.env.QUICKBOOKS_TOKEN_STORE_PATH;
if (ENVIRONMENT !== "sandbox") throw new Error("Refusing to run: QUICKBOOKS_ENVIRONMENT is not sandbox");
if (!REALM || !STORE || !path.isAbsolute(STORE)) throw new Error("Missing realm or token store path");
const BASE = `https://sandbox-quickbooks.api.intuit.com/v3/company/${REALM}`;

// ---------- token handling (mirrors convor-preflight.ts and the upstream client) ----------
function parseEnvFile(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2").trim();
  }
  return out;
}
function startingRefreshToken() {
  const seed = sha([process.env.QUICKBOOKS_CLIENT_ID, REALM, process.env.QUICKBOOKS_REFRESH_TOKEN].join("|"));
  const seedFile = STORE + ".seed";
  const previous = fs.existsSync(seedFile) ? fs.readFileSync(seedFile, "utf8").trim() : "";
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  if (previous !== seed) {
    // Same reset the connector's preflight performs when new keys are pasted.
    if (fs.existsSync(STORE)) fs.unlinkSync(STORE);
    fs.writeFileSync(seedFile, seed + "\n", { mode: 0o600 });
    log("token: new keys in Railway variables; starting from them");
    return process.env.QUICKBOOKS_REFRESH_TOKEN;
  }
  const saved = fs.existsSync(STORE) ? parseEnvFile(fs.readFileSync(STORE, "utf8")).QUICKBOOKS_REFRESH_TOKEN : "";
  log("token: using the saved (rotated) refresh token" + (saved ? "" : " - none saved, falling back to the variable"));
  return saved || process.env.QUICKBOOKS_REFRESH_TOKEN;
}
function persistRefreshToken(token) {
  const lines = fs.existsSync(STORE) ? fs.readFileSync(STORE, "utf8").split("\n") : [];
  const set = (name, value) => {
    const i = lines.findIndex((l) => l.startsWith(name + "="));
    if (i >= 0) lines[i] = `${name}=${value}`; else lines.push(`${name}=${value}`);
  };
  set("QUICKBOOKS_REFRESH_TOKEN", token);
  set("QUICKBOOKS_REALM_ID", REALM);
  const content = lines.filter((l, i) => l !== "" || i < lines.length - 1).join("\n") + "\n";
  const real = fs.existsSync(STORE) && fs.lstatSync(STORE).isSymbolicLink() ? fs.realpathSync(STORE) : STORE;
  const tmp = real + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, real);
  const check = parseEnvFile(fs.readFileSync(STORE, "utf8")).QUICKBOOKS_REFRESH_TOKEN;
  if (check !== token) throw new Error("Token store write could not be verified");
}
let refreshToken = startingRefreshToken();
let accessToken = "";
let accessExpires = 0;
async function refreshAccess() {
  const basic = Buffer.from(process.env.QUICKBOOKS_CLIENT_ID + ":" + process.env.QUICKBOOKS_CLIENT_SECRET).toString("base64");
  const r = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: { Authorization: "Basic " + basic, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`token refresh failed: HTTP ${r.status} ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  accessToken = j.access_token;
  accessExpires = Date.now() + (Number(j.expires_in || 3600) - 300) * 1000;
  if (j.refresh_token && j.refresh_token !== refreshToken) {
    refreshToken = j.refresh_token;
    log("token: refresh token rotated; saved sha " + sha(refreshToken).slice(0, 8));
  }
  persistRefreshToken(refreshToken);
}

// ---------- API ----------
let lastBatchAt = 0;
async function api(method, pathAndQuery, body, attempt = 0) {
  if (!accessToken || Date.now() > accessExpires) await refreshAccess();
  const url = BASE + pathAndQuery + (pathAndQuery.includes("?") ? "&" : "?") + MINOR;
  const r = await fetch(url, {
    method,
    headers: { Authorization: "Bearer " + accessToken, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (r.status === 401 && attempt < 1) { accessToken = ""; return api(method, pathAndQuery, body, attempt + 1); }
  if ((r.status === 429 || r.status >= 500) && attempt < 5) {
    const wait = r.status === 429 ? 65_000 : 5_000 * (attempt + 1);
    log(`api: HTTP ${r.status}, retrying in ${wait / 1000}s`);
    await sleep(wait);
    return api(method, pathAndQuery, body, attempt + 1);
  }
  if (!r.ok) throw new Error(`${method} ${pathAndQuery.slice(0, 80)} -> HTTP ${r.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}
async function query(sql) {
  const j = await api("GET", "/query?query=" + encodeURIComponent(sql));
  return j.QueryResponse || {};
}
async function queryAll(entity, where = "") {
  const out = [];
  for (let start = 1; ; start += 1000) {
    const qr = await query(`SELECT * FROM ${entity}${where ? " WHERE " + where : ""} STARTPOSITION ${start} MAXRESULTS 1000`);
    const rows = qr[entity] || [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
async function count(entity, where = "") {
  const qr = await query(`SELECT COUNT(*) FROM ${entity}${where ? " WHERE " + where : ""}`);
  return qr.totalCount ?? 0;
}
// Up to 30 operations per call; paced to stay under the sandbox batch limit.
async function batch(items) {
  const results = {};
  for (let i = 0; i < items.length; i += 30) {
    const chunk = items.slice(i, i + 30);
    const wait = 1700 - (Date.now() - lastBatchAt);
    if (wait > 0) await sleep(wait);
    lastBatchAt = Date.now();
    const j = await api("POST", "/batch", { BatchItemRequest: chunk });
    for (const r of j.BatchItemResponse || []) results[r.bId] = r;
    for (const it of chunk) if (!results[it.bId]) results[it.bId] = { Fault: { Error: [{ Message: "no response for item" }] } };
  }
  return results;
}
const faultText = (r) => (r.Fault?.Error || []).map((e) => `${e.code || ""} ${e.Message || ""} ${e.Detail || ""}`.trim()).join("; ");
const entityOf = (r) => Object.entries(r).find(([k, v]) => k !== "bId" && k !== "Fault" && v && typeof v === "object")?.[1];

// ---------- state ----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { ids: {} }; }
}
function saveState(s) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, STATE_FILE);
}

async function companyGuard() {
  const ci = (await query("SELECT * FROM CompanyInfo")).CompanyInfo?.[0];
  if (!ci || !ALLOWED_COMPANIES.includes(ci.CompanyName)) throw new Error("Refusing to run: unexpected company " + (ci && ci.CompanyName));
  return ci;
}

// ---------- dataset ----------
async function loadDataset() {
  const url = process.env.SEED_DATA_URL, want = process.env.SEED_DATA_SHA256;
  if (!url || !want) throw new Error("SEED_DATA_URL and SEED_DATA_SHA256 are required for this mode");
  const r = await fetch(url);
  if (!r.ok) throw new Error("dataset download failed " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (sha(buf) !== want) throw new Error("dataset checksum mismatch");
  const d = JSON.parse(buf.toString("utf8"));
  log(`dataset ${d.meta.version}: ${d.invoices.length} invoices, ${d.payments.length} payments, ${d.bills.length} bills, ${d.billPayments.length} bill payments, ${d.purchases.length} purchases, ${d.journals.length} journal entries`);
  return d;
}

// ---------- modes ----------
const TXN_TYPES = ["Deposit", "Payment", "RefundReceipt", "SalesReceipt", "CreditMemo", "Invoice", "Estimate", "BillPayment", "VendorCredit", "Bill", "Purchase", "PurchaseOrder", "Transfer", "JournalEntry", "TimeActivity"];

async function probe() {
  const ci = await companyGuard();
  log("company", { name: ci.CompanyName, legal: ci.LegalName, country: ci.Country, fiscalStart: ci.FiscalYearStartMonth, email: ci.Email?.Address ? "set" : "none" });
  const p = (await query("SELECT * FROM Preferences")).Preferences?.[0] || {};
  log("prefs", {
    customTxnNumbers: p.SalesFormsPrefs?.CustomTxnNumbers, multiCurrency: p.CurrencyPrefs?.MultiCurrencyEnabled,
    usingSalesTax: p.TaxPrefs?.UsingSalesTax, partnerTax: p.TaxPrefs?.PartnerTaxEnabled, trackDepartments: p.AccountingInfoPrefs?.TrackDepartments,
    classTracking: p.AccountingInfoPrefs?.ClassTrackingPerTxn, qtyOnHand: p.ProductAndServicesPrefs?.QuantityOnHand,
    bookClose: p.AccountingInfoPrefs?.BookCloseDate || null, defaultTerms: p.SalesFormsPrefs?.DefaultTerms, autoApply: p.SalesFormsPrefs?.AutoApplyCredit,
  });
  for (const t of [...TXN_TYPES, "Customer", "Vendor", "Item", "Account", "Term", "Employee", "Class", "Department", "PaymentMethod", "TaxCode"]) {
    try { log("count", t, await count(t)); } catch (e) { log("count", t, "ERR " + String(e.message).slice(0, 120)); }
  }
  for (const a of await queryAll("Account", "Active IN (true, false)")) {
    log("acct", [a.Id, a.FullyQualifiedName, a.AccountType, a.AccountSubType, a.Classification, a.CurrentBalance, a.Active, a.SubAccount ? a.ParentRef?.value : ""].join("|"));
  }
  for (const t of await queryAll("Term")) log("term", [t.Id, t.Name, t.Type, t.DueDays, t.Active].join("|"));
  for (const i of await queryAll("Item")) log("item", [i.Id, i.Name, i.Type, i.Active, i.QtyOnHand ?? "", i.IncomeAccountRef?.name || "", i.Taxable].join("|"));
  for (const m of await queryAll("PaymentMethod")) log("paymethod", [m.Id, m.Name, m.Type].join("|"));
  for (const t of await queryAll("TaxCode")) log("taxcode", [t.Id, t.Name, t.Taxable, t.Active].join("|"));
}

async function cleanup() {
  await companyGuard();
  const state = loadState();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const backupFile = path.join(STATE_DIR, "intuit-sample-backup.json");
  if (!fs.existsSync(backupFile)) {
    const backup = { takenAt: new Date().toISOString(), realm: REALM, entities: {} };
    for (const t of [...TXN_TYPES, "Customer", "Vendor", "Item", "Account", "CompanyInfo"]) backup.entities[t] = await queryAll(t, ["Customer", "Vendor", "Item", "Account"].includes(t) ? "Active IN (true, false)" : "");
    fs.writeFileSync(backupFile, JSON.stringify(backup));
    log("backup written", Object.fromEntries(Object.entries(backup.entities).map(([k, v]) => [k, v.length])), "bytes " + fs.statSync(backupFile).size);
  } else log("backup already present; not overwritten");
  for (let pass = 1; pass <= 3; pass++) {
    let remaining = 0;
    for (const t of TXN_TYPES) {
      const rows = await queryAll(t);
      if (!rows.length) continue;
      const res = await batch(rows.map((r) => ({ bId: `${t}-${r.Id}`, operation: "delete", [t]: { Id: r.Id, SyncToken: r.SyncToken } })));
      const bad = Object.values(res).filter((r) => r.Fault);
      log(`delete pass ${pass} ${t}: ${rows.length - bad.length} deleted, ${bad.length} failed`);
      for (const b of bad.slice(0, 3)) log("  fault", b.bId, faultText(b));
      remaining += bad.length;
    }
    if (!remaining) break;
  }
  for (const t of TXN_TYPES) { const n = await count(t); if (n) log("left after cleanup", t, n); }
  // Make Intuit's sample names inactive (jobs before their parent customers).
  const deactivate = async (entity, rows) => {
    if (!rows.length) return;
    const res = await batch(rows.map((r) => ({ bId: `${entity}-${r.Id}`, operation: "update", [entity]: { Id: r.Id, SyncToken: r.SyncToken, sparse: true, Active: false } })));
    const bad = Object.values(res).filter((r) => r.Fault);
    log(`inactivate ${entity}: ${rows.length - bad.length} done, ${bad.length} failed`);
    for (const b of bad.slice(0, 5)) log("  fault", b.bId, faultText(b));
  };
  const customers = await queryAll("Customer", "Active = true");
  await deactivate("Customer", customers.filter((c) => c.Job || c.ParentRef));
  await deactivate("Customer", (await queryAll("Customer", "Active = true")));
  await deactivate("Vendor", await queryAll("Vendor", "Active = true"));
  await deactivate("Item", (await queryAll("Item", "Active = true")).filter((i) => i.Type !== "Category"));
  state.cleanupDoneAt = new Date().toISOString();
  saveState(state);
}

// Resolve "Parent:Child" account names to ids, creating what is missing.
async function ensureAccounts(d, state) {
  const all = await queryAll("Account", "Active IN (true, false)");
  const byName = new Map(all.map((a) => [a.FullyQualifiedName, a]));
  for (const ren of d.accounts.rename || []) {
    const a = byName.get(ren.from);
    if (a && !byName.has(ren.to)) {
      const r = await api("POST", "/account", { Id: a.Id, SyncToken: a.SyncToken, sparse: true, Name: ren.to.split(":").pop(), Active: true, ...(ren.subType ? { AccountSubType: ren.subType } : {}) });
      byName.delete(ren.from); byName.set(r.Account.FullyQualifiedName, r.Account);
      log("account renamed", ren.from, "->", r.Account.FullyQualifiedName);
    }
  }
  for (const spec of d.accounts.create) {
    const existing = byName.get(spec.name);
    if (existing) {
      if (!existing.Active) {
        const r = await api("POST", "/account", { Id: existing.Id, SyncToken: existing.SyncToken, sparse: true, Active: true });
        byName.set(spec.name, r.Account);
      }
      continue;
    }
    const parts = spec.name.split(":");
    const body = { Name: parts.pop(), AccountType: spec.type, AccountSubType: spec.subType };
    if (parts.length) {
      const parent = byName.get(parts.join(":"));
      if (!parent) throw new Error("parent account missing for " + spec.name);
      body.SubAccount = true; body.ParentRef = { value: parent.Id };
    }
    const r = await api("POST", "/account", body);
    byName.set(r.Account.FullyQualifiedName, r.Account);
    log("account created", r.Account.FullyQualifiedName, r.Account.Id);
  }
  // Make the sample-only accounts inactive (children first). Accounts that still
  // hold a balance are zeroed by the opening entry and handled in the load step.
  const toHide = (d.accounts.deactivate || []).map((n) => byName.get(n)).filter((a) => a && a.Active).sort((a, b) => b.FullyQualifiedName.split(":").length - a.FullyQualifiedName.split(":").length);
  for (const a of toHide) {
    if (Math.abs(Number(a.CurrentBalance || 0)) > 0.004) { log("account kept active for now (has balance)", a.FullyQualifiedName, a.CurrentBalance); continue; }
    try {
      const fresh = (await api("GET", `/account/${a.Id}`)).Account;
      await api("POST", "/account", { Id: fresh.Id, SyncToken: fresh.SyncToken, sparse: true, Active: false });
    } catch (e) { log("account inactivate failed", a.FullyQualifiedName, String(e.message).slice(0, 200)); }
  }
  state.accounts = Object.fromEntries([...byName].map(([k, v]) => [k, v.Id]));
}

async function createAll(kind, entity, rows, toBody, state) {
  state.ids[kind] ||= {};
  const todo = rows.filter((r) => !state.ids[kind][r.key]);
  for (let i = 0; i < todo.length; i += 30) {
    if (timeLeft() < 60_000) { log(`time budget reached during ${kind}; will resume`); return false; }
    const chunk = todo.slice(i, i + 30);
    const res = await batch(chunk.map((r) => ({ bId: r.key, operation: "create", [entity]: toBody(r) })));
    let bad = 0;
    for (const r of chunk) {
      const out = res[r.key];
      const ent = out && entityOf(out);
      if (out && !out.Fault && ent?.Id) state.ids[kind][r.key] = ent.Id;
      else { bad++; if (bad <= 5) log(`create ${kind} ${r.key} failed: ${out ? faultText(out) : "no response"}`); }
    }
    saveState(state);
    if (bad) throw new Error(`${bad} ${kind} failed in one batch; stopping so nothing is half-loaded`);
  }
  log(`${kind}: ${Object.keys(state.ids[kind]).length} of ${rows.length} created`);
  return true;
}

async function setup() {
  const ci = await companyGuard();
  const d = await loadDataset();
  const state = loadState();
  if (!state.cleanupDoneAt) throw new Error("Run cleanup first");
  if (ci.CompanyName !== d.company.name) {
    const body = { Id: ci.Id, SyncToken: ci.SyncToken, sparse: true, CompanyName: d.company.name, LegalName: d.company.legalName,
      CompanyAddr: d.company.address, LegalAddr: d.company.address, CustomerCommunicationAddr: d.company.address,
      PrimaryPhone: { FreeFormNumber: d.company.phone }, Email: { Address: d.company.email }, CustomerCommunicationEmailAddr: { Address: d.company.email },
      WebAddr: { URI: d.company.web } };
    const r = await api("POST", "/companyinfo", body);
    log("company renamed to", r.CompanyInfo.CompanyName);
  }
  await ensureAccounts(d, state);
  saveState(state);
  const A = (name) => { const id = state.accounts[name]; if (!id) throw new Error("account not found: " + name); return { value: id }; };
  const terms = await queryAll("Term", "Active IN (true, false)");
  state.terms = {};
  for (const t of d.terms) {
    let term = terms.find((x) => x.Name === t.name);
    if (!term) term = (await api("POST", "/term", { Name: t.name, DueDays: t.dueDays })).Term;
    else if (!term.Active) term = (await api("POST", "/term", { Id: term.Id, SyncToken: term.SyncToken, sparse: true, Active: true })).Term;
    state.terms[t.name] = term.Id;
  }
  saveState(state);
  await createAll("items", "Item", d.items, (it) => ({
    Name: it.name, Sku: it.sku || undefined, Description: it.desc, Type: it.type, IncomeAccountRef: A(it.incomeAccount),
    ...(it.expenseAccount ? { ExpenseAccountRef: A(it.expenseAccount), PurchaseDesc: it.desc } : {}), UnitPrice: it.price ?? 0, Taxable: false,
  }), state);
  const addr = (a) => ({ Line1: a.line1, City: a.city, CountrySubDivisionCode: a.state, PostalCode: a.zip, Country: "USA" });
  await createAll("customers", "Customer", d.customers, (c) => ({
    DisplayName: c.name, CompanyName: c.name, GivenName: c.contact.given, FamilyName: c.contact.family, Title: undefined,
    PrimaryEmailAddr: { Address: c.email }, PrimaryPhone: { FreeFormNumber: c.phone }, BillAddr: addr(c.address), ShipAddr: addr(c.address),
    SalesTermRef: { value: state.terms[c.terms] }, Notes: c.notes, Taxable: false, ResaleNum: c.exemptionNo,
  }), state);
  await createAll("vendors", "Vendor", d.vendors, (v) => ({
    DisplayName: v.name, CompanyName: v.name, PrimaryEmailAddr: v.email ? { Address: v.email } : undefined, PrimaryPhone: v.phone ? { FreeFormNumber: v.phone } : undefined,
    BillAddr: v.address ? addr(v.address) : undefined, TermRef: v.terms ? { value: state.terms[v.terms] } : undefined, AcctNum: v.accountNo || undefined,
  }), state);
  state.setupDoneAt = new Date().toISOString();
  saveState(state);
}

async function load() {
  await companyGuard();
  const d = await loadDataset();
  const state = loadState();
  if (!state.setupDoneAt) throw new Error("Run setup first");
  const A = (name) => { const id = state.accounts[name]; if (!id) throw new Error("account not found: " + name); return { value: id }; };
  const ID = (kind, key) => { const id = state.ids[kind]?.[key]; if (!id) throw new Error(`${kind} id missing for ${key}`); return id; };
  const money = (n) => Math.round(n * 100) / 100;

  // Opening entry: moves every account from what is left after the cleanup to
  // the dataset's opening balance, so leftovers from the sample data net to zero.
  if (!state.ids.opening) {
    const all = await queryAll("Account", "Active IN (true, false)");
    const target = d.opening.balances; // debit-positive, by full name
    const lines = [];
    const touched = new Set();
    for (const a of all) {
      if (["Accounts Receivable", "Accounts Payable"].includes(a.AccountType)) {
        if (Math.abs(Number(a.CurrentBalance || 0)) > 0.004) throw new Error("A/R or A/P not empty after cleanup: " + a.FullyQualifiedName);
        continue;
      }
      if (!["Bank", "Other Current Asset", "Fixed Asset", "Other Asset", "Credit Card", "Other Current Liability", "Long Term Liability", "Equity"].includes(a.AccountType)) continue;
      const have = money(Number(a.CurrentBalance || 0));
      const want = money(target[a.FullyQualifiedName] ?? 0);
      touched.add(a.FullyQualifiedName);
      const delta = money(want - have);
      if (Math.abs(delta) < 0.005) continue;
      if (a.FullyQualifiedName === d.opening.plugAccount) continue;
      lines.push({ account: a.Id, name: a.FullyQualifiedName, delta });
    }
    for (const n of Object.keys(target)) if (!touched.has(n)) throw new Error("opening balance account not found: " + n);
    const sum = money(lines.reduce((s, l) => s + l.delta, 0));
    const plug = all.find((a) => a.FullyQualifiedName === d.opening.plugAccount);
    lines.push({ account: plug.Id, name: plug.FullyQualifiedName, delta: money(-sum) });
    const je = {
      TxnDate: d.opening.date, DocNumber: "OB-2024", PrivateNote: "Opening balances for Tallmark sample books (convor-seed)",
      Line: lines.filter((l) => Math.abs(l.delta) >= 0.005).map((l) => ({ DetailType: "JournalEntryLineDetail", Amount: Math.abs(l.delta), Description: "Opening balance",
        JournalEntryLineDetail: { PostingType: l.delta > 0 ? "Debit" : "Credit", AccountRef: { value: l.account } } })),
    };
    log("opening entry lines", lines.map((l) => `${l.name} ${l.delta}`).join(" | "));
    const r = await api("POST", "/journalentry", je);
    state.ids.opening = r.JournalEntry.Id;
    saveState(state);
    log("opening entry created", r.JournalEntry.Id);
  }

  const lineSales = (l) => ({ DetailType: "SalesItemLineDetail", Amount: l.amount, Description: l.desc,
    SalesItemLineDetail: { ItemRef: { value: ID("items", l.item) }, Qty: l.qty, UnitPrice: l.rate, TaxCodeRef: { value: "NON" } } });
  const lineExp = (l) => ({ DetailType: "AccountBasedExpenseLineDetail", Amount: l.amount, Description: l.desc || undefined,
    AccountBasedExpenseLineDetail: { AccountRef: A(l.account) } });
  const steps = [
    ["invoices", "Invoice", d.invoices, (x) => ({ CustomerRef: { value: ID("customers", x.customer) }, TxnDate: x.date, DueDate: x.due, DocNumber: x.doc,
      SalesTermRef: { value: state.terms[x.terms] }, CustomerMemo: x.memo ? { value: x.memo } : undefined, PrivateNote: x.po ? "Customer PO " + x.po : undefined,
      Line: x.lines.map(lineSales), BillEmail: x.email ? { Address: x.email } : undefined })],
    ["bills", "Bill", d.bills, (x) => ({ VendorRef: { value: ID("vendors", x.vendor) }, TxnDate: x.date, DueDate: x.due, DocNumber: x.doc || undefined,
      SalesTermRef: x.terms ? { value: state.terms[x.terms] } : undefined, PrivateNote: x.memo || undefined, Line: x.lines.map(lineExp) })],
    ["purchases", "Purchase", d.purchases, (x) => ({ PaymentType: x.payType, AccountRef: A(x.account), TxnDate: x.date, DocNumber: x.doc || undefined,
      EntityRef: x.vendor ? { value: ID("vendors", x.vendor), type: "Vendor" } : undefined, PrivateNote: x.memo || undefined, Line: x.lines.map(lineExp) })],
    ["journals", "JournalEntry", d.journals, (x) => ({ TxnDate: x.date, DocNumber: x.doc, PrivateNote: x.memo,
      Line: x.lines.map((l) => ({ DetailType: "JournalEntryLineDetail", Amount: l.amount, Description: l.desc,
        JournalEntryLineDetail: { PostingType: l.posting, AccountRef: A(l.account) } })) })],
    ["payments", "Payment", d.payments, (x) => ({ CustomerRef: { value: ID("customers", x.customer) }, TxnDate: x.date, TotalAmt: x.total,
      PaymentRefNum: x.ref, DepositToAccountRef: A(x.depositTo), Line: x.lines.map((l) => ({ Amount: l.amount, LinkedTxn: [{ TxnId: ID("invoices", l.invoice), TxnType: "Invoice" }] })) })],
    ["billPayments", "BillPayment", d.billPayments, (x) => ({ VendorRef: { value: ID("vendors", x.vendor) }, TxnDate: x.date, TotalAmt: x.total, PayType: "Check",
      DocNumber: x.doc || undefined, CheckPayment: { BankAccountRef: A(x.bank) },
      Line: x.lines.map((l) => ({ Amount: l.amount, LinkedTxn: [{ TxnId: ID("bills", l.bill), TxnType: "Bill" }] })) })],
  ];
  for (const [kind, entity, rows, toBody] of steps) {
    const done = await createAll(kind, entity, rows, toBody, state);
    if (!done) return;
  }
  state.loadDoneAt = new Date().toISOString();
  saveState(state);
  log("load complete");
}

async function report() {
  const ci = await companyGuard();
  log("company", ci.CompanyName);
  for (const t of TXN_TYPES) log("count", t, await count(t));
  for (const [label, q] of [["PL-2025", "start_date=2025-01-01&end_date=2025-12-31"], ["PL-2026YTD", "start_date=2026-01-01&end_date=2026-10-12"]]) {
    const rep = await api("GET", "/reports/ProfitAndLoss?accounting_method=Accrual&" + q);
    const tops = [];
    const walk = (rows) => { for (const r of rows || []) { if (r.Summary?.ColData) tops.push(r.Summary.ColData.map((c) => c.value).join("=")); if (r.Rows?.Row) walk(r.Rows.Row); } };
    walk(rep.Rows?.Row);
    log(label, tops.filter((t) => /^(Total Income|Total Cost of Goods Sold|Gross Profit|Total Expenses|Net Operating Income|Net Other Income|Net Income)=/.test(t)).join(" | "));
  }
  const bs = await api("GET", "/reports/BalanceSheet?accounting_method=Accrual&end_date=2026-10-12");
  const tops = [];
  const walk = (rows) => { for (const r of rows || []) { if (r.Summary?.ColData) tops.push(r.Summary.ColData.map((c) => c.value).join("=")); if (r.Rows?.Row) walk(r.Rows.Row); } };
  walk(bs.Rows?.Row);
  log("BS", tops.join(" | "));
}

try {
  log(`mode ${MODE} starting`);
  if (MODE === "probe") await probe();
  else if (MODE === "cleanup") await cleanup();
  else if (MODE === "setup") await setup();
  else if (MODE === "load") await load();
  else if (MODE === "report") await report();
  else throw new Error("unknown SEED_MODE " + MODE);
  log(`mode ${MODE} finished in ${Math.round((Date.now() - T0) / 1000)}s`);
} catch (e) {
  log("ERROR " + String((e && e.stack) || e).slice(0, 1500));
  process.exitCode = 1;
}
