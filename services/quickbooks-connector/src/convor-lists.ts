// Convor addition: compact invoice and bill search results.
//
// Upstream returns every matching record in full (line items, addresses,
// metadata), about 2,000 characters per invoice. For finance questions the
// assistant needs a handful of fields per record and the exact total, so the
// result is rewritten to those fields plus exact sums computed here. This keeps
// answers fast and stops the model from adding long lists of numbers itself.
// Anything unexpected returns null and the caller keeps the original result.

type Kind = { key: string; party: string; partyRef: string; detailTool: string };

const KINDS: Record<string, Kind> = {
  search_invoices: { key: "invoices", party: "Customer", partyRef: "CustomerRef", detailTool: "read_invoice" },
  search_bills: { key: "bills", party: "Vendor", partyRef: "VendorRef", detailTool: "get-bill" },
};

function toCents(v: unknown): bigint | null {
  if (v === undefined || v === null || v === "") return null;
  const s = typeof v === "number" ? String(v) : String(v).trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = (m[3] || "").padEnd(3, "0");
  let cents = BigInt(m[2]) * 100n + BigInt(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1n; // round half up on the third decimal
  return m[1] === "-" ? -cents : cents;
}

function money(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  const s = (a / 100n).toString() + "." + (a % 100n).toString().padStart(2, "0");
  return neg ? "-" + s : s;
}

export function compactSearchResult(toolName: string, result: any): any | null {
  const kind = KINDS[toolName];
  if (!kind || !result || result.isError || !Array.isArray(result.content)) return null;
  const parts = result.content;
  if (!parts.length || parts.some((p: any) => p?.type !== "text" || typeof p.text !== "string")) return null;
  const head = /^Found (\d+) /.exec(parts[0].text);
  if (!head) return null;
  const found = Number(head[1]);
  const records = parts.slice(1);
  if (found === 0 || records.length !== found) return null;

  let totalBalance = 0n;
  let totalAmount = 0n;
  const rows: any[] = [];
  for (const p of records) {
    let r: any;
    try { r = JSON.parse(p.text); } catch { return null; }
    if (!r || typeof r !== "object" || Array.isArray(r) || typeof r.Id !== "string") return null;
    const bal = toCents(r.Balance);
    const amt = toCents(r.TotalAmt);
    if (bal === null || amt === null) return null;
    totalBalance += bal;
    totalAmount += amt;
    const row: any = {
      Id: r.Id,
      DocNumber: typeof r.DocNumber === "string" && r.DocNumber ? r.DocNumber : null,
      [kind.party]: r[kind.partyRef]?.name ?? null,
      [kind.party + "Id"]: r[kind.partyRef]?.value ?? null,
      TxnDate: r.TxnDate ?? null,
      DueDate: r.DueDate ?? null,
      TotalAmt: money(amt),
      Balance: money(bal),
    };
    if (r.SalesTermRef?.name) row.Terms = r.SalesTermRef.name;
    if (toolName === "search_invoices") {
      if (r.EmailStatus) row.EmailStatus = r.EmailStatus;
      if (r.BillEmail?.Address) row.BillEmail = r.BillEmail.Address;
    }
    rows.push(row);
  }

  const note =
    "Each record shows its key fields only. totalBalance and totalAmount are the exact sums of the records listed; use them instead of adding numbers up. " +
    `For line items or other detail, call ${kind.detailTool} with the record's Id. Id is internal: never show it to the user` +
    (toolName === "search_bills"
      ? ". DocNumber null means the bill has no bill number in QuickBooks: describe it by vendor, date and amount, without mentioning DocNumber."
      : "; refer to invoices by DocNumber.");

  return {
    content: [{
      type: "text",
      text: JSON.stringify({ found, [kind.key]: rows, totalBalance: money(totalBalance), totalAmount: money(totalAmount), note }),
    }],
  };
}
