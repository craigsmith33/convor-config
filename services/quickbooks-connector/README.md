# QuickBooks connector (read-only)

Serves a read-only subset (38 tools: reports, lookups and searches) of Intuit's official
QuickBooks Online MCP server to the Convor LibreChat app over Streamable HTTP, plus two Convor
tools: `search_customer_or_vendor` (read-only; finds a name in the customer and vendor lists at once)
and `calculate` (exact decimal arithmetic for totals, differences, percentages and ratios, so the
assistant never does mental math; it does not call QuickBooks, `src/convor-calc.ts`).

- Upstream: https://github.com/intuit/quickbooks-online-mcp-server at commit
  `31a1dd5c3e170e368dbff651abbaf61aabde6ed9` (Apache-2.0, see LICENSE-intuit-quickbooks-online-mcp-server).
  Upstream code is bundled unmodified; Convor's additions are in `src/`.
- `quickbooks-connector.mjs` is the single-file bundle the Railway service downloads at start
  (pinned by commit and SHA-256 in the service variables `CONNECTOR_URL` / `CONNECTOR_SHA256`).
- No create, update or delete tools are registered; the server refuses to start if one is listed.
- Requires `Authorization: Bearer $MCP_SHARED_SECRET` on `/mcp`. `/health` reports connection state.
- Rotated refresh tokens are kept on the service volume (`QUICKBOOKS_TOKEN_STORE_PATH`). Pasting a new
  refresh token into the Railway variables replaces the saved one automatically.
- Never falls back to Intuit's browser login; if the connection expires it says how to reconnect.
- Report results are rewritten so every amount is keyed by its column title (for example
  `"Nov 2025"` or `"91 and over"`), with `columnsWithActivity` / `latestColumnWithActivity` for
  period reports (`src/convor-reports.ts`), plus `latestPeriods`: the top-level totals for the latest period with activity
  and the period before it, so latest-month answers never depend on reading a wide table. The rewrite is checked cell by cell; if anything does
  not match, the original QuickBooks report is returned instead.
- Each tool call is logged with its name, parameters, duration and result size (no credentials).
- Tools take their arguments at the top level (for example `{"end_date": "2026-09-30"}`) instead of upstream's
  single `params` wrapper, which models often omitted on the first call. Handlers still receive `{ params }`,
  and unknown arguments are reported and stripped as upstream does (`registerFlat` in `src/convor-connector.ts`).
- Answer-ready tools (1.6, `src/convor-answers.ts`): `get_finance_snapshot`, `get_receivables_summary`,
  `get_payables_summary`, `get_top_customers`, `get_top_vendors`, `get_profit_comparison` and `get_customer_purchases`.
  Each gathers what a common question needs in one call and does the aging, sorting, ranking and arithmetic in code
  (exact cents), so the assistant only presents the result. Receivables and payables totals are cross-checked against
  QuickBooks' own aging reports (`matchesQuickBooksAgingReport`). "Today" is taken in `CONVOR_TIMEZONE`
  (default America/New_York).
- `search_invoices` and `search_bills` results are compacted to each record's key fields (number, customer or
  vendor, dates, total, balance, terms) plus `totalBalance` / `totalAmount`, exact sums computed by the connector,
  so the assistant never adds up long lists itself (`src/convor-lists.ts`). Anything unexpected keeps the original
  result. Full detail stays available through `read_invoice` and `get-bill`.

Rebuild: clone upstream at the pinned commit into `src/` next to `build.sh`, `npm ci`, install
`esbuild@0.25.10` into `tools/`, then run `build.sh`.

## 1.7: HubSpot sales tools (`src/convor-hubspot.ts`)

A second endpoint, `/mcp-crm`, serves the Sales Assistant. `/mcp` (Finance) keeps exactly its 47 QuickBooks tools.

- `get_sales_pipeline`, `get_deals_closing`, `get_deals_needing_attention`, `get_sales_followups`: read live from HubSpot.
- `get_account_brief`, `get_deals_with_past_due_balances`: HubSpot deals and activity joined with QuickBooks balances and sales by exact company name.
- Also served on `/mcp-crm`: `search_customer_or_vendor` and `calculate`.
- Read-only by construction: only GET requests and HubSpot's search, batch-read and association batch-read endpoints are allowed (`READ_ONLY_POSTS`); anything else is refused before it is sent.
- Every call reads HubSpot at that moment (no cache). Totals, weighting (amount x stage probability), staleness and date math are done in code.
- Variables: `HUBSPOT_TOKEN` (private app, read scopes only; redacted from logs and results); optional `HUBSPOT_DATASET_PROPERTY` / `HUBSPOT_DATASET_VALUE` to limit to tagged records (demo: `convor_demo_dataset` = `tallmark`); `HUBSPOT_PIPELINE_ID`; `HUBSPOT_PRODUCT_LINE_PROPERTY`.

## 1.8: proposal pricing (`src/convor-pricing.ts`)

`get_proposal_pricing` (on `/mcp-crm`) prices a quote or proposal exactly: list prices live from the QuickBooks item list, the customer's tier from their last 12 months of QuickBooks purchases, volume add-on, optional extra discount, caps, approvals, lead times, freight, payment terms, validity, configuration checks and past-due warnings, plus a ready Markdown pricing table. The price-guide rules (tiers, caps, approvals, lead times, freight) for the demo company are in `RULES`.

## 1.9: customer-facing proposal sections

`get_proposal_pricing` also returns `proposalSections`: ready Markdown for the Investment (pricing table, freight, payment terms, validity, items quoted separately), Timeline (built from the lead times), Why Tallmark and Warranty and support sections of a proposal. The assistant pastes them as given, so every row, date and term in the customer document comes from the connector. They contain nothing internal (no approvals, tiers or balances).

1.9.1 adds `proposalNumber`, `date` and `validUntil` to `proposalSections`, and `skuSuggestions` for SKUs that are not in the item list (suggestions only; nothing is substituted automatically).
