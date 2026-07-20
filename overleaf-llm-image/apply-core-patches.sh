#!/usr/bin/env bash
# apply-core-patches.sh
# -----------------------------------------------------------------------------
# Entry point invoked during the Docker build. Applies ONLY the functional core
# edits of PR #171 (the LLM AI Assistant) to the base image's Overleaf web source
# using the idempotent, anchor-based Node engine in patches/apply-core-patches.mjs.
#
# It is safe to re-run (idempotent) and FAILS LOUDLY (non-zero exit) if any
# anchor is missing, so a drifted base image cannot produce a half-patched build.
#
# Usage: apply-core-patches.sh [WEB_DIR]
#        WEB_DIR defaults to $WEB_DIR or /overleaf/services/web
# -----------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="${1:-${WEB_DIR:-/overleaf/services/web}}"
ENGINE="$HERE/patches/apply-core-patches.mjs"

if [ ! -f "$ENGINE" ]; then
  echo "apply-core-patches: engine not found at $ENGINE" >&2
  exit 1
fi
if [ ! -d "$WEB_DIR" ]; then
  echo "apply-core-patches: WEB_DIR does not exist: $WEB_DIR" >&2
  exit 1
fi

echo "apply-core-patches: patching core files in $WEB_DIR"
exec node "$ENGINE" "$WEB_DIR"
