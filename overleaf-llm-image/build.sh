#!/usr/bin/env bash
# build.sh
# -----------------------------------------------------------------------------
# Build the custom Overleaf image with the vendored LLM AI Assistant module.
#
# PREREQUISITE: vendor/llm/ must already be vendored into this directory (another
# step / agent populates it). This script does NOT clone anything and does NOT
# download the module - it only runs `docker build` on the local context.
#
# The base image (overleafcep/sharelatex:${BASE_VERSION}, where BASE_VERSION is
# read from config.env.local / config.env) must be available to the Docker daemon
# (locally present or pullable). Build needs network (npm), plenty of RAM for
# webpack (>= 8 GB recommended), and ~15-30 min. See README.md.
# -----------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- derive the CEP base version from config --------------------------------
# Build FROM overleafcep/sharelatex:<BASE_VERSION>, where BASE_VERSION follows
# OVERLEAF_IMAGE_TAG in config. Prefer config.env.local (the active, git-ignored
# config), fall back to the tracked config.env template, then a sane default.
# This way a base-version bump in config rebuilds on the new base next time.
read_image_tag() {
  # prints OVERLEAF_IMAGE_TAG from $1 with quotes/comment/whitespace stripped
  local file="$1" line
  [ -f "$file" ] || return 0
  line="$(grep -E '^[[:space:]]*OVERLEAF_IMAGE_TAG=' "$file" 2>/dev/null | tail -n 1 || true)"
  line="${line#*=}"     # drop key up to the first =
  line="${line%%#*}"    # drop any inline comment
  line="${line//\"/}"   # drop double quotes
  line="${line//\'/}"   # drop single quotes
  printf '%s' "$line" | tr -d '[:space:]'
}

BASE_VERSION="$(read_image_tag "$HERE/../config.env.local")"
if [ -z "$BASE_VERSION" ]; then
  BASE_VERSION="$(read_image_tag "$HERE/../config.env")"
fi
BASE_VERSION="${BASE_VERSION:-6.2.0-ext-v5.0}"

BASE_IMAGE="overleafcep/sharelatex:${BASE_VERSION}"
OUT_IMAGE="overleaf-lab/sharelatex-llm"
OUT_TAG="${BASE_VERSION}"
OUT_REF="${OUT_IMAGE}:${OUT_TAG}"

# --- sanity: the module must be vendored before we build --------------------
if [ ! -d "$HERE/vendor/llm" ] || [ -z "$(ls -A "$HERE/vendor/llm" 2>/dev/null)" ]; then
  echo "ERROR: vendor/llm/ is missing or empty at $HERE/vendor/llm" >&2
  echo "       Vendor the PR #171 module into overleaf-llm-image/vendor/llm/ first." >&2
  exit 1
fi

echo "Building ${OUT_REF}"
echo "  base image : ${BASE_IMAGE}"
echo "  context    : ${HERE}"
echo

DOCKER_BUILDKIT=1 docker build \
  --build-arg BASE_IMAGE="${BASE_IMAGE}" \
  -t "${OUT_REF}" \
  "${HERE}"

cat <<EOF

============================================================================
Build OK: ${OUT_REF}

ACTIVATE (single-variable swap, mirrors the texlive-full flow):
  In config.env (or config.env.local) set:
    OVERLEAF_IMAGE=${OUT_IMAGE}
    OVERLEAF_IMAGE_TAG=${OUT_TAG}
  Then re-run your configure/apply step and restart the stack.

  Enable the feature at runtime (image ships it OFF by default) by adding:
    LLM_ENABLED=true
    LLM_API_URL=http://your-llm-host/v1
    LLM_API_KEY=your-api-key
    LLM_MODEL_NAME=model-name-1,model-name-2
    # LLM_ALLOW_USER_SETTINGS=false   # keep off unless per-user keys are needed

ROLLBACK (revert to the stock image; no rebuild needed):
    OVERLEAF_IMAGE=overleafcep/sharelatex
    OVERLEAF_IMAGE_TAG=${OUT_TAG}
  Then re-run configure/apply and restart. The stock image is never mutated.
============================================================================
EOF
