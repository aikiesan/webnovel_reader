#!/bin/sh
# Rebuild grab.min.js (single-line, comment-free) after editing grab.js.
set -e
npx --yes esbuild@0.25.0 grab.js --minify --charset=utf8 --target=chrome100 --log-level=warning \
  | python3 -c "import sys; s=sys.stdin.read().rstrip('\n'); sys.stdout.write(s.replace('\n','\\\\n'))" > grab.min.js
echo "grab.min.js: $(wc -c < grab.min.js) bytes, lines: $(wc -l < grab.min.js)"
cp grab.js extension/grab.js
echo "extension/grab.js updated"
rm -f novel-reader-extension.zip
(cd extension && zip -qr ../novel-reader-extension.zip . -x '.*')
echo "novel-reader-extension.zip: $(wc -c < novel-reader-extension.zip) bytes"
