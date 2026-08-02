#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../overleaf-toolkit"

SIBLING_CONTAINERS_PULL=false bin/up -d
