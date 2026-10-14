#!/usr/bin/env sh
# Assemble the static files the web page serves from their sources:
#   docs/pagewatch-core.js        <- web-src/pagewatch-core.js
#   docs/ticketwatch-page.user.js <- userscript header + shared core + userscript glue
#   docs/fetch-proxy.mjs          <- worker/fetch-proxy.mjs (copy-paste target for Cloudflare)
#
# Usage: scripts/build-pages-assets.sh          rebuild
#        scripts/build-pages-assets.sh --check  fail if the committed files are stale
set -eu
cd "$(dirname "$0")/.."

out="${TMPDIR:-/tmp}/ticketwatch-assets.$$"
mkdir -p "$out"
trap 'rm -rf "$out"' EXIT

cp web-src/pagewatch-core.js "$out/pagewatch-core.js"
cp worker/fetch-proxy.mjs "$out/fetch-proxy.mjs"
{
  cat web-src/userscript-header.txt
  printf '(function () {\n  '"'"'use strict'"'"';\n\n'
  cat web-src/pagewatch-core.js
  printf '\n'
  cat web-src/userscript-glue.js
  printf '})();\n'
} > "$out/ticketwatch-page.user.js"

if [ "${1:-}" = "--check" ]; then
  status=0
  for f in pagewatch-core.js ticketwatch-page.user.js fetch-proxy.mjs; do
    if ! cmp -s "$out/$f" "docs/$f"; then
      echo "docs/$f is stale: run scripts/build-pages-assets.sh" >&2
      status=1
    fi
  done
  exit $status
fi

cp "$out/pagewatch-core.js" "$out/ticketwatch-page.user.js" "$out/fetch-proxy.mjs" docs/
echo "Rebuilt docs/pagewatch-core.js, docs/ticketwatch-page.user.js, docs/fetch-proxy.mjs"
