#!/bin/sh
# Rebuilds out/quickbooks-connector.mjs from Intuit's pinned source + Convor wrapper.
set -e
Q=$(cd "$(dirname "$0")" && pwd)
cp "$Q/connector/convor-preflight.ts" "$Q/connector/convor-connector.ts" "$Q/connector/convor-reports.ts" "$Q/connector/convor-calc.ts" "$Q/connector/convor-lists.ts" "$Q/connector/convor-answers.ts" "$Q/src/src/"
cd "$Q/src"
"$Q/tools/node_modules/.bin/esbuild" src/convor-connector.ts --bundle --platform=node --target=node20 --format=esm \
  --outfile="$Q/out/quickbooks-connector.mjs" \
  --banner:js="import { createRequire as __convorCreateRequire } from 'module'; const require = __convorCreateRequire(import.meta.url);" \
  --legal-comments=eof --log-level=warning
sha256sum "$Q/out/quickbooks-connector.mjs"
