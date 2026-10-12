# QuickBooks connector (read-only)

Serves a read-only subset (38 tools: reports, lookups and searches) of Intuit's official
QuickBooks Online MCP server to the Convor LibreChat app over Streamable HTTP.

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

Rebuild: clone upstream at the pinned commit into `src/` next to `build.sh`, `npm ci`, install
`esbuild@0.25.10` into `tools/`, then run `build.sh`.
