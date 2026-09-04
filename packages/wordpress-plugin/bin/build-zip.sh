#!/usr/bin/env sh
# Build altorank.zip, the file that is uploaded to wordpress.org or installed
# through Plugins -> Add New -> Upload. The archive holds a single top-level
# `altorank/` directory, which is what WordPress expects.
set -eu

here="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$here/altorank.zip}"

version="$(sed -n 's/^ \* Version: *//p' "$here/altorank/altorank.php" | head -1)"
stable="$(sed -n 's/^Stable tag: *//p' "$here/altorank/readme.txt" | head -1)"
if [ "$version" != "$stable" ]; then
  echo "Version mismatch: altorank.php says $version, readme.txt says $stable" >&2
  exit 1
fi

if command -v php >/dev/null 2>&1; then
  find "$here/altorank" -name '*.php' -exec php -l {} \; >/dev/null
fi

rm -f "$out"
(cd "$here" && zip -qr "$out" altorank -x '*.DS_Store' -x '__MACOSX/*')
echo "wrote $out (version $version)"
