#!/usr/bin/env bash
set -euo pipefail

TARGET="/usr/local/bin/v8unpack"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

try_download() {
  local url="$1"
  if curl -fsSL "$url" -o "$TARGET"; then
    chmod +x "$TARGET"
    return 0
  fi
  return 1
}

# Try common locations (best effort).
if try_download "https://raw.githubusercontent.com/e8tools/v8unpack/main/v8unpack"; then
  echo "v8unpack installed from main branch"
  exit 0
fi

if try_download "https://raw.githubusercontent.com/e8tools/v8unpack/master/v8unpack"; then
  echo "v8unpack installed from master branch"
  exit 0
fi

echo "v8unpack download skipped; runtime fallback to raw compare will be used"
exit 0
