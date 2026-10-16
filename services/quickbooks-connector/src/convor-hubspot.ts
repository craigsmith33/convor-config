// Convor addition (1.7): read-only HubSpot sales tools, plus two tools that
// join HubSpot (deals, activity) with QuickBooks (balances, sales).
//
// Every tool loads the records it needs from HubSpot at the moment it is
// called (no caching), does the sorting, date math and money math in code,
// and returns an answer-ready result. Nothing here writes to HubSpot or
// QuickBooks: only GET requests and HubSpot's read-only search/batch-read
// POST endpoints are used (see READ_ONLY_POSTS).
//
// Configuration (Railway variables on the connector service):
//   HUBSPOT_TOKEN              private app access token (read scopes only)
//   HUBSPOT_DATASET_PROPERTY   optional: only use records whose property ...
//   HUBSPOT_DATASET_VALUE      ... equals this value (demo: convor_demo_dataset = tallmark)
//   HUBSPOT_PIPELINE_ID        optional: only deals in this pipeline
//   HUBSPOT_PRODUCT_LINE_PROPERTY optional deal property holding a product line
//   HUBSPOT_API_BASE           optional, for tests only
import { z } from "zod";
import { toCents, money, pct, todayISO } from "./convor-answers.js";

// ---------------------------------------------------------------- settings

const TZ = process.env.CONVOR_TIMEZONE || "America/New_York";
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DEALS = 2000;

function cfg() {
  return {
    token: (process.env.HUBSPOT_TOKEN || "").trim(),
    base: (process.env.HUBSPOT_API_BASE || "https://api.hubapi.com").replace(/\/+$/, ""),
    dsProp: (process.env.HUBSPOT_DATASET_PROPERTY || "").trim(),
    dsValue: (process.env.HUBSPOT_DATASET_VALUE || "").trim(),
    pipeline: (process.env.HUBSPOT_PIPELINE_ID || "").trim(),
    lineProp: (process.env.HUBSPOT_PRODUCT_LINE_PROPERTY || "").trim(),
  };
}

export function hubspotConfigured(): boolean {
  const t = cfg().token;
  return t.length >= 20 && !/^(x+|changeme|placeholder|todo)$/i.test(t);
}

export function hubspotSecrets(): string[] {
  const t = cfg().token;
  return t.length >= 12 ? [t] : [];
}

// ---------------------------------------------------------------- dates

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
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function humanDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}
/** A HubSpot timestamp (ISO string or epoch ms) as a local calendar date. */
function localDate(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v);
  const ms = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  if (isNaN(ms)) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}
function monthStart(iso: string) { return iso.slice(0, 8) + "01"; }
function monthEnd(iso: string) {
  const [y, m] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function quarterStart(iso: string) {
  const [y, m] = iso.split("-").map(Number);
  const q = Math.floor((m - 1) / 3) * 3 + 1;
  return `${y}-${String(q).padStart(2, "0")}-01`;
}
function quarterEnd(iso: string) { return monthEnd(addDays(quarterStart(iso), 62)); }

// ---------------------------------------------------------------- HubSpot access (read-only)

const READ_ONLY_POSTS = [
  /^\/crm\/v3\/objects\/[a-z_0-9]+\/search$/,
  /^\/crm\/v3\/objects\/[a-z_0-9]+\/batch\/read$/,
  /^\/crm\/v4\/associations\/[a-z_0-9]+\/[a-z_0-9]+\/batch\/read$/,
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function hs(path: string, body?: any): Promise<any> {
  const c = cfg();
  if (!hubspotConfigured()) throw new Error("HubSpot is not connected yet: the HUBSPOT_TOKEN variable on the connector service is missing.");
  const method = body === undefined ? "GET" : "POST";
  if (method === "POST" && !READ_ONLY_POSTS.some((re) => re.test(path))) throw new Error("Refusing a non-read HubSpot request: " + path);
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(c.base + path, {
      method,
      headers: { Authorization: "Bearer " + c.token, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if ((r.status === 429 || r.status >= 500) && attempt < 3) {
      const wait = Number(r.headers.get("retry-after")) * 1000 || 1000 * (attempt + 1);
      await sleep(Math.min(wait, 10_000));
      continue;
    }
    const txt = await r.text();
    if (!r.ok) {
      if (r.status === 401) throw new Error("HubSpot rejected the access token (401). The private app token may have been deleted or rotated.");
      if (r.status === 403) throw new Error("HubSpot denied access (403): the private app is missing a read scope for " + path.split("/").slice(3, 5).join("/") + ". " + txt.slice(0, 200));
      throw new Error(`HubSpot ${r.status} on ${path}: ${txt.slice(0, 300)}`);
    }
    return txt ? JSON.parse(txt) : {};
  }
}

function datasetFilters(): any[] {
  const c = cfg();
  return c.dsProp && c.dsValue ? [{ propertyName: c.dsProp, operator: "EQ", value: c.dsValue }] : [];
}

async function searchAll(type: string, filters: any[], properties: string[], cap: number, query?: string): Promise<{ rows: any[]; truncated: boolean }> {
  const rows: any[] = [];
  let after: string | undefined;
  for (;;) {
    const body: any = { filterGroups: filters.length ? [{ filters }] : [], properties, limit: 200, sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }] };
    if (query) body.query = query;
    if (after) body.after = after;
    const r = await hs(`/crm/v3/objects/${type}/search`, body);
    rows.push(...(r.results || []));
    after = r.paging?.next?.after;
    if (!after) return { rows, truncated: false };
    if (rows.length >= cap) return { rows: rows.slice(0, cap), truncated: true };
  }
}

async function batchRead(type: string, ids: string[], properties: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += 100) {
    const r = await hs(`/crm/v3/objects/${type}/batch/read`, { inputs: uniq.slice(i, i + 100).map((id) => ({ id })), properties });
    for (const x of r.results || []) out.set(String(x.id), x);
  }
  return out;
}

async function assoc(from: string, to: string, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += 1000) {
    const r = await hs(`/crm/v4/associations/${from}/${to}/batch/read`, { inputs: uniq.slice(i, i + 1000).map((id) => ({ id })) });
    for (const x of r.results || []) {
      const k = String(x.from?.id);
      const list = out.get(k) || [];
      for (const t of x.to || []) list.push(String(t.toObjectId));
      out.set(k, [...new Set(list)]);
    }
  }
  return out;
}

// ---------------------------------------------------------------- model

type Stage = { id: string; label: string; order: number; isClosed: boolean; won: boolean; lost: boolean; probability: number | null };
type Activity = { id: string; type: string; date: string | null; title: string; detail: string };
type Task = { id: string; subject: string; due: string | null; status: string; priority: string; open: boolean };
type Contact = { id: string; name: string; title: string | null; email: string | null; phone: string | null };
type Company = { id: string; name: string; city: string | null; state: string | null; domain: string | null; description: string | null };
type Deal = {
  id: string; name: string; amount: bigint; hasAmount: boolean; stage: Stage; pipeline: string; closeDate: string | null;
  nextStep: string | null; description: string | null; productLine: string | null;
  companyIds: string[]; contactIds: string[]; activities: Activity[]; tasks: Task[];
};

const STRIP = (s: unknown, max = 300): string => {
  const t = String(s ?? "").replace(/<br\s*\/?>/gi, " ").replace(/<\/p>/gi, " ").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

const ENGAGEMENTS: { type: string; props: string[]; read: (p: any) => { title: string; detail: string; when: unknown } }[] = [
  { type: "calls", props: ["hs_call_title", "hs_call_body", "hs_timestamp", "hs_call_direction"], read: (p) => ({ title: STRIP(p.hs_call_title, 120) || "Call", detail: STRIP(p.hs_call_body), when: p.hs_timestamp }) },
  { type: "emails", props: ["hs_email_subject", "hs_email_text", "hs_timestamp", "hs_email_direction"], read: (p) => ({ title: STRIP(p.hs_email_subject, 120) || "Email", detail: STRIP(p.hs_email_text), when: p.hs_timestamp }) },
  { type: "notes", props: ["hs_note_body", "hs_timestamp"], read: (p) => ({ title: "Note", detail: STRIP(p.hs_note_body), when: p.hs_timestamp }) },
  { type: "meetings", props: ["hs_meeting_title", "hs_meeting_body", "hs_meeting_start_time", "hs_timestamp"], read: (p) => ({ title: STRIP(p.hs_meeting_title, 120) || "Meeting", detail: STRIP(p.hs_meeting_body), when: p.hs_meeting_start_time || p.hs_timestamp }) },
];
const TYPE_LABEL: Record<string, string> = { calls: "call", emails: "email", notes: "note", meetings: "meeting" };

async function loadStages(): Promise<Map<string, Stage>> {
  const r = await hs("/crm/v3/pipelines/deals");
  const out = new Map<string, Stage>();
  for (const p of r.results || []) {
    for (const s of p.stages || []) {
      const isClosed = String(s.metadata?.isClosed) === "true";
      const prob = s.metadata?.probability !== undefined && s.metadata?.probability !== "" ? Number(s.metadata.probability) : null;
      out.set(String(s.id), {
        id: String(s.id), label: String(s.label), order: Number(s.displayOrder ?? 0), isClosed,
        won: isClosed && prob === 1, lost: isClosed && prob !== 1, probability: prob !== null && !isNaN(prob) ? prob : null,
      });
    }
  }
  return out;
}

async function optionLabels(prop: string): Promise<Map<string, string>> {
  try {
    const r = await hs(`/crm/v3/properties/deals/${encodeURIComponent(prop)}`);
    return new Map((r.options || []).map((o: any) => [String(o.value), String(o.label)]));
  } catch { return new Map(); }
}

const DEAL_PROPS = ["dealname", "amount", "dealstage", "pipeline", "closedate", "hs_next_step", "description"];

/** Loads deals in scope with their stage, companies, contacts, activities and tasks. */
async function loadDeals(opts: { companyIds?: string[] } = {}): Promise<{ deals: Deal[]; companies: Map<string, Company>; contacts: Map<string, Contact>; truncated: boolean }> {
  const c = cfg();
  const filters = [...datasetFilters()];
  if (c.pipeline) filters.push({ propertyName: "pipeline", operator: "EQ", value: c.pipeline });
  const props = [...DEAL_PROPS, ...(c.lineProp ? [c.lineProp] : [])];
  const [stages, found, lineLabels] = await Promise.all([loadStages(), searchAll("deals", filters, props, MAX_DEALS), c.lineProp ? optionLabels(c.lineProp) : Promise.resolve(new Map<string, string>())]);
  let rows = found.rows;
  let ids = rows.map((d) => String(d.id));
  const [dc, dk] = await Promise.all([assoc("deals", "companies", ids), assoc("deals", "contacts", ids)]);
  if (opts.companyIds) {
    const want = new Set(opts.companyIds);
    rows = rows.filter((d) => (dc.get(String(d.id)) || []).some((x) => want.has(x)));
    ids = rows.map((d) => String(d.id));
  }
  const engAssoc = await Promise.all([...ENGAGEMENTS.map((e) => e.type), "tasks"].map((t) => assoc("deals", t, ids)));
  const engObjs = await Promise.all(ENGAGEMENTS.map((e, i) => batchRead(e.type, [...engAssoc[i].values()].flat(), e.props)));
  const taskObjs = await batchRead("tasks", [...engAssoc[ENGAGEMENTS.length].values()].flat(), ["hs_task_subject", "hs_timestamp", "hs_task_status", "hs_task_priority"]);
  const companyIds = [...new Set([...dc.values()].flat())];
  const contactIds = [...new Set([...dk.values()].flat())];
  const [co, ct] = await Promise.all([
    batchRead("companies", companyIds, ["name", "city", "state", "domain", "description"]),
    batchRead("contacts", contactIds, ["firstname", "lastname", "jobtitle", "email", "phone"]),
  ]);
  const companies = new Map<string, Company>();
  for (const [id, x] of co) companies.set(id, { id, name: STRIP(x.properties?.name, 200) || "(no name)", city: x.properties?.city || null, state: x.properties?.state || null, domain: x.properties?.domain || null, description: x.properties?.description ? STRIP(x.properties.description) : null });
  const contacts = new Map<string, Contact>();
  for (const [id, x] of ct) {
    const p = x.properties || {};
    contacts.set(id, { id, name: [p.firstname, p.lastname].filter(Boolean).join(" ") || p.email || "(no name)", title: p.jobtitle || null, email: p.email || null, phone: p.phone || null });
  }
  const unknownStage = (id: string): Stage => ({ id, label: id || "(no stage)", order: 999, isClosed: false, won: false, lost: false, probability: null });
  const deals: Deal[] = rows.map((d) => {
    const p = d.properties || {};
    const id = String(d.id);
    const activities: Activity[] = [];
    ENGAGEMENTS.forEach((e, i) => {
      for (const eid of engAssoc[i].get(id) || []) {
        const o = engObjs[i].get(eid);
        if (!o) continue;
        const v = e.read(o.properties || {});
        activities.push({ id: eid, type: TYPE_LABEL[e.type], date: localDate(v.when), title: v.title, detail: v.detail });
      }
    });
    activities.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const tasks: Task[] = [];
    for (const tid of engAssoc[ENGAGEMENTS.length].get(id) || []) {
      const o = taskObjs.get(tid);
      if (!o) continue;
      const q = o.properties || {};
      const status = String(q.hs_task_status || "NOT_STARTED");
      tasks.push({ id: tid, subject: STRIP(q.hs_task_subject, 200) || "(no subject)", due: localDate(q.hs_timestamp), status, priority: String(q.hs_task_priority || "NONE"), open: status !== "COMPLETED" });
    }
    const hasAmount = p.amount !== undefined && p.amount !== null && String(p.amount).trim() !== "";
    return {
      id, name: STRIP(p.dealname, 200) || "(no name)", amount: hasAmount ? toCents(p.amount) : 0n, hasAmount,
      stage: stages.get(String(p.dealstage)) || unknownStage(String(p.dealstage || "")), pipeline: String(p.pipeline || ""),
      closeDate: localDate(p.closedate), nextStep: p.hs_next_step ? STRIP(p.hs_next_step, 200) : null,
      description: p.description ? STRIP(p.description) : null, productLine: c.lineProp && p[c.lineProp] ? String(p[c.lineProp]).split(";").map((v) => lineLabels.get(v) || LINE_LABEL(v)).join(", ") : null,
      companyIds: dc.get(id) || [], contactIds: dk.get(id) || [], activities, tasks,
    };
  });
  return { deals, companies, contacts, truncated: found.truncated };
}

// ---------------------------------------------------------------- helpers

const byAmountDesc = (a: Deal, b: Deal) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : a.name.localeCompare(b.name));
const sum = (l: Deal[]) => l.reduce((s, d) => s + d.amount, 0n);

/** amount * probability, rounded to the cent (probability to 4 decimals). */
function weighted(d: Deal): bigint | null {
  if (d.stage.probability === null) return null;
  const p = BigInt(Math.round(d.stage.probability * 10000));
  return (d.amount * p * 2n + 10000n) / 20000n;
}

function companyName(d: Deal, companies: Map<string, Company>): string | null {
  const names = d.companyIds.map((id) => companies.get(id)?.name).filter(Boolean) as string[];
  return names.length ? names.join(", ") : null;
}

function primaryContact(d: Deal, contacts: Map<string, Contact>) {
  const c = d.contactIds.map((id) => contacts.get(id)).find(Boolean);
  return c ? { name: c.name, title: c.title, email: c.email } : null;
}

function lastActivity(d: Deal, today: string): Activity | null {
  return d.activities.find((a) => a.date !== null && a.date <= today) || null;
}

function dealLine(d: Deal, companies: Map<string, Company>, today: string, extra: any = {}) {
  const last = lastActivity(d, today);
  return {
    deal: d.name,
    company: companyName(d, companies),
    amount: d.hasAmount ? money(d.amount) : null,
    stage: d.stage.label,
    closeDate: d.closeDate,
    ...(d.nextStep ? { nextStep: d.nextStep } : {}),
    lastActivity: last ? { date: last.date, daysAgo: dayNumber(today) - dayNumber(last.date!), type: last.type, summary: last.title === "Note" ? last.detail : `${last.title}: ${last.detail}`.replace(/: $/, "") } : null,
    ...extra,
  };
}

function text(obj: any) { return { content: [{ type: "text" as const, text: JSON.stringify(obj) }] }; }
function fail(e: any) { return { isError: true, content: [{ type: "text" as const, text: "Error: " + (e?.message || String(e)) }] }; }
function scopeNote(truncated: boolean) {
  const c = cfg();
  const parts: string[] = [];
  if (c.dsProp && c.dsValue) parts.push(`Only records tagged ${c.dsProp} = ${c.dsValue} are included.`);
  if (c.pipeline) parts.push(`Only deals in pipeline ${c.pipeline} are included.`);
  if (truncated) parts.push(`Only the first ${MAX_DEALS} deals were read; totals may be incomplete.`);
  return parts.join(" ");
}
const norm = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\b(inc|llc|co|corp|corporation|company|ltd)\b/g, " ").replace(/\s+/g, " ").trim();
const dollars = (c: bigint) => { const m = money(c); const neg = m.startsWith("-"); const [w, f] = (neg ? m.slice(1) : m).split("."); return (neg ? "-$" : "$") + w.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + f; };
const LINE_LABEL = (v: string | null) => (v ? v.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()) : "Not set");

// ---------------------------------------------------------------- QuickBooks side (injected)

export type QbInvoice = { customer: string; customerId: string | null; invoice: string | null; date: string; due: string; total: bigint; balance: bigint };
export type QbCustomer = { id: string; name: string; balance: bigint; email: string | null; terms: string | null };
export interface QbSide {
  openInvoices(): Promise<QbInvoice[]>;
  findCustomer(name: string): Promise<QbCustomer | null>;
  customerSales(customerId: string, start: string, end: string): Promise<bigint>;
}

function invoicesFor(name: string, invs: QbInvoice[]): QbInvoice[] {
  const n = norm(name);
  return invs.filter((i) => norm(String(i.customer).split(":")[0]) === n);
}

function balanceSummary(invs: QbInvoice[], today: string) {
  const t = dayNumber(today);
  const rows = invs.map((i) => ({ ...i, daysPastDue: Math.max(t - dayNumber(i.due), 0) }));
  const past = rows.filter((r) => r.daysPastDue > 0);
  const owed = rows.reduce((s, r) => s + r.balance, 0n);
  const pastDue = past.reduce((s, r) => s + r.balance, 0n);
  const over60 = past.filter((r) => r.daysPastDue > 60).reduce((s, r) => s + r.balance, 0n);
  return {
    owed, pastDue, over60, oldestDaysPastDue: past.length ? Math.max(...past.map((r) => r.daysPastDue)) : 0,
    openInvoices: rows.length, pastDueInvoices: past.length,
    list: rows.sort((a, b) => b.daysPastDue - a.daysPastDue || (b.balance > a.balance ? 1 : -1)).map((r) => ({
      invoice: r.invoice, date: r.date, dueDate: r.due, balance: money(r.balance), daysPastDue: r.daysPastDue,
    })),
  };
}

// ---------------------------------------------------------------- tools

const asOfSchema = z.string().optional().describe("Treat this date as today (YYYY-MM-DD). Leave empty for today.");

// 1. Pipeline
const pipelineSchema = z.object({ as_of: asOfSchema });

async function pipeline(params: any) {
  const today = checkDate(params?.as_of, "as_of") || todayISO();
  const { deals, companies, truncated } = await loadDeals();
  const open = deals.filter((d) => !d.stage.isClosed);
  const stageList = [...new Map(deals.map((d) => [d.stage.id, d.stage])).values()].sort((a, b) => a.order - b.order);
  const w = (l: Deal[]) => { const ws = l.map(weighted); return ws.some((x) => x === null) ? null : money(ws.reduce((s, x) => s + (x as bigint), 0n)); };
  const byStage = stageList.filter((s) => !s.isClosed).map((s) => {
    const l = open.filter((d) => d.stage.id === s.id).sort(byAmountDesc);
    return { stage: s.label, ...(s.probability !== null ? { probabilityPercent: Math.round(s.probability * 100) } : {}), deals: l.length, value: money(sum(l)), weightedValue: w(l), dealList: l.map((d) => ({ deal: d.name, company: companyName(d, companies), amount: d.hasAmount ? money(d.amount) : null, closeDate: d.closeDate })) };
  });
  const lines = new Map<string, Deal[]>();
  if (cfg().lineProp) for (const d of open) { const k = d.productLine || "Not set"; lines.set(k, [...(lines.get(k) || []), d]); }
  const closedIn = (start: string, end: string) => {
    const inR = deals.filter((d) => d.stage.isClosed && d.closeDate && d.closeDate >= start && d.closeDate <= end);
    const won = inR.filter((d) => d.stage.won), lost = inR.filter((d) => d.stage.lost);
    return {
      period: `${humanDate(start)} to ${humanDate(end)}`,
      won: { deals: won.length, value: money(sum(won)), list: won.sort(byAmountDesc).map((d) => ({ deal: d.name, company: companyName(d, companies), amount: money(d.amount), closeDate: d.closeDate })) },
      lost: { deals: lost.length, value: money(sum(lost)), list: lost.sort(byAmountDesc).map((d) => ({ deal: d.name, company: companyName(d, companies), amount: money(d.amount), closeDate: d.closeDate, reason: d.activities.find((a) => /\blost\b/i.test(a.detail))?.detail || d.description || null })) },
      winRateByCountPercent: pct(BigInt(won.length), BigInt(won.length + lost.length)),
      winRateByValuePercent: pct(sum(won), sum(won) + sum(lost)),
    };
  };
  const ms = monthStart(today), me = monthEnd(today);
  const closingThisMonth = open.filter((d) => d.closeDate && d.closeDate >= ms && d.closeDate <= me);
  const pastClose = open.filter((d) => d.closeDate && d.closeDate < today);
  const noAmount = open.filter((d) => !d.hasAmount);
  return text({
    asOf: today,
    openPipeline: { deals: open.length, value: money(sum(open)), weightedValue: w(open), averageDealSize: open.length ? money(sum(open) / BigInt(open.length)) : null },
    byStage,
    ...(lines.size ? { byProductLine: [...lines.entries()].map(([k, l]) => ({ productLine: k, deals: l.length, value: money(sum(l)) })).sort((a, b) => Number(toCents(b.value) - toCents(a.value))) } : {}),
    largestOpenDeals: open.slice().sort(byAmountDesc).slice(0, 5).map((d) => dealLine(d, companies, today)),
    expectedToCloseThisMonth: { period: `${humanDate(ms)} to ${humanDate(me)}`, deals: closingThisMonth.length, value: money(sum(closingThisMonth)) },
    openDealsPastCloseDate: { deals: pastClose.length, value: money(sum(pastClose)), list: pastClose.sort(byAmountDesc).map((d) => ({ deal: d.name, company: companyName(d, companies), amount: money(d.amount), closeDate: d.closeDate, daysPastCloseDate: dayNumber(today) - dayNumber(d.closeDate!) })) },
    closedThisMonth: closedIn(ms, me < today ? me : today),
    closedQuarterToDate: closedIn(quarterStart(today), today),
    closedYearToDate: closedIn(today.slice(0, 4) + "-01-01", today),
    ...(noAmount.length ? { openDealsWithNoAmount: noAmount.map((d) => d.name) } : {}),
    note: "Live from HubSpot; totals, weighting (amount x stage probability) and sorting computed exactly by the connector. Use these figures as given. " + scopeNote(truncated),
  });
}

export const GetSalesPipelineTool = {
  name: "get_sales_pipeline",
  description:
    "Sales pipeline overview from HubSpot, live, in one call: open deals by stage (count, value, weighted value, each deal), " +
    "by product line, the largest open deals with their last activity, what is expected to close this month, open deals already past their close date, " +
    "and deals won and lost this month, quarter to date and year to date with win rates. Use for any pipeline, forecast, or win/loss question.",
  schema: pipelineSchema,
  handler: async ({ params }: any) => { try { return await pipeline(params); } catch (e) { return fail(e); } },
};

// 2. Deals closing in a period
const closingSchema = z.object({
  period: z.enum(["this_month", "next_month", "this_quarter", "next_quarter", "next_30_days", "next_90_days"]).optional().describe("Which period (default this_month). Ignored if start_date and end_date are given."),
  start_date: z.string().optional().describe("Start of a custom period (YYYY-MM-DD)"),
  end_date: z.string().optional().describe("End of a custom period (YYYY-MM-DD)"),
  as_of: asOfSchema,
});

function periodRange(params: any, today: string): [string, string, string] {
  const s = checkDate(params?.start_date, "start_date"), e = checkDate(params?.end_date, "end_date");
  if (s && e) { if (e < s) throw new Error("end_date is before start_date"); return [s, e, "custom"]; }
  if (s || e) throw new Error("give both start_date and end_date, or neither");
  const p = params?.period || "this_month";
  if (p === "this_month") return [monthStart(today), monthEnd(today), p];
  if (p === "next_month") { const n = addDays(monthEnd(today), 1); return [n, monthEnd(n), p]; }
  if (p === "this_quarter") return [quarterStart(today), quarterEnd(today), p];
  if (p === "next_quarter") { const n = addDays(quarterEnd(today), 1); return [n, quarterEnd(n), p]; }
  if (p === "next_30_days") return [today, addDays(today, 30), p];
  return [today, addDays(today, 90), p];
}

async function closing(params: any) {
  const today = checkDate(params?.as_of, "as_of") || todayISO();
  const [start, end, label] = periodRange(params, today);
  const { deals, companies, contacts, truncated } = await loadDeals();
  const inRange = (d: Deal) => !!d.closeDate && d.closeDate >= start && d.closeDate <= end;
  const open = deals.filter((d) => !d.stage.isClosed && inRange(d)).sort((a, b) => String(a.closeDate).localeCompare(String(b.closeDate)) || byAmountDesc(a, b));
  const won = deals.filter((d) => d.stage.won && inRange(d)).sort(byAmountDesc);
  const lost = deals.filter((d) => d.stage.lost && inRange(d)).sort(byAmountDesc);
  const past = deals.filter((d) => !d.stage.isClosed && d.closeDate && d.closeDate < today && !inRange(d)).sort(byAmountDesc);
  const ws = open.map(weighted);
  return text({
    asOf: today,
    period: `${humanDate(start)} to ${humanDate(end)}`,
    periodName: label,
    stillOpen: {
      deals: open.length, value: money(sum(open)), weightedValue: ws.some((x) => x === null) ? null : money(ws.reduce((s, x) => s + (x as bigint), 0n)),
      list: open.map((d) => dealLine(d, companies, today, {
        contact: primaryContact(d, contacts),
        ...(d.closeDate! < today ? { closeDatePassed: true, daysPastCloseDate: dayNumber(today) - dayNumber(d.closeDate!) } : { daysUntilClose: dayNumber(d.closeDate!) - dayNumber(today) }),
        openTasks: d.tasks.filter((t) => t.open).map((t) => ({ task: t.subject, due: t.due, ...(t.due && t.due < today ? { overdue: true } : {}) })),
      })),
    },
    alreadyWon: { deals: won.length, value: money(sum(won)), list: won.map((d) => ({ deal: d.name, company: companyName(d, companies), amount: money(d.amount), closeDate: d.closeDate })) },
    alreadyLost: { deals: lost.length, value: money(sum(lost)), list: lost.map((d) => ({ deal: d.name, company: companyName(d, companies), amount: money(d.amount), closeDate: d.closeDate })) },
    openDealsWithCloseDateAlreadyPassedBeforeThisPeriod: past.map((d) => ({ deal: d.name, company: companyName(d, companies), amount: money(d.amount), stage: d.stage.label, closeDate: d.closeDate, daysPastCloseDate: dayNumber(today) - dayNumber(d.closeDate!) })),
    note: "Live from HubSpot by deal close date; stillOpen is sorted by close date. Computed exactly by the connector; use as given. " + scopeNote(truncated),
  });
}

export const GetDealsClosingTool = {
  name: "get_deals_closing",
  description:
    "Deals with a close date in a period (this month by default; also next month, this or next quarter, next 30 or 90 days, or custom dates), live from HubSpot: " +
    "deals still open (amount, stage, days until close, next step, last activity, contact, open tasks), deals already won or lost in the period, " +
    "and open deals whose close date has already passed. Use for 'what is closing this month', forecast and commit questions.",
  schema: closingSchema,
  handler: async ({ params }: any) => { try { return await closing(params); } catch (e) { return fail(e); } },
};

// 3. Deals needing attention
const attentionSchema = z.object({
  stale_days: z.number().int().min(1).max(365).optional().describe("A deal is stale with no call, email, note or meeting in this many days (default 14)"),
  as_of: asOfSchema,
});

async function attention(params: any) {
  const today = checkDate(params?.as_of, "as_of") || todayISO();
  const days = params?.stale_days ?? 14;
  const { deals, companies, contacts, truncated } = await loadDeals();
  const open = deals.filter((d) => !d.stage.isClosed);
  const t = dayNumber(today);
  const rows = open.map((d) => {
    const last = lastActivity(d, today);
    const since = last ? t - dayNumber(last.date!) : null;
    const overdueTasks = d.tasks.filter((x) => x.open && x.due && x.due < today);
    const reasons: string[] = [];
    if (since === null) reasons.push("no logged activity");
    else if (since > days) reasons.push(`no activity in ${since} days`);
    if (d.closeDate && d.closeDate < today) reasons.push(`close date passed ${t - dayNumber(d.closeDate)} days ago`);
    if (overdueTasks.length) reasons.push(`${overdueTasks.length} overdue follow-up task${overdueTasks.length > 1 ? "s" : ""}`);
    if (!d.nextStep) reasons.push("no next step recorded");
    return { d, since, overdueTasks, reasons };
  });
  const flagged = rows.filter((r) => r.reasons.length).sort((a, b) => b.reasons.length - a.reasons.length || byAmountDesc(a.d, b.d));
  const stale = rows.filter((r) => r.since === null || r.since > days);
  return text({
    asOf: today,
    staleRule: `No call, email, note or meeting logged in more than ${days} days`,
    openDeals: open.length,
    staleDeals: { deals: stale.length, value: money(sum(stale.map((r) => r.d))) },
    dealsNeedingAttention: flagged.map((r) => dealLine(r.d, companies, today, {
      reasons: r.reasons,
      contact: primaryContact(r.d, contacts),
      ...(r.overdueTasks.length ? { overdueTasks: r.overdueTasks.map((x) => ({ task: x.subject, due: x.due, daysOverdue: t - dayNumber(x.due!) })) } : {}),
    })),
    healthyOpenDeals: rows.filter((r) => !r.reasons.length).length,
    note: "Live from HubSpot. Already sorted: most reasons first, then largest amount. Last activity is computed from the calls, emails, notes and meetings logged on each deal. " + scopeNote(truncated),
  });
}

export const GetDealsNeedingAttentionTool = {
  name: "get_deals_needing_attention",
  description:
    "Open deals at risk, live from HubSpot, in one call: stale deals (no call, email, note or meeting in N days, default 14), deals past their close date, " +
    "deals with overdue follow-up tasks, and deals with no next step. Each deal shows the reasons, amount, stage, last activity and contact, already sorted by priority. " +
    "Use for 'which deals are stalling', 'what needs my attention', or pipeline hygiene.",
  schema: attentionSchema,
  handler: async ({ params }: any) => { try { return await attention(params); } catch (e) { return fail(e); } },
};

// 4. Follow-ups
const followSchema = z.object({
  days_ahead: z.number().int().min(0).max(60).optional().describe("Also list tasks due within this many days (default 7)"),
  as_of: asOfSchema,
});

async function followups(params: any) {
  const today = checkDate(params?.as_of, "as_of") || todayISO();
  const ahead = params?.days_ahead ?? 7;
  const { deals, companies, contacts, truncated } = await loadDeals();
  const t = dayNumber(today);
  const items: any[] = [];
  for (const d of deals) for (const x of d.tasks) if (x.open) items.push({ x, d });
  const fmt = ({ x, d }: any, extra: any) => ({ task: x.subject, due: x.due, priority: x.priority, deal: d.name, dealStage: d.stage.label, dealAmount: d.hasAmount ? money(d.amount) : null, company: companyName(d, companies), contact: primaryContact(d, contacts), ...extra });
  const overdue = items.filter((i) => i.x.due && i.x.due < today).sort((a, b) => a.x.due.localeCompare(b.x.due));
  const dueToday = items.filter((i) => i.x.due === today);
  const soon = items.filter((i) => i.x.due && i.x.due > today && dayNumber(i.x.due) - t <= ahead).sort((a, b) => a.x.due.localeCompare(b.x.due));
  const noDue = items.filter((i) => !i.x.due);
  return text({
    asOf: today,
    openTasks: items.length,
    overdue: { count: overdue.length, tasks: overdue.map((i) => fmt(i, { daysOverdue: t - dayNumber(i.x.due) })) },
    dueToday: { count: dueToday.length, tasks: dueToday.map((i) => fmt(i, {})) },
    dueSoon: { withinDays: ahead, count: soon.length, tasks: soon.map((i) => fmt(i, { daysUntilDue: dayNumber(i.x.due) - t })) },
    ...(noDue.length ? { noDueDate: noDue.map((i) => fmt(i, {})) } : {}),
    note: "Live HubSpot tasks linked to deals; overdue is oldest first. Use as given. " + scopeNote(truncated),
  });
}

export const GetSalesFollowupsTool = {
  name: "get_sales_followups",
  description:
    "Sales follow-up tasks from HubSpot, live: overdue tasks (oldest first, with days overdue), tasks due today, and tasks due in the next N days (default 7), " +
    "each with its deal, amount, stage, company and contact. Use for 'what follow-ups are due', 'what am I behind on', or a daily to-do list.",
  schema: followSchema,
  handler: async ({ params }: any) => { try { return await followups(params); } catch (e) { return fail(e); } },
};

// 5 and 6 need QuickBooks too.
export function makeHubSpotTools(qb: QbSide) {
  // 5. Account brief
  const briefSchema = z.object({
    company: z.string().min(2).describe("All or part of the company name, for example \"lakeshore\""),
    as_of: asOfSchema,
  });

  async function brief(params: any) {
    const today = checkDate(params?.as_of, "as_of") || todayISO();
    const term = String(params?.company ?? "").replace(/[‘’]/g, "'").trim();
    if (term.length < 2) throw new Error("give part of a company name");
    const found = await searchAll("companies", datasetFilters(), ["name", "city", "state", "domain", "description"], 200, term);
    let cands = found.rows;
    if (!cands.length) {
      const words = norm(term).split(" ").filter((w) => w.length >= 3);
      const seen = new Map<string, any>();
      for (const w of words.slice(0, 4)) for (const r of (await searchAll("companies", datasetFilters(), ["name", "city", "state", "domain", "description"], 200, w)).rows) seen.set(String(r.id), r);
      cands = [...seen.values()];
    }
    const nt = norm(term);
    const exact = cands.filter((r) => norm(String(r.properties?.name || "")) === nt);
    const pick = exact.length === 1 ? exact : cands.length === 1 ? cands : cands.filter((r) => norm(String(r.properties?.name || "")).includes(nt));
    if (pick.length !== 1) {
      return text({
        matched: false,
        searchedFor: term,
        candidates: cands.slice(0, 15).map((r) => ({ company: r.properties?.name, location: [r.properties?.city, r.properties?.state].filter(Boolean).join(", ") || null })),
        note: cands.length ? "More than one company matches. Ask which one, or call again with the full name." : "No company in HubSpot matches. Check the spelling or try a shorter part of the name.",
      });
    }
    const co = pick[0];
    const cid = String(co.id);
    const cname = String(co.properties?.name || "");
    const [{ deals, contacts, truncated }, contactAssoc, invs, cust] = await Promise.all([
      loadDeals({ companyIds: [cid] }),
      assoc("companies", "contacts", [cid]),
      qb.openInvoices(),
      qb.findCustomer(cname),
    ]);
    const people = await batchRead("contacts", contactAssoc.get(cid) || [], ["firstname", "lastname", "jobtitle", "email", "phone"]);
    const y = today.slice(0, 4);
    const [ytd, lastYear] = cust ? await Promise.all([
      qb.customerSales(cust.id, `${y}-01-01`, today),
      qb.customerSales(cust.id, `${Number(y) - 1}-01-01`, `${Number(y) - 1}-12-31`),
    ]) : [null, null];
    const bal = balanceSummary(invoicesFor(cname, invs), today);
    const open = deals.filter((d) => !d.stage.isClosed).sort(byAmountDesc);
    const closed = deals.filter((d) => d.stage.isClosed).sort((a, b) => String(b.closeDate).localeCompare(String(a.closeDate)));
    const acts = deals.flatMap((d) => d.activities.filter((a) => a.date && a.date <= today).map((a) => ({ date: a.date, type: a.type, deal: d.name, summary: a.title === "Note" ? a.detail : `${a.title}: ${a.detail}` })))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const openTasks = deals.flatMap((d) => d.tasks.filter((x) => x.open).map((x) => ({ task: x.subject, due: x.due, priority: x.priority, deal: d.name, ...(x.due && x.due < today ? { overdue: true, daysOverdue: dayNumber(today) - dayNumber(x.due) } : {}) })))
      .sort((a, b) => String(a.due).localeCompare(String(b.due)));
    const flags: string[] = [];
    if (bal.pastDue > 0n) flags.push(`${dollars(bal.pastDue)} past due in QuickBooks (oldest ${bal.oldestDaysPastDue} days past due) while ${open.length} deal${open.length === 1 ? " is" : "s are"} open worth ${dollars(sum(open))}. Check with finance before agreeing new terms or discounts.`);
    for (const d of open) {
      const last = lastActivity(d, today);
      if (d.closeDate && d.closeDate < today) flags.push(`${d.name}: close date ${d.closeDate} has passed.`);
      if (!last) flags.push(`${d.name}: no activity logged.`);
      else if (dayNumber(today) - dayNumber(last.date!) > 14) flags.push(`${d.name}: no activity in ${dayNumber(today) - dayNumber(last.date!)} days.`);
    }
    for (const x of openTasks) if ((x as any).overdue) flags.push(`Overdue task: ${x.task} (due ${x.due}).`);
    return text({
      matched: true,
      asOf: today,
      company: { name: cname, location: [co.properties?.city, co.properties?.state].filter(Boolean).join(", ") || null, domain: co.properties?.domain || null, about: co.properties?.description ? STRIP(co.properties.description) : null },
      contacts: [...people.values()].map((x) => { const p = x.properties || {}; return { name: [p.firstname, p.lastname].filter(Boolean).join(" "), title: p.jobtitle || null, email: p.email || null, phone: p.phone || null }; }),
      openDeals: { deals: open.length, value: money(sum(open)), list: open.map((d) => dealLine(d, new Map([[cid, { id: cid, name: cname } as Company]]), today, { description: d.description, contact: primaryContact(d, contacts) })) },
      closedDeals: closed.map((d) => ({ deal: d.name, result: d.stage.won ? "won" : "lost", amount: money(d.amount), closeDate: d.closeDate })),
      recentActivity: acts.slice(0, 10),
      openTasks,
      quickBooks: cust ? {
        customer: cust.name,
        ...(cust.terms ? { terms: cust.terms } : {}),
        owed: money(bal.owed), pastDue: money(bal.pastDue), moreThan60DaysPastDue: money(bal.over60),
        openInvoices: bal.openInvoices, pastDueInvoices: bal.pastDueInvoices, oldestDaysPastDue: bal.oldestDaysPastDue,
        invoices: bal.list.slice(0, 10),
        salesYearToDate: money(ytd as bigint), salesLastYear: money(lastYear as bigint),
      } : { customer: null, note: "No QuickBooks customer has this exact name, so this company has no invoices on record (likely a prospect)." },
      watchOuts: flags,
      note: "HubSpot (deals, contacts, activity, tasks) and QuickBooks (balances, sales) read live and joined by exact company name. Figures computed exactly by the connector; use them as given. " + scopeNote(truncated),
    });
  }

  const GetAccountBriefTool = {
    name: "get_account_brief",
    description:
      "Everything about one company in one call, live from HubSpot and QuickBooks: contacts, open deals (amount, stage, close date, next step, last activity), " +
      "won and lost deals, the last 10 activities, open and overdue tasks, and from QuickBooks what they owe, what is past due, open invoices, and sales this year and last year, " +
      "plus watch-outs. Use before a call or meeting, or for any question about one account or customer.",
    schema: briefSchema,
    handler: async ({ params }: any) => { try { return await brief(params); } catch (e) { return fail(e); } },
  };

  // 6. Open deals at accounts with past-due balances
  const creditSchema = z.object({
    min_days_past_due: z.number().int().min(1).max(365).optional().describe("Only count invoices at least this many days past due (default 1)"),
    as_of: asOfSchema,
  });

  async function credit(params: any) {
    const today = checkDate(params?.as_of, "as_of") || todayISO();
    const minDays = params?.min_days_past_due ?? 1;
    const [{ deals, companies, contacts, truncated }, invs] = await Promise.all([loadDeals(), qb.openInvoices()]);
    const open = deals.filter((d) => !d.stage.isClosed);
    const byCompany = new Map<string, Deal[]>();
    for (const d of open) for (const cid of d.companyIds) byCompany.set(cid, [...(byCompany.get(cid) || []), d]);
    const t = dayNumber(today);
    const rows: any[] = [];
    let clear = 0;
    for (const [cid, list] of byCompany) {
      const name = companies.get(cid)?.name;
      if (!name) continue;
      const mine = invoicesFor(name, invs);
      const pastList = mine.filter((i) => t - dayNumber(i.due) >= minDays);
      if (!pastList.length) { clear++; continue; }
      const b = balanceSummary(mine, today);
      const pastDue = pastList.reduce((s, i) => s + i.balance, 0n);
      rows.push({
        company: name, pastDue, openDealValue: sum(list),
        out: {
          company: name,
          quickBooks: { owed: money(b.owed), pastDue: money(pastDue), oldestDaysPastDue: b.oldestDaysPastDue, pastDueInvoices: pastList.sort((a, z) => dayNumber(a.due) - dayNumber(z.due)).map((i) => ({ invoice: i.invoice, dueDate: i.due, balance: money(i.balance), daysPastDue: t - dayNumber(i.due) })) },
          openDeals: list.sort(byAmountDesc).map((d) => dealLine(d, companies, today, { contact: primaryContact(d, contacts) })),
          openDealValue: money(sum(list)),
        },
      });
    }
    rows.sort((a, b) => (b.pastDue > a.pastDue ? 1 : b.pastDue < a.pastDue ? -1 : 0));
    return text({
      asOf: today,
      rule: `Companies with an open HubSpot deal and at least one QuickBooks invoice ${minDays}+ days past due`,
      companies: rows.length,
      totalPastDue: money(rows.reduce((s, r) => s + r.pastDue, 0n)),
      openDealValueAtThoseCompanies: money(rows.reduce((s, r) => s + r.openDealValue, 0n)),
      list: rows.map((r) => r.out),
      companiesWithOpenDealsAndNothingPastDue: clear,
      note: "HubSpot deals and QuickBooks invoices read live and joined by exact company name; sorted by past-due amount. Use as given. " + scopeNote(truncated),
    });
  }

  const GetDealsWithPastDueBalancesTool = {
    name: "get_deals_with_past_due_balances",
    description:
      "Cross-checks sales against finance, live: every company with an open HubSpot deal that also has past-due invoices in QuickBooks, " +
      "with the past-due invoices, total owed, and the open deals (amount, stage, next step, last activity). Sorted by past-due amount. " +
      "Use before offering terms or discounts, or for 'which customers with open deals owe us money'.",
    schema: creditSchema,
    handler: async ({ params }: any) => { try { return await credit(params); } catch (e) { return fail(e); } },
  };

  return [GetSalesPipelineTool, GetDealsClosingTool, GetDealsNeedingAttentionTool, GetSalesFollowupsTool, GetAccountBriefTool, GetDealsWithPastDueBalancesTool];
}

export const HUBSPOT_TOOL_NAMES = ["get_sales_pipeline", "get_deals_closing", "get_deals_needing_attention", "get_sales_followups", "get_account_brief", "get_deals_with_past_due_balances"];
