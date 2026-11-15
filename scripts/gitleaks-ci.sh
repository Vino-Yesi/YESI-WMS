#!/usr/bin/env bash
#
# Pinned gitleaks runner for CI.
#
# Why this exists: `gitleaks/gitleaks-action@v2` decides whether it is allowed to
# run by asking the GitHub API for the repository owner's type, and if that call
# fails for any reason it falls back to "licence required" and exits 1 without
# scanning anything. That made the secret-scan step fail intermittently on this
# personal-account repository, which needs no licence at all. It also floats on a
# mutable tag. This script pins the CLI version and verifies the downloaded
# archive's SHA-256 against the checksums published with the same release, so the
# scan either runs the exact binary we asked for or fails loudly.
#
# Usage:
#   scripts/gitleaks-ci.sh <version> <range|history> [base-sha]
#
#   range    scan only the commits introduced by the current CI event. Requires a
#            base SHA (pull_request base, or the `before` SHA of a push). With no
#            usable base — a brand-new branch or a force-push — it scans the tip
#            commit only and says so; the pull_request run for the same branch
#            still covers the whole base..head range.
#   history  scan every commit. Used by the advisory nightly audit, because a
#            secret committed long ago cannot hide behind an unrelated diff.
#
# Environment:
#   GITLEAKS_BIN      use this binary and skip the download + checksum step
#                     (air-gapped runners and local testing; CI does not set it)
#   GITLEAKS_BIN_DIR  where to unpack the binary (default: ./.gitleaks-bin)
#   GITLEAKS_REPORT   report path for history mode (default: ./gitleaks-full-history.json)

set -euo pipefail

VERSION="${1:-8.30.1}"
MODE="${2:-range}"
BASE="${3:-}"
BIN_DIR="${GITLEAKS_BIN_DIR:-$PWD/.gitleaks-bin}"
REPORT="${GITLEAKS_REPORT:-$PWD/gitleaks-full-history.json}"

case "$MODE" in
  range|history) ;;
  *) echo "usage: $0 <version> <range|history> [base-sha]" >&2; exit 2 ;;
esac

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "gitleaks-ci: not a git repository" >&2
  exit 2
fi

if [ -n "${GITLEAKS_BIN:-}" ]; then
  # Escape hatch for air-gapped runners and local testing: use a binary that is
  # already present and skip the download. CI does not set this.
  gitleaks="$GITLEAKS_BIN"
  echo "gitleaks-ci: using GITLEAKS_BIN=${gitleaks}; download and checksum verification skipped"
else
  mkdir -p "$BIN_DIR"
  archive="$BIN_DIR/gitleaks.tar.gz"
  checksums="$BIN_DIR/gitleaks-checksums.txt"
  release_url="https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}"
  asset="gitleaks_${VERSION}_linux_x64.tar.gz"

  echo "gitleaks-ci: fetching v${VERSION}"
  if ! curl -fsSL -o "$archive" "${release_url}/${asset}"; then
    echo "gitleaks-ci: could not download ${release_url}/${asset}" >&2
    exit 1
  fi
  if ! curl -fsSL -o "$checksums" "${release_url}/gitleaks_${VERSION}_checksums.txt"; then
    echo "gitleaks-ci: could not download the published checksums for v${VERSION}" >&2
    exit 1
  fi

  expected="$(awk -v f="$asset" '$NF == f { print $1; exit }' "$checksums")"
  if [ -z "$expected" ]; then
    echo "gitleaks-ci: ${asset} is not listed in the published checksums" >&2
    exit 1
  fi
  actual="$(sha256sum "$archive" | awk '{ print $1 }')"
  if [ "$expected" != "$actual" ]; then
    echo "gitleaks-ci: checksum mismatch for ${asset}" >&2
    echo "  published:  $expected" >&2
    echo "  downloaded: $actual" >&2
    exit 1
  fi
  echo "gitleaks-ci: sha256 verified ($actual)"

  tar -xzf "$archive" -C "$BIN_DIR" gitleaks
  chmod +x "$BIN_DIR/gitleaks"
  gitleaks="$BIN_DIR/gitleaks"
fi

if [ ! -x "$gitleaks" ]; then
  echo "gitleaks-ci: ${gitleaks} is not an executable binary" >&2
  exit 1
fi
"$gitleaks" version

# A base of all zeroes is what GitHub sends for a newly created branch.
case "$BASE" in
  ''|0000000*) BASE='' ;;
esac

if [ "$MODE" = "history" ]; then
  echo "gitleaks-ci: scanning the full git history"
  # `set -e` propagates gitleaks' exit code: findings fail the step, and the
  # workflow marks the nightly audit advisory so it never blocks an unrelated PR.
  "$gitleaks" git . --redact=100 --exit-code=1 \
    --report-format=json --report-path="$REPORT"
  exit 0
fi

if [ -n "$BASE" ] && git cat-file -e "${BASE}^{commit}" 2>/dev/null; then
  echo "gitleaks-ci: scanning commits introduced by this event (${BASE}..HEAD)"
  "$gitleaks" git . "--log-opts=${BASE}..HEAD" --redact=100 --exit-code=1
else
  echo "gitleaks-ci: no usable base commit; scanning the tip commit only."
  "$gitleaks" git . '--log-opts=-1' --redact=100 --exit-code=1
fi
