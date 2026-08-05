#!/bin/sh
# Copyright (c) 2026 Circle Internet Services, Inc.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy of
# this software and associated documentation files (the "Software"), to deal in
# the Software without restriction, including without limitation the rights to
# use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
# the Software, and to permit persons to whom the Software is furnished to do so,
# subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
# FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
# COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
# IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
# CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
#
# SPDX-License-Identifier: MIT

# install.sh -- installs the circleci-editor binary.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/CircleCI-Labs/circleci-editor/main/scripts/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- v1.2.3
#   VERSION=v1.2.3 ./install.sh
#
# The binary is installed as "circleci-editor" so that, once it is on
# your PATH, the CircleCI CLI picks it up as a plugin and you can run it as
# `circleci editor`.
#
# This script is POSIX sh (no bashisms) so it works under `sh`, dash, and
# similar minimal shells, not just bash.
set -eu

REPO="CircleCI-Labs/circleci-editor"
BINARY_NAME="circleci-editor"
GITHUB="https://github.com/${REPO}"
API="https://api.github.com/repos/${REPO}"

# print_usage prints --help text.
print_usage() {
  cat <<EOF
install.sh -- install ${BINARY_NAME}

Usage:
  install.sh [options] [version]

Arguments:
  version         Release tag to install, e.g. "v1.2.3" (default: latest).
                   Equivalent to setting \$VERSION.

Options:
  -h, --help       Show this help text and exit.
  --print-target   Print the detected OS/architecture target and exit,
                    without downloading or installing anything. Useful for
                    debugging OS/arch detection on an unfamiliar machine.

Environment variables:
  VERSION          Same as passing a version argument.
  INSTALL_DIR      Directory to install into (default: /usr/local/bin,
                    falling back to \$HOME/.local/bin if that is not
                    writable).

Examples:
  curl -fsSL ${GITHUB}/releases/latest/download/../install.sh | sh
  curl -fsSL .../install.sh | sh -s -- v1.2.3
  VERSION=v1.2.3 INSTALL_DIR="\$HOME/bin" ./install.sh
EOF
}

# log prints an informational message to stderr, so stdout stays clean for
# any command substitution callers (e.g. --print-target) might do.
log() {
  echo "install.sh: $*" >&2
}

# die prints an error message to stderr and exits non-zero.
die() {
  echo "install.sh: error: $*" >&2
  exit 1
}

# need requires that a command exists, dying with a clear message if not.
need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    die "required command not found: $1"
  fi
}

# detect_os prints the goreleaser-style OS name for this machine ("linux" or
# "darwin"), or dies with a clear message for anything else (including
# Windows, where this script cannot help -- msys/cygwin/mingw report a
# uname like "MINGW64_NT-10.0", not "Linux"/"Darwin").
detect_os() {
  uname_s=$(uname -s)
  case "$uname_s" in
    Linux) echo linux ;;
    Darwin) echo darwin ;;
    MINGW* | MSYS* | CYGWIN*)
      die "Windows is not supported by this script. Download a release archive (a .zip) directly from ${GITHUB}/releases and put circleci-editor.exe on your PATH."
      ;;
    *)
      die "unsupported OS: ${uname_s}. See ${GITHUB}/releases for available release archives."
      ;;
  esac
}

# detect_arch prints the goreleaser-style architecture name for this machine
# ("amd64" or "arm64"), or dies with a clear message for anything else.
detect_arch() {
  uname_m=$(uname -m)
  case "$uname_m" in
    x86_64 | amd64) echo amd64 ;;
    aarch64 | arm64) echo arm64 ;;
    *)
      die "unsupported architecture: ${uname_m}. See ${GITHUB}/releases for available release archives."
      ;;
  esac
}

# not_found_access_hint prints (to stdout, for callers to embed in a `die`
# message) the two most likely reasons a GitHub API/release request 404s
# for this project specifically, and a workaround for whichever of them
# applies. Written as its own function since both `resolve_version` and
# `main`'s archive download hit this exact ambiguity, and a plain "404 /
# not found" would otherwise read as a corrupt/broken install rather than
# something the user (or a teammate with repo access) can act on.
not_found_access_hint() {
  cat <<EOF
This can mean either:
  - no matching release has been published yet, or
  - this repository is not public yet, and GitHub does not serve release
    data to an unauthenticated request for a private/internal repository.
If you have access to ${GITHUB}, try the GitHub CLI instead, which
authenticates as you:
  gh release download ${1:-<tag>} --repo ${REPO}
Otherwise, ask the team whether a release has been published yet.
EOF
}

# fetch_status downloads $1 into $2 and prints the resulting HTTP status
# code (or "000" if the connection itself failed, matching curl's own
# convention for -w '%{http_code}'). Deliberately does not use curl's `-f`
# here (unlike elsewhere in this script): callers need the actual status
# code to tell "no release published / private repo" (404) apart from a
# genuine network failure, which `-f` alone can't distinguish -- it just
# makes curl exit non-zero for both.
#
# The trailing `|| true` is load-bearing under `set -e`: a hard failure
# (e.g. DNS resolution) makes curl itself exit non-zero, and this function
# is always called as `status=$(fetch_status ...)` -- without `|| true`,
# that non-zero status would trip `set -e` and kill the whole script right
# here, before the caller ever gets to check `status` and print a proper
# "network error" message via `die`.
fetch_status() {
  url=$1
  out=$2
  curl -sSL -o "$out" -w '%{http_code}' "$url" 2>/dev/null || true
}

# resolve_version prints the release tag to install: $1 if non-empty,
# otherwise $VERSION if set and non-empty, otherwise the latest release tag
# resolved from the GitHub API.
resolve_version() {
  requested=${1:-}
  if [ -n "$requested" ]; then
    echo "$requested"
    return
  fi
  if [ -n "${VERSION:-}" ]; then
    echo "$VERSION"
    return
  fi

  log "resolving latest release from ${API}/releases/latest"
  latest_json_file=$(mktemp "${TMPDIR:-/tmp}/circleci-editor-latest.XXXXXX")
  status=$(fetch_status "${API}/releases/latest" "$latest_json_file")

  if [ -z "$status" ] || [ "$status" = "000" ]; then
    rm -f "$latest_json_file"
    die "network error reaching ${API}/releases/latest. Check your connection, or pass an explicit version instead, e.g.: install.sh v1.2.3"
  fi
  if [ "$status" = "404" ]; then
    rm -f "$latest_json_file"
    die "$(printf '%s\n%s' "no release found: ${API}/releases/latest returned HTTP 404." "$(not_found_access_hint)")"
  fi
  if [ "$status" != "200" ]; then
    rm -f "$latest_json_file"
    die "unexpected HTTP ${status} from ${API}/releases/latest. Pass an explicit version instead, e.g.: install.sh v1.2.3"
  fi

  # Extract the "tag_name" field without depending on jq being installed.
  # This is a plain string match against a known, simple JSON shape (the
  # GitHub REST API), not a general JSON parser.
  tag=$(grep '"tag_name"' "$latest_json_file" | head -n 1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')
  rm -f "$latest_json_file"
  if [ -z "$tag" ]; then
    die "could not determine the latest release tag from the GitHub API response"
  fi
  echo "$tag"
}

# sha256_of prints the lowercase hex sha256 digest of the file at $1, using
# whichever of shasum/sha256sum is available.
sha256_of() {
  file=$1
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    die "neither shasum nor sha256sum is available; cannot verify download integrity"
  fi
}

main() {
  show_target_only=false
  version_arg=""

  while [ $# -gt 0 ]; do
    case "$1" in
      -h | --help)
        print_usage
        exit 0
        ;;
      --print-target)
        show_target_only=true
        shift
        ;;
      --)
        shift
        ;;
      -*)
        die "unknown option: $1 (see --help)"
        ;;
      *)
        if [ -n "$version_arg" ]; then
          die "unexpected extra argument: $1"
        fi
        version_arg=$1
        shift
        ;;
    esac
  done

  os=$(detect_os)
  arch=$(detect_arch)

  if [ "$show_target_only" = true ]; then
    echo "os=${os} arch=${arch} target=${os}_${arch}"
    exit 0
  fi

  need curl
  need tar

  tag=$(resolve_version "$version_arg")
  # GoReleaser's {{.Version}} (used in archive file names) is the tag with
  # any leading "v" stripped, while the release/download URL path uses the
  # tag exactly as published (e.g. release-please tags Go modules "v1.2.3").
  archive_version=${tag#v}

  archive_name="${BINARY_NAME}_${archive_version}_${os}_${arch}.tar.gz"
  base_url="${GITHUB}/releases/download/${tag}"
  archive_url="${base_url}/${archive_name}"
  checksums_url="${base_url}/checksums.txt"

  workdir=$(mktemp -d "${TMPDIR:-/tmp}/circleci-editor-install.XXXXXX")
  trap 'rm -rf "$workdir"' EXIT INT TERM

  log "installing ${BINARY_NAME} ${tag} (${os}/${arch})"
  log "downloading ${archive_url}"
  archive_status=$(fetch_status "$archive_url" "${workdir}/${archive_name}")
  if [ -z "$archive_status" ] || [ "$archive_status" = "000" ]; then
    die "network error downloading ${archive_url}. Check your connection and try again."
  fi
  if [ "$archive_status" = "404" ]; then
    die "$(printf '%s\n%s' "release asset not found: ${archive_url} returned HTTP 404 (release ${tag} may not have a build for ${os}/${arch})." "$(not_found_access_hint "$tag")")"
  fi
  if [ "$archive_status" != "200" ]; then
    die "unexpected HTTP ${archive_status} downloading ${archive_url}"
  fi

  log "downloading ${checksums_url}"
  checksums_status=$(fetch_status "$checksums_url" "${workdir}/checksums.txt")
  if [ -z "$checksums_status" ] || [ "$checksums_status" = "000" ]; then
    die "network error downloading ${checksums_url}. Check your connection and try again."
  fi
  if [ "$checksums_status" = "404" ]; then
    die "$(printf '%s\n%s' "checksums not found: ${checksums_url} returned HTTP 404." "$(not_found_access_hint "$tag")")"
  fi
  if [ "$checksums_status" != "200" ]; then
    die "unexpected HTTP ${checksums_status} downloading ${checksums_url}"
  fi

  log "verifying checksum"
  checksum_line=$(grep " ${archive_name}\$" "${workdir}/checksums.txt" || true)
  if [ -z "$checksum_line" ]; then
    die "no checksum entry for ${archive_name} in checksums.txt"
  fi
  expected_sum=$(printf '%s\n' "$checksum_line" | awk '{print $1}')
  actual_sum=$(sha256_of "${workdir}/${archive_name}")
  if [ "$expected_sum" != "$actual_sum" ]; then
    die "checksum mismatch for ${archive_name}: expected ${expected_sum}, got ${actual_sum}"
  fi
  log "checksum OK"

  log "extracting"
  tar -xzf "${workdir}/${archive_name}" -C "$workdir" "$BINARY_NAME"

  install_dir=${INSTALL_DIR:-/usr/local/bin}
  if [ ! -d "$install_dir" ] || [ ! -w "$install_dir" ]; then
    fallback_dir="${HOME}/.local/bin"
    log "${install_dir} is not writable; falling back to ${fallback_dir}"
    install_dir=$fallback_dir
    mkdir -p "$install_dir"
  fi

  dest="${install_dir}/${BINARY_NAME}"
  cp "${workdir}/${BINARY_NAME}" "$dest"
  chmod +x "$dest"

  log "installed ${dest}"

  case ":${PATH}:" in
    *":${install_dir}:"*) ;;
    *)
      log "warning: ${install_dir} is not on your PATH."
      log "Add it, e.g.: export PATH=\"${install_dir}:\$PATH\""
      ;;
  esac

  log "done. Run '${BINARY_NAME} --version' to verify, or 'circleci editor' if the CircleCI CLI is installed."
}

main "$@"
