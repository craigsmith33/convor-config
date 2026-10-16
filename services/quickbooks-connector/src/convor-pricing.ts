// Convor addition (1.8): exact proposal and quote pricing for the Sales Assistant.
//
// Prices come live from the QuickBooks item list; the customer's account tier
// comes from their last 12 months of purchases in QuickBooks (the price
// guide's rule); payment terms and any past-due balance come from QuickBooks.
// Discount tiers, volume add-on, caps, approval limits, lead times and freight
// rules are the company's price-guide rules, held in RULES below (the demo
// company's 2026 guide). Every number is computed in code, in cents.
// Read-only: it never changes QuickBooks.
import { z } from "zod";
import { toCents, money, todayISO } from "./convor-answers.js";
import type { QbSide } from "./convor-hubspot.js";

export type QbItem = { sku: string; name: string; description: string | null; type: string; price: bigint; active: boolean };
export interface QbPricingSide extends QbSide {
  items(): Promise<QbItem[]>;
}

// ---------------------------------------------------------------- price-guide rules (Tallmark 2026 demo)

const RULES = {
  source: "Tallmark Product Catalog and Price Guide 2026, sections 1-8",
  tiers: [
    // annual purchases: over 250,000 -> A; 50,000 to 250,000 -> B; under 50,000 (and all new accounts) -> C
    { tier: "A", minExclusive: 25_000_000n, discountBp: 1500 },
    { tier: "B", minInclusive: 5_000_000n, discountBp: 1000 },
    { tier: "C", minInclusive: 0n, discountBp: 500 },
  ],
  volumeAddOnBp: 300,
  volumeMinQty: 10,
  cobotSkus: new Set(["CB-5", "CB-10", "CB-PAL"]),
  cobotCapBp: 1200,
  otherCapBp: 2500,
  approvals: [
    { maxBp: 1000, who: "Sales rep" },
    { maxBp: 1800, who: "Branch manager" },
    { maxBp: 2500, who: "Deal Desk" },
  ],
  leadTimes: {
    "TM-SV200": "Stock", "TM-SV400": "Stock", "TM-SV750": "Stock", "TM-SV1K5": "Stock", "TM-SD400": "Stock", "TM-SD1K5": "Stock",
    "TM-CBL-05": "Stock", "TM-GH60-10": "2 weeks", "TM-ST23": "Stock", "TM-SDR23": "Stock",
    "CL-PLC-16": "Stock", "CL-PLC-32": "Stock", "CL-IO-8DI": "Stock", "CL-IO-8DO": "Stock", "CL-HMI-7": "Stock", "CL-HMI-10": "Stock", "CL-SR-2": "Stock",
    "SL-PE-R": "Stock", "SL-PE-D": "Stock", "SL-PX-12": "Stock", "SL-PX-18": "Stock", "SL-VS-1": "2 weeks", "SL-KIT-PE": "Stock",
    "FC-B300-1M": "3 weeks", "FC-B300-2M": "3 weeks", "FC-B450-2M": "3 weeks", "FC-CRV-90": "4 weeks", "FC-DRV-90": "Stock", "FC-STD": "Stock",
    "CB-5": "4 weeks", "CB-10": "4 weeks", "CB-GR-E": "Stock", "CB-PAL": "6 weeks",
    "FP-CYL-32-100": "Stock", "FP-VLV-52": "Stock", "FP-FRL-14": "Stock",
  } as Record<string, string>,
  // services are billed at standard rates (no account discount)
  serviceMinimums: { "SVC-FIELD": { qty: 2, why: "Field service has a 2-hour minimum" } } as Record<string, { qty: number; why: string }>,
  freightFreeMinCents: 50_000n,
  freightSeparatePrefixes: ["FC-", "CB-"],
  quoteValidDays: 30,
  newAccountTerms: "New account: credit card (up to $10,000) or prepayment until credit is approved by the Deal Desk",
  // customer-facing wording (1.9), from the Warranty, Returns and Service Policy 2026 and the Company Overview 2026
  warranty: [
    { test: /^(TM-|CL-|SL-|FC-)/, line: "@HOUSE products: 2 years from ship date, parts and repair." },
    { test: /^CB-/, line: "Tallmark CoBot robots and accessories: 1 year from ship date; extended coverage is available at $1,900 per robot per year." },
    { test: /^FP-/, line: "Fluid power products: 1 year from ship date." },
  ],
  warrantyCommon: "Warranty covers defects in materials and workmanship. It does not cover misuse, improper installation, unauthorized modification or normal wear items such as belts and gripper fingers.",
  houseBrands: [["TM-", "MotionPro"], ["CL-", "ControlLine"], ["SL-", "SenseLine"], ["FC-", "FlexConvey"]] as [string, string][],
  nonReturnable: [[/^FC-(B|CRV)/, "FlexConvey sections and curves"], [/^SVC-PANEL$/, "control panels and turnkey cells"]] as [RegExp, string][],
  exchange: { test: /^TM-(SV|SD)/, line: "Advance exchange units are available for MotionPro servo motors and drives." },
  pmPlans: {
    "SVC-PM-ESS": "Essential preventive maintenance plan: one annual inspection visit and report.",
    "SVC-PM-STD": "Standard preventive maintenance plan: quarterly visits, wear-part inspection and firmware updates.",
    "SVC-PM-PREM": "Premium preventive maintenance plan: quarterly visits, response within 4 business hours and 10% off repairs.",
  } as Record<string, string>,
  repairLine: "Tallmark Repair Center: standard repair in 5 business days; repairs carry a 12-month warranty. Field service is available at standard rates.",
  whyTallmark: [
    "**Local engineering.** An applications engineer in every branch, at no charge for sizing, selection and application review.",
    "**One supplier.** Motion, controls, sensing, conveyors, cobots and fluid power on one order and one invoice.",
    "**Speed.** Same-day shipping on 28,000+ stocked items ordered by 3:00 p.m. Eastern, and 97.2% on-time delivery in 2025.",
    "**Uptime support.** A repair center with 5-day standard turnaround, exchange units, preventive maintenance plans and stocking of critical spares.",
  ],
  leadTimeNote: "Lead times are typical and are confirmed with the Inside Sales Desk when the order is placed.",
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };
/** "FlexConvey belt conveyor section, 450 mm x 2 m" -> "FlexConvey belt conveyor section" */
const shortName = (desc: string) => desc.split(",")[0].replace(/\s*\(.*?\)\s*/g, " ").trim();
const listJoin = (xs: string[]) => xs.length <= 1 ? (xs[0] || "") : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
const lcFirst = (s: string) => /^[A-Z][a-z]/.test(s) && !/^(FlexConvey|ControlLine|SenseLine|MotionPro|Tallmark|UL)\b/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;

/** Customer-facing proposal sections built from the priced lines, so the model copies them instead of retyping numbers. */
function buildSections(o: { lines: any[]; toQuote: any[]; skus: string[]; cust: any; netTotal: bigint; validUntil: string; table: string; separate: string[] }) {
  const { lines, toQuote, skus, cust, netTotal, validUntil, table, separate } = o;
  // Investment
  const freight = separate.length
    ? `conveyors and cobots ship with freight quoted separately; ${netTotal >= RULES.freightFreeMinCents ? "all other items ship free standard ground" : "other items ship with freight at cost"}.`
    : netTotal >= RULES.freightFreeMinCents ? "free standard ground shipping." : "freight charged at cost.";
  const terms = cust ? `${cust.terms || "Net 30"}.` : "credit card or prepayment until your credit account is approved.";
  const inv = [table, "",
    `- **Freight:** ${freight}`,
    `- **Payment terms:** ${terms}`,
    `- **Validity:** this proposal is valid for ${RULES.quoteValidDays} days, until ${longDate(validUntil)}.`,
    ...(toQuote.length ? [`- **Quoted separately:** ${listJoin(toQuote.map((x) => lcFirst(shortName(x.description))))}, priced per project after the Applications Engineering review.`] : []),
  ].join("\n");

  // Timeline from lead times
  const tl: string[] = [];
  const hasCobot = skus.some((s) => RULES.cobotSkus.has(s) || s === "CB-GR-E");
  const needsReview = hasCobot || toQuote.length > 0 || skus.some((s) => /^(TM-SV|FC-|SL-VS)/.test(s));
  if (needsReview) {
    const what: string[] = [];
    if (skus.some((s) => s.startsWith("TM-SV"))) what.push("servo sizing");
    if (skus.some((s) => s.startsWith("FC-"))) what.push("conveyor layout");
    if (skus.some((s) => s.startsWith("SL-VS"))) what.push("vision application");
    if (hasCobot) what.push("cobot application and risk assessment");
    if (!what.length) what.push("application");
    tl.push(`- **At order:** purchase order and Applications Engineering review (${listJoin(what)}).`);
  }
  const products = lines.filter((l) => l.leadTime !== "Scheduled");
  const stock = products.filter((l) => l.leadTime === "Stock");
  if (stock.length) tl.push(`- **Same day as order:** stocked items ship (${listJoin([...new Set(stock.map((l) => lcFirst(shortName(l.description))))])}) when ordered by 3:00 p.m. Eastern.`);
  const byWeeks = new Map<number, string[]>();
  const other: string[] = [];
  for (const l of products) {
    const m = /^(\d+) weeks?$/.exec(l.leadTime);
    if (m) { const w = Number(m[1]); byWeeks.set(w, [...(byWeeks.get(w) || []), lcFirst(shortName(l.description))]); }
    else if (l.leadTime !== "Stock") other.push(lcFirst(shortName(l.description)));
  }
  for (const w of [...byWeeks.keys()].sort((a, b) => a - b)) tl.push(`- **About ${w} week${w === 1 ? "" : "s"}:** ${listJoin([...new Set(byWeeks.get(w)!)])} ship${byWeeks.get(w)!.length === 1 ? "s" : ""}.`);
  if (other.length) tl.push(`- **To be confirmed:** lead time for ${listJoin(other)} is confirmed by the Inside Sales Desk.`);
  if (toQuote.length) tl.push(`- **After the review:** Tallmark sends the separate quote for ${listJoin(toQuote.map((x) => lcFirst(shortName(x.description))))}.`);
  const svc = lines.filter((l) => l.leadTime === "Scheduled");
  if (svc.length) tl.push(`- **After delivery:** ${listJoin([...new Set(svc.map((l) => lcFirst(shortName(l.description))))])} scheduled with your team.`);
  const timeline = [...tl, "", RULES.leadTimeNote].join("\n");

  // Warranty and support
  const all = [...skus, ...toQuote.map((x) => x.sku)];
  const w: string[] = [];
  const house = RULES.houseBrands.filter(([p]) => all.some((s) => s.startsWith(p))).map(([, b]) => b);
  for (const r of RULES.warranty) if (all.some((s) => r.test.test(s))) w.push(r.line.replace("@HOUSE", listJoin(house)));
  if (w.length) w.push(RULES.warrantyCommon);
  if (all.some((s) => RULES.exchange.test.test(s))) w.push(RULES.exchange.line);
  for (const s of all) if (RULES.pmPlans[s]) w.push(RULES.pmPlans[s]);
  const nr = RULES.nonReturnable.filter(([re]) => all.some((s) => re.test(s))).map(([, t]) => t);
  if (nr.length) w.push(`Built-to-order items are not returnable: ${nr.join("; ")}.`);
  w.push(RULES.repairLine);
  const warranty = w.map((x) => `- ${x}`).join("\n");

  return {
    investment: inv,
    timeline,
    whyTallmark: RULES.whyTallmark.map((x) => `- ${x}`).join("\n"),
    warrantyAndSupport: warranty,
  };
}

// ---------------------------------------------------------------- helpers

function dayNumber(iso: string) { const [y, m, d] = iso.split("-").map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); }
function addDays(iso: string, n: number) { return new Date((dayNumber(iso) + n) * 86400000).toISOString().slice(0, 10); }
const ISO = /^\d{4}-\d{2}-\d{2}$/;
function checkDate(v: unknown, name: string) {
  if (v === undefined || v === null || v === "") return undefined;
  const s = String(v).trim();
  if (!ISO.test(s) || isNaN(dayNumber(s))) throw new Error(`${name} must be a date written YYYY-MM-DD`);
  return s;
}
const bpText = (bp: number) => (bp % 100 === 0 ? String(bp / 100) : (bp / 100).toFixed(2).replace(/0$/, "")) + "%";
const dollars = (c: bigint) => { const m = money(c); const neg = m.startsWith("-"); const [w, f] = (neg ? m.slice(1) : m).split("."); return (neg ? "-$" : "$") + w.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + f; };
/** cents * (10000 - bp) / 10000, rounded half up to the cent */
const applyBp = (cents: bigint, bp: number) => (cents * BigInt(10000 - bp) * 2n + 10000n) / 20000n;
const norm = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\b(inc|llc|co|corp|corporation|company|ltd)\b/g, " ").replace(/\s+/g, " ").trim();
function text(obj: any) { return { content: [{ type: "text" as const, text: JSON.stringify(obj) }] }; }
function fail(e: any) { return { isError: true, content: [{ type: "text" as const, text: "Error: " + (e?.message || String(e)) }] }; }

function tierFor(purchases: bigint) {
  for (const t of RULES.tiers) {
    if ("minExclusive" in t && t.minExclusive !== undefined && purchases > t.minExclusive) return t;
    if ("minInclusive" in t && t.minInclusive !== undefined && purchases >= t.minInclusive) return t;
  }
  return RULES.tiers[RULES.tiers.length - 1];
}
function approverFor(bp: number) {
  if (bp <= 0) return "None";
  return (RULES.approvals.find((a) => bp <= a.maxBp) || RULES.approvals[RULES.approvals.length - 1]).who;
}
const APPROVER_RANK: Record<string, number> = { None: 0, "Sales rep": 1, "Branch manager": 2, "Deal Desk": 3 };

// ---------------------------------------------------------------- tool

const pricingSchema = z.object({
  customer: z.string().min(2).describe("Customer or prospect company name, for example \"Lakeshore Plastics Group\""),
  items: z.array(z.object({
    sku: z.string().min(1).describe("SKU from the price guide, for example \"CB-10\" or \"SVC-FIELD\""),
    quantity: z.number().positive().describe("Quantity (hours for SVC-FIELD, days for SVC-TRAIN, plans for preventive maintenance)"),
  })).min(1).max(60).describe("Every line on the quote or proposal"),
  extra_discount_percent: z.number().min(0).max(25).optional().describe("Additional discount the rep wants to offer on top of the standard tier and volume discounts, in percent (for example 3). Leave empty for standard pricing."),
  as_of: z.string().optional().describe("Quote date (YYYY-MM-DD). Leave empty for today."),
});

export function makePricingTool(qb: QbPricingSide) {
  async function pricing(params: any) {
    const today = checkDate(params?.as_of, "as_of") || todayISO();
    const name = String(params?.customer ?? "").replace(/[‘’]/g, "'").trim();
    const extraBp = Math.round(Number(params?.extra_discount_percent ?? 0) * 100);
    const [items, cust, invs] = await Promise.all([qb.items(), qb.findCustomer(name), qb.openInvoices()]);
    const bySku = new Map(items.filter((i) => i.active).map((i) => [i.sku.toUpperCase(), i]));

    // account
    const yearStart = addDays(today, -364);
    const purchases = cust ? await qb.customerSales(cust.id, yearStart, today) : 0n;
    const tier = cust ? tierFor(purchases) : RULES.tiers[RULES.tiers.length - 1];
    const mine = cust ? invs.filter((i) => norm(String(i.customer).split(":")[0]) === norm(cust.name)) : [];
    const t = dayNumber(today);
    const pastDue = mine.filter((i) => t > dayNumber(i.due));
    const pastDueTotal = pastDue.reduce((s, i) => s + i.balance, 0n);
    const recorded = cust?.notes ? /\bTier ([ABC])\b/i.exec(cust.notes)?.[1]?.toUpperCase() || null : null;

    // merge duplicate SKUs (the volume add-on counts units of the same SKU on one order)
    const merged = new Map<string, number>();
    for (const it of params.items) {
      const sku = String(it.sku).trim().toUpperCase();
      merged.set(sku, (merged.get(sku) || 0) + Number(it.quantity));
    }

    const lines: any[] = [], toQuote: any[] = [], unknown: string[] = [], notes: string[] = [];
    let listTotal = 0n, netTotal = 0n, worst = "None";
    for (const [sku, qtyIn] of merged) {
      const item = bySku.get(sku);
      if (!item) { unknown.push(sku); continue; }
      const isService = item.type === "Service";
      if (item.price <= 0n) {
        toQuote.push({ sku, description: item.description || item.name, quantity: qtyIn, reason: sku === "SVC-PANEL" ? "Panel building and turnkey cells are quoted per project" : "No list price; quoted per job" });
        continue;
      }
      let qty = qtyIn;
      const min = RULES.serviceMinimums[sku];
      if (min && qty < min.qty) { notes.push(`${sku}: quantity raised from ${qty} to ${min.qty}. ${min.why}.`); qty = min.qty; }
      if (!Number.isInteger(qty * 100)) throw new Error(`quantity for ${sku} must have at most 2 decimals`);
      const qtyHundredths = BigInt(Math.round(qty * 100));
      let bp = 0; const parts: string[] = []; let capped = false;
      if (!isService) {
        bp = tier.discountBp; parts.push(`Tier ${tier.tier} ${bpText(tier.discountBp)}`);
        if (qty >= RULES.volumeMinQty) { bp += RULES.volumeAddOnBp; parts.push(`volume +${bpText(RULES.volumeAddOnBp)}`); }
        if (extraBp > 0) { bp += extraBp; parts.push(`extra +${bpText(extraBp)}`); }
        const cap = RULES.cobotSkus.has(sku) ? RULES.cobotCapBp : RULES.otherCapBp;
        if (bp > cap) { capped = true; parts.push(`capped at ${bpText(cap)} (${RULES.cobotSkus.has(sku) ? "cobot limit" : "house-brand limit"})`); bp = cap; }
      }
      const netEach = applyBp(item.price, bp);
      const lineList = (item.price * qtyHundredths + 50n) / 100n;
      const lineNet = (netEach * qtyHundredths + 50n) / 100n;
      listTotal += lineList; netTotal += lineNet;
      const approver = isService ? "None" : approverFor(bp);
      if (APPROVER_RANK[approver] > APPROVER_RANK[worst]) worst = approver;
      lines.push({
        sku, description: item.description || item.name, quantity: qty, listEach: money(item.price),
        discountPercent: bpText(bp).replace("%", ""), discountBuiltFrom: isService ? "Service rate, not discounted" : parts.join(", "),
        netEach: money(netEach), lineTotal: money(lineNet), leadTime: isService ? "Scheduled" : (RULES.leadTimes[sku] || "Confirm with Inside Sales Desk"),
        approval: approver, ...(capped ? { capped: true } : {}),
      });
    }
    if (unknown.length) notes.push(`Not in the QuickBooks item list or price guide: ${unknown.join(", ")}. Confirm with the Inside Sales Desk before quoting.`);

    // configuration checks from the price guide
    const q = (s: string) => merged.get(s) || 0;
    const checks: string[] = [];
    const small = q("TM-SV200") + q("TM-SV400"), big = q("TM-SV750") + q("TM-SV1K5");
    if (small > q("TM-SD400")) checks.push(`${small} servo motor(s) up to 400 W but ${q("TM-SD400")} TM-SD400 drive(s). Each servo axis needs a matching drive.`);
    if (big > q("TM-SD1K5")) checks.push(`${big} servo motor(s) of 750 W or 1.5 kW but ${q("TM-SD1K5")} TM-SD1K5 drive(s). Each servo axis needs a matching drive.`);
    if (small + big > q("TM-CBL-05")) checks.push(`${small + big} servo motor(s) but ${q("TM-CBL-05")} TM-CBL-05 cable set(s). Each servo axis needs a cable set.`);
    const sections = q("FC-B300-1M") + q("FC-B300-2M") + q("FC-B450-2M");
    if (sections > q("FC-STD")) checks.push(`${sections} straight conveyor section(s) but ${q("FC-STD")} pair(s) of FC-STD stands. Each section needs one pair.`);
    if (sections > 0 && q("FC-DRV-90") === 0) checks.push("Conveyor sections but no FC-DRV-90 drive unit. Each straight run needs one drive unit.");
    if (q("CB-PAL") > q("CB-10")) checks.push(`${q("CB-PAL")} CB-PAL palletizing kit(s) but ${q("CB-10")} CB-10 robot(s). The kit is designed for the CB-10.`);

    const reviews: string[] = [];
    if ([...merged.keys()].some((s) => RULES.cobotSkus.has(s) || s === "CB-GR-E")) reviews.push("Applications Engineering review and risk assessment (required for every cobot application before the quote is final).");
    if ([...merged.keys()].some((s) => /^(TM-SV|FC-|SL-VS)/.test(s))) reviews.push("Applications Engineering: servo sizing, conveyor layout or vision application review (playbook).");
    if (toQuote.length) reviews.push("Applications Engineering or Inside Sales Desk to price: " + toQuote.map((x) => x.sku).join(", ") + ".");

    const separate = [...merged.keys()].filter((s) => RULES.freightSeparatePrefixes.some((p) => s.startsWith(p)));
    const freight = separate.length
      ? `Conveyors and cobots (${separate.join(", ")}) ship with freight quoted separately; ${netTotal >= RULES.freightFreeMinCents ? "other items ship free standard ground (order of $500 or more)" : "other items: freight at cost (order under $500)"}.`
      : netTotal >= RULES.freightFreeMinCents ? "Free standard ground shipping (order of $500 or more)." : "Freight charged at cost (order under $500).";

    let terms = cust ? (cust.terms || "Net 30") + " (approved credit account)" : RULES.newAccountTerms;
    const warnings: string[] = [];
    if (cust && pastDueTotal > 0n) warnings.push(`${cust.name} has ${dollars(pastDueTotal)} past due in QuickBooks across ${pastDue.length} invoice(s), oldest ${Math.max(...pastDue.map((i) => t - dayNumber(i.due)))} days. Do not offer longer terms or extra discount without Deal Desk approval; consider asking for the past-due balance to be cleared before the order ships.`);
    if (cust && recorded && recorded !== tier.tier) warnings.push(`QuickBooks notes list ${cust.name} as Tier ${recorded}, but its purchases in the last 12 months (${dollars(purchases)}) make it Tier ${tier.tier} under the price guide. This quote uses Tier ${tier.tier}; confirm with the branch manager before using Tier ${recorded}.`);
    if (extraBp > 0) warnings.push(`Includes an extra ${bpText(extraBp)} discount requested by the rep.`);
    if (!cust) warnings.push(`No QuickBooks customer named "${name}": priced as a new account (Tier C).`);

    const effPct = listTotal > 0n ? Number(((listTotal - netTotal) * 1000000n * 2n + listTotal) / (2n * listTotal)) / 10000 : 0;
    const lead = (v: string) => v.replace(/ weeks?$/, (m) => (m.trim() === "week" ? " wk" : " wks"));
    const table = [
      "| Item | Qty | List each | Discount | Net each | Line total | Lead time |",
      "|---|---:|---:|---:|---:|---:|---|",
      ...lines.map((l) => `| ${l.sku} – ${l.description} | ${l.quantity} | ${dollars(toCents(l.listEach))} | ${l.discountPercent}% | ${dollars(toCents(l.netEach))} | ${dollars(toCents(l.lineTotal))} | ${lead(l.leadTime)} |`),
      ...toQuote.map((x) => `| ${x.sku} – ${x.description} | ${x.quantity} | Quoted separately | | | To be quoted | |`),
      `| **Total** | | ${dollars(listTotal)} | | | **${dollars(netTotal)}** | |`,
    ].join("\n");
    const validUntil = addDays(today, RULES.quoteValidDays);
    const proposalSections = buildSections({ lines, toQuote, skus: [...merged.keys()].filter((s) => bySku.has(s)), cust, netTotal, validUntil, table, separate });

    return text({
      quoteDate: today,
      validUntil: addDays(today, RULES.quoteValidDays),
      customer: cust
        ? { name: cust.name, inQuickBooks: true, purchasesLast12Months: money(purchases), purchasesPeriod: `${yearStart} to ${today}`, tier: tier.tier, tierDiscountPercent: bpText(tier.discountBp).replace("%", ""), ...(recorded ? { tierInQuickBooksNotes: recorded } : {}), paymentTerms: cust.terms, pastDue: money(pastDueTotal) }
        : { name, inQuickBooks: false, tier: "C", tierDiscountPercent: bpText(RULES.tiers[2].discountBp).replace("%", ""), note: "New account" },
      lines,
      ...(toQuote.length ? { toBeQuotedSeparately: toQuote } : {}),
      totals: { list: money(listTotal), discount: money(listTotal - netTotal), net: money(netTotal), effectiveDiscountPercent: effPct.toFixed(2) },
      approvalNeeded: worst === "None" || worst === "Sales rep" ? "None: within sales rep authority" : `${worst}: under the price guide, a total discount over 10% needs the branch manager and over 18% needs the Deal Desk (this applies even when it is the account's standard tier discount)`,
      freight,
      paymentTerms: terms,
      validity: `${RULES.quoteValidDays} days (until ${addDays(today, RULES.quoteValidDays)})`,
      requiredReviews: reviews,
      configurationChecks: checks,
      warnings,
      notes,
      pricingTableMarkdown: table,
      proposalSections: {
        ...proposalSections,
        howToUse: "Customer-facing Markdown for a proposal. Paste investment under '## Investment', timeline under '## Timeline', whyTallmark under '## Why Tallmark' and warrantyAndSupport under '## Warranty and support', each exactly as given (every row and bullet). Nothing internal is in these blocks.",
      },
      note: `Prices from the QuickBooks item list; tier from the customer's QuickBooks purchases; discounts, caps, approvals, lead times and freight from the ${RULES.source}. Computed exactly by the connector: use these numbers and pricingTableMarkdown as given, never recalculate. A draft for the rep to review, not a binding offer.`,
    });
  }

  return {
    name: "get_proposal_pricing",
    description:
      "Exact pricing for a quote or proposal in one call: list prices live from QuickBooks, the customer's tier from their last 12 months of QuickBooks purchases, " +
      "volume add-on, an optional extra discount, product-type caps, the approval needed, lead times, freight, payment terms, validity, required engineering reviews, " +
      "configuration checks (for example missing drives or stands) and past-due warnings, plus a ready pricing table. Use for every price, quote or proposal; never price by hand.",
    schema: pricingSchema,
    handler: async ({ params }: any) => { try { return await pricing(params); } catch (e) { return fail(e); } },
  };
}
