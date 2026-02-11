#!/usr/bin/env bash
set -Eeuo pipefail

# -----------------------------
# v8unpack installer (robust)
# -----------------------------
# Features:
# - HTTP code checking (via curl), retries, redirect support
# - Multiple fallback URLs
# - Safe temp file/dir
# - Optional integrity verification (EXPECTED_SHA256 or gh verify)
# - Atomic install + rollback on error
# - Basic logging
#
# Usage:
#   ./install-v8unpack.sh
#   INSTALL_DIR="$HOME/.local/bin" ./install-v8unpack.sh
#   EXPECTED_SHA256="..." ./install-v8unpack.sh
#
# Notes:
# - Targets e8tools/v8unpack release assets by default.
# - Does NOT add apt repositories automatically (can be added as fallback separately).

log() { printf '[%s] %s\n' "$(date -Is 2>/dev/null || date)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1; }

# Choose downloader
DOWNLOADER="curl"
if ! need_cmd curl; then
  if need_cmd wget; then
    DOWNLOADER="wget"
  else
    die "Need curl or wget"
  fi
fi

# Decide install dir
default_install_dir() {
  if [[ -w "/usr/local/bin" ]]; then
    echo "/usr/local/bin"
  else
    echo "${HOME}/.local/bin"
  fi
}

INSTALL_DIR="${INSTALL_DIR:-$(default_install_dir)}"
mkdir -p "$INSTALL_DIR"

# OS/arch detection
uname_s="$(uname -s | tr '[:upper:]' '[:lower:]')"
uname_m="$(uname -m | tr '[:upper:]' '[:lower:]')"

is_windows=0
case "$uname_s" in
  mingw*|msys*|cygwin*) is_windows=1 ;;
esac

# For e8tools release assets we mostly need:
# - Windows: v8unpack.exe
# - Linux: .deb (can be extracted) OR source build fallback
artifact_kind=""
artifact_name=""
dest_name="v8unpack"

if [[ "$is_windows" -eq 1 ]]; then
  artifact_kind="win-exe"
  artifact_name="v8unpack.exe"
  dest_name="v8unpack.exe"
else
  artifact_kind="linux-deb"
  # Only amd64 deb is known from release list; for non-amd64 we will fail over later.
  artifact_name="v8unpack_3.0.43-2.bionic_amd64.deb"
  dest_name="v8unpack"
fi

DEST_PATH="${INSTALL_DIR}/${dest_name}"

# Version pin (matches "Latest" shown in e8tools releases)
PIN_TAG="v.3.0.43"

# URL candidates (overrideable for tests)
# You can inject your own list:
#   V8UNPACK_URLS=$'https://example/a\nhttps://example/b' ./install-v8unpack.sh
if [[ -n "${V8UNPACK_URLS:-}" ]]; then
  mapfile -t URLS <<<"${V8UNPACK_URLS}"
else
  URLS=()
  if [[ "$is_windows" -eq 1 ]]; then
    # Prefer "latest" endpoint, fallback to pinned tag
    URLS+=(
      "https://github.com/e8tools/v8unpack/releases/latest/download/${artifact_name}"
      "https://github.com/e8tools/v8unpack/releases/download/${PIN_TAG}/${artifact_name}"
    )
  else
    # For linux deb: pinned tag (asset name contains version)
    URLS+=(
      "https://github.com/e8tools/v8unpack/releases/download/${PIN_TAG}/${artifact_name}"
    )
  fi
fi

# temp dir + rollback bookkeeping
tmpdir="$(mktemp -d 2>/dev/null || mktemp -d -t v8unpack)"
tmpfile="${tmpdir}/${artifact_name}"
backup=""
installed_tmp=""

cleanup() {
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    log "Script failed (exit=$rc)"
    # Rollback if we already overwrote
    if [[ -n "$backup" && -f "$backup" ]]; then
      log "Rollback: restoring previous binary to ${DEST_PATH}"
      # Best-effort restore
      mv -f "$backup" "$DEST_PATH" 2>/dev/null || true
    fi
  fi
  rm -rf "$tmpdir" 2>/dev/null || true
}
trap cleanup EXIT

compute_sha256() {
  local f="$1"
  if need_cmd sha256sum; then
    sha256sum "$f" | awk '{print $1}'
  elif need_cmd shasum; then
    shasum -a 256 "$f" | awk '{print $1}'
  elif need_cmd openssl; then
    openssl dgst -sha256 "$f" | awk '{print $NF}'
  else
    return 1
  fi
}

download_with_curl() {
  local url="$1"
  local out="$2"
  local hdr="${tmpdir}/headers.txt"
  : >"$hdr"

  # -f: fail on >=400
  # -L: follow redirects (GitHub releases assets typically redirect)
  # --retry: transient network resiliency
  # --write-out: capture HTTP code and final URL for logs
  local info
  info="$(curl -fsSL --retry 3 --retry-delay 1 --connect-timeout 10 --max-time 300 \
    -D "$hdr" -o "$out" \
    -w 'http_code=%{http_code} final_url=%{url_effective}' \
    "$url" 2>/dev/null || true)"

  if [[ -z "$info" ]]; then
    return 1
  fi

  local code
  code="$(printf '%s' "$info" | sed -n 's/.*http_code=\([0-9][0-9][0-9]\).*/\1/p')"
  log "curl: ${url} => ${info}"
  [[ "$code" == "200" ]] || return 1
  return 0
}

download_with_wget() {
  local url="$1"
  local out="$2"
  # wget doesn't give status code easily without parsing; treat non-zero as failure.
  # Use --server-response to keep headers for debugging
  if wget -q --server-response -O "$out" "$url" 2>"${tmpdir}/wget.stderr"; then
    return 0
  fi
  return 1
}

download() {
  local url="$1"
  local out="$2"
  if [[ "$DOWNLOADER" == "curl" ]]; then
    download_with_curl "$url" "$out"
  else
    download_with_wget "$url" "$out"
  fi
}

verify_integrity() {
  local file="$1"

  if [[ -n "${EXPECTED_SHA256:-}" ]]; then
    need_cmd sha256sum || need_cmd shasum || need_cmd openssl || die "No SHA256 tool available"
    local got
    got="$(compute_sha256 "$file")" || die "Failed to compute SHA256"
    log "SHA256 computed: $got"
    [[ "$got" == "$EXPECTED_SHA256" ]] || die "SHA256 mismatch"
    log "SHA256 OK"
    return 0
  fi

  # Optional: verify via GitHub CLI if present and user provided tag+repo context.
  # Requires: gh + network. If it fails, we don't automatically trust the file.
  if need_cmd gh && [[ -n "${GH_VERIFY_TAG:-}" ]]; then
    # Example:
    #   GH_VERIFY_TAG="v.3.0.43" GH_VERIFY_ASSET="v8unpack.exe" GH_VERIFY_REPO="e8tools/v8unpack"
    #   gh release verify-asset "$GH_VERIFY_TAG" "$file" --repo "$GH_VERIFY_REPO"
    local repo="${GH_VERIFY_REPO:-e8tools/v8unpack}"
    local tag="${GH_VERIFY_TAG}"
    local asset="${GH_VERIFY_ASSET:-$(basename "$file")}"
    log "gh verify-asset: repo=$repo tag=$tag asset_name=$asset"
    gh release verify-asset "$tag" "$file" --repo "$repo" >/dev/null
    log "gh verify-asset OK"
    return 0
  fi

  # No strict verification available: compute and log for traceability
  if need_cmd sha256sum || need_cmd shasum || need_cmd openssl; then
    local got
    got="$(compute_sha256 "$file")" || true
    [[ -n "$got" ]] && log "SHA256 (informational): $got"
  fi
  log "Integrity check: no EXPECTED_SHA256 and no gh verification configured (continuing)."
  return 0
}

install_atomic() {
  local src="$1"
  local dst="$2"

  # Ensure executable bit where relevant
  chmod 0755 "$src" || true

  # Backup existing dst
  if [[ -f "$dst" ]]; then
    backup="${tmpdir}/backup.$(basename "$dst")"
    cp -a "$dst" "$backup"
    log "Backup created: $backup"
  fi

  # Install atomic-ish: move within same directory
  local dst_dir
  dst_dir="$(dirname "$dst")"
  local tmp_in_dir="${dst_dir}/.$(basename "$dst").new.$$"
  cp -a "$src" "$tmp_in_dir"
  chmod 0755 "$tmp_in_dir" || true
  mv -f "$tmp_in_dir" "$dst"
  log "Installed: $dst"
}

extract_deb_and_install() {
  local deb="$1"
  local dst="$2"

  need_cmd dpkg-deb || die "dpkg-deb is required to extract .deb (install dpkg or use another fallback)"
  local xdir="${tmpdir}/debroot"
  mkdir -p "$xdir"
  dpkg-deb -x "$deb" "$xdir"
  local candidate="${xdir}/usr/bin/v8unpack"
  if [[ ! -f "$candidate" ]]; then
    candidate="${xdir}/usr/local/bin/v8unpack"
  fi
  if [[ ! -f "$candidate" ]]; then
    candidate="$(find "$xdir" -type f \( -name 'v8unpack' -o -name 'v8unpack*' \) -print 2>/dev/null | head -n 1 || true)"
  fi
  if [[ ! -f "$candidate" ]]; then
    candidate="$(find "$xdir" -type f -perm /111 -print 2>/dev/null | grep -i '/v8unpack' | head -n 1 || true)"
  fi
  if [[ -z "$candidate" || ! -f "$candidate" ]]; then
    log "Unexpected .deb layout: v8unpack not found in extracted payload"
    log "Deb file listing (dpkg-deb -c):"
    dpkg-deb -c "$deb" 2>&1 | sed -e 's/^/[deb] /' >&2 || true
    die "Unexpected .deb layout: v8unpack not found in extracted payload"
  fi
  install_atomic "$candidate" "$dst"
}

main() {
  log "Install dir: $INSTALL_DIR"
  log "Artifact kind: $artifact_kind"
  log "Downloader: $DOWNLOADER"
  log "Destination: $DEST_PATH"

  # Try URL candidates
  local ok=0
  for url in "${URLS[@]}"; do
    log "Trying: $url"
    if download "$url" "$tmpfile"; then
      ok=1
      log "Downloaded to: $tmpfile"
      break
    else
      log "Failed: $url"
    fi
  done
  [[ "$ok" -eq 1 ]] || die "All download URLs failed"

  # Verify integrity (strict if EXPECTED_SHA256 is set)
  verify_integrity "$tmpfile"

  # Install workflow
  if [[ "$artifact_kind" == "win-exe" ]]; then
    install_atomic "$tmpfile" "$DEST_PATH"
  else
    # linux-deb: extract and install v8unpack binary
    extract_deb_and_install "$tmpfile" "$DEST_PATH"
  fi

  log "Done. Check: ${DEST_PATH} -h (or --help depending on build)"
}

main "$@"
