#!/bin/sh
# Rebuild grab.min.js (single-line, comment-free) after editing grab.js.
set -e
npx --yes esbuild@0.25.0 grab.js --minify --charset=utf8 --target=chrome100 --log-level=warning \
  | python3 -c "import sys; s=sys.stdin.read().rstrip('\n'); sys.stdout.write(s.replace('\n','\\\\n'))" > grab.min.js
echo "grab.min.js: $(wc -c < grab.min.js) bytes, lines: $(wc -l < grab.min.js)"
