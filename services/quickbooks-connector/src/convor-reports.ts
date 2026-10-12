// Convor: turns QuickBooks report JSON into rows whose values are keyed by
// column title, so a model never has to map positional cells to columns.
// Lossless by construction and checked: if the number of non-empty cells
// differs from the original, the caller keeps the original report.

type Col = { title: string; type?: string; start?: string; end?: string };

const TOTAL_TITLES = new Set(["total", "totals"]);

function metaMap(list: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(list)) for (const m of list) if (m && typeof m.Name === "string") out[m.Name] = String(m.Value ?? "");
  return out;
}

function isNumeric(v: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(v.replace(/,/g, "").trim());
}

/** Counts every non-empty cell value in the original report (all columns). */
function countCells(rows: any): number {
  let n = 0;
  const visit = (list: any) => {
    if (!Array.isArray(list)) return;
    for (const r of list) {
      for (const cd of [r?.Header?.ColData, r?.ColData, r?.Summary?.ColData]) {
        if (Array.isArray(cd)) for (const c of cd) if (c && c.value !== undefined && c.value !== null && String(c.value) !== "") n++;
      }
      visit(r?.Rows?.Row);
    }
  };
  visit(rows);
  return n;
}

export function isQuickBooksReport(obj: any): boolean {
  return !!(obj && typeof obj === "object" && obj.Header && obj.Columns && Array.isArray(obj.Columns.Column));
}

export function flattenReport(rep: any): any | null {
  if (!isQuickBooksReport(rep)) return null;
  const h = rep.Header || {};
  const options = metaMap(h.Option);

  // Column titles, made unique so no value can overwrite another.
  const seen = new Map<string, number>();
  const cols: Col[] = rep.Columns.Column.map((c: any, i: number) => {
    const md = metaMap(c?.MetaData);
    let title = String(c?.ColTitle ?? "").trim();
    if (!title) title = i === 0 ? "Name" : (md.ColKey ? String(md.ColKey) : `Column ${i + 1}`);
    const k = title.toLowerCase();
    const count = (seen.get(k) || 0) + 1;
    seen.set(k, count);
    if (count > 1) title = `${title} (${count})`;
    const col: Col = { title };
    if (c?.ColType) col.type = String(c.ColType);
    if (md.StartDate) col.start = md.StartDate;
    if (md.EndDate) col.end = md.EndDate;
    return col;
  });
  const labelCol = 0;

  const rows: any[] = [];
  let cells = 0;
  const toRow = (colData: any[], kind: string, group: string[]) => {
    if (!Array.isArray(colData)) return;
    if (colData.length > cols.length) throw new Error("more cells than columns");
    const first = colData[labelCol] || {};
    const row: any = { kind };
    if (group.length) row.group = group.join(" > ");
    const label = first.value !== undefined && first.value !== null ? String(first.value) : "";
    row.label = label;
    if (label !== "") cells++;
    if (first.id !== undefined && first.id !== null && String(first.id) !== "") row.id = String(first.id);
    const values: Record<string, string> = {};
    for (let i = 0; i < colData.length; i++) {
      if (i === labelCol) continue;
      const v = colData[i]?.value;
      if (v === undefined || v === null || String(v) === "") continue;
      values[cols[i].title] = String(v);
      cells++;
    }
    row.values = values;
    if (kind !== "line" || label !== "" || Object.keys(values).length) rows.push(row);
  };

  const walk = (list: any, group: string[]) => {
    if (!Array.isArray(list)) return;
    for (const r of list) {
      if (!r || typeof r !== "object") continue;
      const sectionLabel = r.Header?.ColData?.[labelCol]?.value ? String(r.Header.ColData[labelCol].value) : "";
      if (r.Header?.ColData) toRow(r.Header.ColData, "heading", group);
      const inner = sectionLabel ? [...group, sectionLabel] : group;
      if (r.ColData) toRow(r.ColData, "line", group);
      if (r.Rows?.Row) walk(r.Rows.Row, inner);
      if (r.Summary?.ColData) toRow(r.Summary.ColData, "total", inner);
    }
  };
  walk(rep.Rows?.Row, []);

  // Never hide anything: every non-empty original cell must be present.
  const original = countCells(rep.Rows?.Row);
  if (original !== cells) throw new Error(`cell count mismatch ${original} != ${cells}`);

  // Headings with no amounts carry no information beyond the group path.
  const kept = rows.filter((r) => !(r.kind === "heading" && Object.keys(r.values).length === 0));

  // Period columns (e.g. months) with any non-zero posted amount. Totals are
  // excluded; headings count because a parent account can hold its own postings.
  const periodCols = cols.filter((c, i) => i !== labelCol && c.start && !TOTAL_TITLES.has(c.title.toLowerCase()));
  const withActivity = periodCols
    .filter((c) => rows.some((r) => (r.kind === "line" || r.kind === "heading") && r.values[c.title] !== undefined && isNumeric(r.values[c.title]) && Number(r.values[c.title].replace(/,/g, "")) !== 0))
    .map((c) => c.title);

  const out: any = {
    report: h.ReportName,
    basis: h.ReportBasis,
    startPeriod: h.StartPeriod,
    endPeriod: h.EndPeriod,
    summarizeColumnsBy: h.SummarizeColumnsBy,
    currency: h.Currency,
    noReportData: options.NoReportData === "true",
  };
  for (const k of ["Customer", "Vendor", "Item", "Department", "Class"]) if (h[k]) out[k.toLowerCase()] = h[k];
  const extra = Object.fromEntries(Object.entries(options).filter(([k]) => k !== "NoReportData"));
  if (Object.keys(extra).length) out.options = extra;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  out.columns = cols.slice(1);
  if (periodCols.length > 1) {
    out.columnsWithActivity = withActivity;
    out.latestColumnWithActivity = withActivity.length ? withActivity[withActivity.length - 1] : null;
  }
  out.howToRead =
    "Each row's values are keyed by the exact column title; use those titles as the period or aging labels. " +
    "kind 'total' rows are QuickBooks' own totals and subtotals for the group named in 'group'. " +
    "Rows that share a group are its parts (for example sub-accounts, or a customer's sub-customers/jobs), so do not add a group's total to its parts. " +
    "A kind 'heading' row with values holds only the amounts posted directly to that parent; its full amount is in the matching 'Total ...' row. " +
    "Blank cells are omitted. 'id' is QuickBooks' internal Id, for use in other tools only.";
  out.rows = kept;
  return out;
}
