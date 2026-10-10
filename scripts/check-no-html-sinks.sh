#!/bin/sh
# Fail if frontend code uses an HTML-parsing DOM sink (DESIGN.md §7.3, §9.5).
# All untrusted text must reach the DOM as text nodes.
set -eu
cd "$(dirname "$0")/.."

pattern='innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|setHTMLUnsafe'
if grep -rnE "$pattern" web/src; then
  echo "error: HTML sink found in web/src (use dom.ts h()/textContent instead)" >&2
  exit 1
fi
echo "no HTML sinks in web/src"
