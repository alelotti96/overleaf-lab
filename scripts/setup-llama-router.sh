#!/bin/bash

#===============================================================================
# LLAMA-ROUTER SETUP (systemd service)
#===============================================================================
# Installs (or updates) a systemd unit that runs scripts/llama-router.py, the
# stdlib-only OpenAI-compatible router that sits in front of several local
# llama-server (llama.cpp) instances and exposes them all behind one endpoint.
#
# NOTE: this does NOT start the llama-server processes themselves. You run those
# yourself (one per model, each on its own port). Until at least one backend is
# up, the router answers /v1/models with an empty list.
#
# Usage:
#   ./scripts/setup-llama-router.sh [backends] [port]
#     backends: comma-separated base URLs, each ending in /v1
#               (or set LLAMA_BACKENDS; default is two local llama-server ports)
#     port:     router listen port (or set ROUTER_PORT; default 18090)
#
#   Optional tuning (exported before running; pinned into the unit only if set):
#     ROUTER_HOST          bind address (router default 0.0.0.0 = every interface,
#                          so anyone on the network can use the backends through
#                          the router, which has no authentication; set the Docker
#                          bridge host IP, usually 172.17.0.1, to serve only local
#                          containers and the host, or firewall the port)
#     PROXY_TIMEOUT        backend response cap in seconds (router default 3600)
#     EARLY_RESPONSE_WAIT  seconds before the early "200 + chunked" (default 240)
#     HEARTBEAT_INTERVAL   seconds between heartbeat chunks (default 30)
#     CHAT_TEMPLATE_KWARGS JSON injected into completion bodies without their own,
#                          e.g. '{"enable_thinking":false}' (default: none)
#===============================================================================

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Backends and port: positional arg wins, then env var, then default
LLAMA_BACKENDS="${1:-${LLAMA_BACKENDS:-http://127.0.0.1:18080/v1,http://127.0.0.1:18081/v1}}"
ROUTER_PORT="${2:-${ROUTER_PORT:-18090}}"

# Effective bind address: the router's own default is 0.0.0.0 (every interface).
# 0.0.0.0 is not a connectable address, so the curl examples below use loopback.
BIND_HOST="${ROUTER_HOST:-0.0.0.0}"
CURL_HOST="${BIND_HOST}"
[ "${CURL_HOST}" = "0.0.0.0" ] && CURL_HOST="127.0.0.1"

# Repo root derived from this script's own location (scripts/..)
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Account the service runs as: the invoking user, even under sudo
RUN_USER="${SUDO_USER:-$USER}"

echo "==============================================================================="
echo "          LLAMA-ROUTER SETUP"
echo "==============================================================================="
echo ""

# python3 is required to run the router
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}Error: python3 not found. Install Python 3 and re-run this script.${NC}"
    exit 1
fi

# Optional tuning: only pin these in the unit if the operator set them in the
# environment; otherwise the router uses its own defaults (bind 0.0.0.0,
# 3600 / 240 / 30, and no chat_template_kwargs). Keeps long CPU compliance reviews from being cut, heartbeats
# the client while they run, and can force a reasoning model's thinking off.
# Each value is wrapped in double quotes with inner quotes/backslashes escaped:
# systemd strips UNQUOTED double quotes, which would turn a JSON value like
# CHAT_TEMPLATE_KWARGS={"enable_thinking":false} into the invalid {enable_thinking:false}.
EXTRA_ENV=""
for _v in ROUTER_HOST PROXY_TIMEOUT EARLY_RESPONSE_WAIT HEARTBEAT_INTERVAL CHAT_TEMPLATE_KWARGS; do
    if [ -n "${!_v:-}" ]; then
        _val="${!_v}"
        _val="${_val//\\/\\\\}"   # escape backslashes first
        _val="${_val//\"/\\\"}"   # then double quotes
        EXTRA_ENV="${EXTRA_ENV}Environment=\"${_v}=${_val}\""$'\n'
    fi
done

echo "Installing systemd service 'llama-router' with:"
echo "  backends: ${LLAMA_BACKENDS}"
echo "  port:     ${ROUTER_PORT}"
echo "  bind:     ${BIND_HOST}"
echo "  user:     ${RUN_USER}"
echo "  script:   ${REPO_DIR}/scripts/llama-router.py"
[ -n "$EXTRA_ENV" ] && printf '  tuning:   %s' "${EXTRA_ENV//Environment=/}"
echo ""

if [ "${BIND_HOST}" = "0.0.0.0" ]; then
    echo -e "${YELLOW}WARNING: the router will listen on every interface (0.0.0.0) and has no${NC}"
    echo -e "${YELLOW}authentication: anyone who can reach this machine can use the LLM backends${NC}"
    echo -e "${YELLOW}through it. To restrict it, re-run with ROUTER_HOST set to the Docker bridge${NC}"
    echo -e "${YELLOW}host IP (usually 172.17.0.1: containers and the host keep access, the rest${NC}"
    echo -e "${YELLOW}of the network loses it) or firewall port ${ROUTER_PORT}.${NC}"
    echo ""
fi

# Write (or overwrite) the systemd unit. Idempotent: re-running just refreshes it.
sudo tee /etc/systemd/system/llama-router.service > /dev/null <<EOF
[Unit]
Description=llama-router (OpenAI-compatible multi-model router for Overleaf LLM)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Environment=LLAMA_BACKENDS=${LLAMA_BACKENDS}
Environment=ROUTER_PORT=${ROUTER_PORT}
${EXTRA_ENV}ExecStart=/usr/bin/python3 ${REPO_DIR}/scripts/llama-router.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now llama-router

echo ""
echo -e "${GREEN}llama-router service installed and started${NC}"
echo "  Endpoint: http://${CURL_HOST}:${ROUTER_PORT}/v1"
echo "  Backends: ${LLAMA_BACKENDS}"
echo ""
echo "NOTE: this does NOT start the llama-server processes; run those yourself"
echo "      (one per model, each on its own port). Until they are up the router"
echo "      serves an empty model list. Check the merged model list with:"
echo "  curl http://${CURL_HOST}:${ROUTER_PORT}/v1/models"
echo ""
echo "Service management:"
echo "  sudo systemctl status llama-router"
echo "  sudo journalctl -u llama-router -f"
