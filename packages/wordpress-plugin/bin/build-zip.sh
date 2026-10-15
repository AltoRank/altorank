#!/usr/bin/env sh
# Build altorank.zip, the file installed through Plugins -> Add New -> Upload
# (the plugin is not listed on wordpress.org; the app serves the same archive
# at /api/public/wordpress-plugin, built by apps/web/lib/cms/wordpress-plugin-zip.ts).
# The archive holds a single top-level `altorank/` directory, which is what
# WordPress expects.
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
  find "$here/altorank" "$here/tests" -name '*.php' -exec php -l {} \; >/dev/null
  php "$here/tests/run.php"
fi

rm -f "$out"
(cd "$here" && zip -qr "$out" altorank -x '*.DS_Store' -x '__MACOSX/*')
echo "wrote $out (version $version)"
