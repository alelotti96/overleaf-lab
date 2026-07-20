#!/bin/bash

#===============================================================================
# BUILD AI ASSISTANT (LLM) CUSTOM IMAGE
#===============================================================================
# Thin wrapper around overleaf-llm-image/build.sh. Builds the custom Overleaf
# image (overleaf-lab/sharelatex-llm) that ships the in-editor AI assistant.
# Opt-in: only needed when ENABLE_LLM_MODULE=true in config.env.local.
#===============================================================================

set -euo pipefail

# Project root (parent of scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_SCRIPT="$SCRIPT_DIR/overleaf-llm-image/build.sh"

echo "Building the Overleaf AI assistant (LLM) custom image..."
echo ""

if [ ! -f "$BUILD_SCRIPT" ]; then
    echo "Error: $BUILD_SCRIPT not found."
    echo "The overleaf-llm-image build files are required to build the LLM image."
    echo "See overleaf-llm-image/README for details."
    exit 1
fi

chmod +x "$BUILD_SCRIPT" 2>/dev/null || true

# Hand off to the real builder (forwarding any extra args).
exec "$BUILD_SCRIPT" "$@"
