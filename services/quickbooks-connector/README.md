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
  period reports (`src/convor-reports.ts`). The rewrite is checked cell by cell; if anything does
  not match, the original QuickBooks report is returned instead.
- Each tool call is logged with its name, parameters, duration and result size (no credentials).
- Tools take their arguments at the top level (for example `{"end_date": "2026-09-30"}`) instead of upstream's
  single `params` wrapper, which models often omitted on the first call. Handlers still receive `{ params }`,
  and unknown arguments are reported and stripped as upstream does (`registerFlat` in `src/convor-connector.ts`).
- `search_invoices` and `search_bills` results are compacted to each record's key fields (number, customer or
  vendor, dates, total, balance, terms) plus `totalBalance` / `totalAmount`, exact sums computed by the connector,
  so the assistant never adds up long lists itself (`src/convor-lists.ts`). Anything unexpected keeps the original
  result. Full detail stays available through `read_invoice` and `get-bill`.

Rebuild: clone upstream at the pinned commit into `src/` next to `build.sh`, `npm ci`, install
`esbuild@0.25.10` into `tools/`, then run `build.sh`.
