#!/bin/bash

#===============================================================================
# CONFIGURATION SCRIPT
#===============================================================================
# This script reads config.env.local and applies configurations to all files
#===============================================================================

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Ensure we're in the project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

echo "Applying configuration from config.env.local..."
echo ""

# Load configuration
if [ ! -f "config.env.local" ]; then
    echo "Error: config.env.local not found!"
    echo "Please copy config.env to config.env.local and configure it"
    exit 1
fi

# Source config but handle special characters in PASSWORD_VALIDATION_PATTERN
# The $ in patterns like "aa11$8" gets interpreted, so we read it separately
source config.env.local

# Read PASSWORD_VALIDATION_PATTERN literally (without shell expansion)
# Escape $ as $$ for docker-compose
PASSWORD_VALIDATION_PATTERN=$(grep '^PASSWORD_VALIDATION_PATTERN=' config.env.local | sed 's/^PASSWORD_VALIDATION_PATTERN=//' | tr -d '"' | sed 's/\$/\$\$/g')
PASSWORD_VALIDATION_MIN_LENGTH=$(grep '^PASSWORD_VALIDATION_MIN_LENGTH=' config.env.local | sed 's/^PASSWORD_VALIDATION_MIN_LENGTH=//' | tr -d '"')

# Read EMAIL_FROM_ADDRESS literally
EMAIL_FROM_ADDRESS=$(grep '^EMAIL_FROM_ADDRESS=' config.env.local | sed 's/^EMAIL_FROM_ADDRESS=//' | tr -d '"')

# Get absolute paths
INSTALL_DIR="$PROJECT_ROOT"
COMPILES_DIR="${INSTALL_DIR}/data/compiles"
OUTPUT_DIR="${INSTALL_DIR}/data/output"

echo "Installation directory: $INSTALL_DIR"
echo ""

# Configure OIDC if enabled
if [ "${ENABLE_OIDC:-false}" = "true" ]; then
    EXTERNAL_AUTH="oidc"
else
    EXTERNAL_AUTH="none"
fi

# -----------------------------------------------------------------------------
# 1. Configure Overleaf-Zotero-Manager
# -----------------------------------------------------------------------------
echo "[1/4] Configuring Dashboard (overleaf-zotero-manager)..."

if [ -d "overleaf-zotero-manager" ]; then
    # Generate FLASK_SECRET_KEY if empty
    if [ -z "$FLASK_SECRET_KEY" ]; then
        echo "  Generating FLASK_SECRET_KEY..."
        FLASK_SECRET_KEY=$(python3 -c 'import secrets; print(secrets.token_hex(32))' 2>/dev/null || openssl rand -hex 32)
        # Update config.env.local with generated key
        if [ -f "config.env.local" ]; then
            sed -i "s|^FLASK_SECRET_KEY=.*|FLASK_SECRET_KEY=\"${FLASK_SECRET_KEY}\"|" config.env.local
        fi
    fi

    cat > overleaf-zotero-manager/.env <<EOF
# Flask
FLASK_SECRET_KEY=${FLASK_SECRET_KEY}
FLASK_DEBUG=${FLASK_DEBUG}
FLASK_HOST=0.0.0.0
FLASK_PORT=${FLASK_PORT}

# Branding
LAB_NAME=${LAB_NAME}

# Admin
ADMIN_USERNAME=${ADMIN_EMAIL}
ADMIN_PASSWORD=${DASHBOARD_ADMIN_PASSWORD}

# MongoDB
MONGODB_URI=${MONGODB_URI}

# Paths (relative to overleaf-lab root)
OVERLEAF_TOOLKIT_PATH=${INSTALL_DIR}/overleaf-toolkit
ZOTERO_PROXIES_PATH=${INSTALL_DIR}/zotero-proxies
ZOTERO_PROXY_IMAGE=${ZOTERO_PROXY_IMAGE}

# URLs
OVERLEAF_URL=${OVERLEAF_URL}

# Signup subdomain (for auto-redirect from signup hostname)
SIGNUP_SUBDOMAIN=${SIGNUP_SUBDOMAIN:-}

# Enable public Zotero signup page
ENABLE_PUBLIC_ZOTERO_SIGNUP=${ENABLE_PUBLIC_ZOTERO_SIGNUP}

# Proxy configuration
BEHIND_PROXY=${BEHIND_PROXY}

# Session
SESSION_COOKIE_SECURE=${SESSION_COOKIE_SECURE}
SESSION_COOKIE_HTTPONLY=${SESSION_COOKIE_HTTPONLY}
SESSION_COOKIE_SAMESITE=${SESSION_COOKIE_SAMESITE}

# Logging
LOG_LEVEL=${LOG_LEVEL}
LOG_FILE=${LOG_FILE}
EOF
    echo -e "${GREEN}✓ Dashboard configured${NC}"
else
    echo -e "${YELLOW}Warning: overleaf-zotero-manager directory not found${NC}"
fi

# -----------------------------------------------------------------------------
# 2. Configure Zotero Proxies
# -----------------------------------------------------------------------------
echo "[2/4] Configuring Zotero Proxies..."

if [ -d "zotero-proxies" ]; then
    # Create empty .env for now (users will be added via dashboard)
    cat > zotero-proxies/.env <<EOF
# Zotero user credentials will be added here by the dashboard
# or manually in the format:
# USERNAME_API_KEY=your_api_key
# USERNAME_USER_ID=your_user_id
EOF

    # Create docker-compose.yml for Zotero per-user proxy containers
    # User services will be added by the dashboard when users configure Zotero
    if [ ! -f "zotero-proxies/docker-compose.yml" ]; then
        echo "  Creating docker-compose.yml..."
        cat > zotero-proxies/docker-compose.yml <<'COMPOSE_EOF'
services:
  # Per-user Zotero proxy containers are added here automatically by the dashboard
  # Each user gets a container named zotero-{username} accessible via Docker network

networks:
  overleaf_default:
    external: true
COMPOSE_EOF
    fi

    echo -e "${GREEN}✓ Zotero proxies configured${NC}"
else
    echo -e "${YELLOW}Warning: zotero-proxies directory not found${NC}"
fi

# -----------------------------------------------------------------------------
# 3. Configure Overleaf Toolkit
# -----------------------------------------------------------------------------
echo "[3/4] Configuring Overleaf Toolkit..."

if [ -d "overleaf-toolkit" ]; then
    # Build header extras conditionally (include Zotero link only if signup is enabled)
    if [ "${ENABLE_PUBLIC_ZOTERO_SIGNUP}" = "true" ]; then
        HEADER_EXTRAS='[{"text":"Admin Dashboard","url":"'"${DASHBOARD_URL}"'"},{"text":"LaTeX Tutorial","url":"https://www.overleaf.com/learn/latex/Learn_LaTeX_in_30_minutes","class":"subdued"},{"text":"Zotero","dropdown":[{"text":"Integration Setup","url":"'"${DASHBOARD_SIGNUP_URL}"'"}]}]'
    else
        HEADER_EXTRAS='[{"text":"Admin Dashboard","url":"'"${DASHBOARD_URL}"'"},{"text":"LaTeX Tutorial","url":"https://www.overleaf.com/learn/latex/Learn_LaTeX_in_30_minutes","class":"subdued"}]'
    fi

    # Create overleaf.rc if it doesn't exist or update it
    cat > overleaf-toolkit/config/overleaf.rc <<EOF
#### Overleaf RC ####
PROJECT_NAME=overleaf

# Sharelatex container
OVERLEAF_DATA_PATH=data/overleaf
# SERVER_PRO=true enables sibling containers in toolkit (required for overleaf-cep sandboxed compiles)
SERVER_PRO=${SANDBOXED_COMPILES}

# Docker image
OVERLEAF_IMAGE=${OVERLEAF_IMAGE}
OVERLEAF_IMAGE_TAG=${OVERLEAF_IMAGE_TAG}

# Sibling containers
SIBLING_CONTAINERS_ENABLED=${SANDBOXED_COMPILES}

# Sandboxed compiles
SANDBOXED_COMPILES_ENABLED=${SANDBOXED_COMPILES}
SANDBOXED_COMPILES_HOST_DIR=${COMPILES_DIR}
ENABLE_CONVERSIONS=true

# Track changes
TRACK_CHANGES_ENABLED=${TRACK_CHANGES_ENABLED}
TEX_LIVE_DOCKER_IMAGE=local/texlive-fonts:latest

# Template gallery
OVERLEAF_TEMPLATES_USER_ID=system

# Network
OVERLEAF_LISTEN_IP=0.0.0.0
OVERLEAF_PORT=${OVERLEAF_PORT}

# Mongo configuration
MONGO_ENABLED=true
MONGO_DATA_PATH=data/mongo
MONGO_IMAGE=mongo
MONGO_VERSION=${MONGO_VERSION:-8.0}

# Redis configuration
REDIS_ENABLED=true
REDIS_DATA_PATH=data/redis
REDIS_IMAGE=redis:6.2
REDIS_AOF_PERSISTENCE=true

# Git-bridge configuration (Server Pro only)
GIT_BRIDGE_ENABLED=false

# TLS proxy configuration (optional)
NGINX_ENABLED=false

# Docker socket (for sandboxed compiles)
DOCKER_SOCKET_PATH=/var/run/docker.sock
EOF

    # Create variables.env
    cat > overleaf-toolkit/config/variables.env <<'EOF'
# Linked file types
ENABLED_LINKED_FILE_TYPES=${ENABLED_LINKED_FILE_TYPES}

# Allow internal Zotero proxy URLs (bypass SSRF protection for zotero-* containers)
OVERLEAF_LINKED_URL_ALLOWED_RESOURCES=^http://zotero-[a-zA-Z0-9-]+:5000

# Enables Thumbnail generation using ImageMagick
ENABLE_CONVERSIONS=true

# Disables email confirmation requirement
EMAIL_CONFIRMATION_DISABLED=${EMAIL_CONFIRMATION_DISABLED}

# Branding
OVERLEAF_APP_NAME=${LAB_NAME} Overleaf
OVERLEAF_NAV_TITLE=${LAB_NAME} Overleaf
OVERLEAF_SITE_URL=${OVERLEAF_URL}
OVERLEAF_ADMIN_EMAIL=${ADMIN_EMAIL}
OVERLEAF_BEHIND_PROXY=${BEHIND_PROXY}
OVERLEAF_SECURE_COOKIE=${USE_SECURE_COOKIES}

# Custom header menu (Zotero link only if signup is enabled)
OVERLEAF_HEADER_EXTRAS=${HEADER_EXTRAS}

# Security
OVERLEAF_PASSWORD_VALIDATION_PATTERN=${PASSWORD_VALIDATION_PATTERN}
OVERLEAF_PASSWORD_VALIDATION_MIN_LENGTH=${PASSWORD_VALIDATION_MIN_LENGTH}

# Upload limits
MAX_UPLOAD_SIZE=${MAX_UPLOAD_SIZE}

# Compile settings
COMPILE_TIMEOUT=${COMPILE_TIMEOUT}

# Sandboxed compiles - TeXLive images (required when SIBLING_CONTAINERS_ENABLED=true)
ALL_TEX_LIVE_DOCKER_IMAGES=local/texlive-fonts:latest
TEX_LIVE_DOCKER_IMAGE=local/texlive-fonts:latest

# Email settings
OVERLEAF_EMAIL_FROM_ADDRESS=${EMAIL_FROM_ADDRESS}
OVERLEAF_EMAIL_SMTP_HOST=${SMTP_HOST}
OVERLEAF_EMAIL_SMTP_PORT=${SMTP_PORT}
OVERLEAF_EMAIL_SMTP_SECURE=${SMTP_SECURE}
OVERLEAF_EMAIL_SMTP_USER=${SMTP_USER}
OVERLEAF_EMAIL_SMTP_PASS=${SMTP_PASS}
OVERLEAF_EMAIL_SMTP_TLS_REJECT_UNAUTH=${SMTP_TLS_REJECT_UNAUTH}
OVERLEAF_EMAIL_SMTP_IGNORE_TLS=${SMTP_IGNORE_TLS}

# External auth
EXTERNAL_AUTH=${EXTERNAL_AUTH}
EOF

    # Add OIDC configuration if enabled
    if [ "${ENABLE_OIDC:-false}" = "true" ]; then
        cat >> overleaf-toolkit/config/variables.env <<EOF

# OIDC Authentication
OVERLEAF_OIDC_CLIENT_ID=${OIDC_CLIENT_ID}
OVERLEAF_OIDC_CLIENT_SECRET=${OIDC_CLIENT_SECRET}
OVERLEAF_OIDC_ISSUER=${OIDC_ISSUER}
OVERLEAF_OIDC_AUTHORIZATION_URL=${OIDC_AUTHORIZATION_URL}
OVERLEAF_OIDC_TOKEN_URL=${OIDC_TOKEN_URL}
OVERLEAF_OIDC_USER_INFO_URL=${OIDC_USER_INFO_URL}
OVERLEAF_OIDC_END_SESSION_URL=${OIDC_END_SESSION_URL}
OVERLEAF_OIDC_SCOPE=${OIDC_SCOPE}
OVERLEAF_OIDC_PROVIDER_NAME=${OIDC_PROVIDER_NAME}
OVERLEAF_OIDC_ALLOWED_EMAIL_DOMAINS=${OIDC_ALLOWED_DOMAINS}
OIDC_ADDITIONAL_TENANT_IDS=${OIDC_ADDITIONAL_TENANT_IDS}
OIDC_GROUP_FILTERING_ENABLED=${OIDC_GROUP_FILTERING_ENABLED}
OIDC_ALLOWED_GROUPS=${OIDC_ALLOWED_GROUPS}
EOF
    fi

    # Replace variables in variables.env
    # Use sed with escaped pattern for literal ${VAR} replacement
    _replace_var() {
        local var="$1"
        local val="$2"
        local file="overleaf-toolkit/config/variables.env"
        # Escape special characters in replacement value for sed
        local escaped_val=$(printf '%s\n' "$val" | sed 's/[&/\]/\\&/g')
        # Replace ${VAR} with the value - escape $ { } for literal matching
        sed -i "s/\${${var}}/${escaped_val}/g" "$file"
    }

    _replace_var "ENABLED_LINKED_FILE_TYPES" "${ENABLED_LINKED_FILE_TYPES}"
    _replace_var "EMAIL_CONFIRMATION_DISABLED" "${EMAIL_CONFIRMATION_DISABLED}"
    _replace_var "LAB_NAME" "${LAB_NAME}"
    _replace_var "OVERLEAF_URL" "${OVERLEAF_URL}"
    _replace_var "ADMIN_EMAIL" "${ADMIN_EMAIL}"
    _replace_var "BEHIND_PROXY" "${BEHIND_PROXY}"
    _replace_var "USE_SECURE_COOKIES" "${USE_SECURE_COOKIES}"
    _replace_var "DASHBOARD_URL" "${DASHBOARD_URL}"
    _replace_var "DASHBOARD_SIGNUP_URL" "${DASHBOARD_SIGNUP_URL}"
    # HEADER_EXTRAS contains JSON - use awk for safe replacement
    awk -v val="$HEADER_EXTRAS" '{gsub(/\${HEADER_EXTRAS}/, val)}1' overleaf-toolkit/config/variables.env > overleaf-toolkit/config/variables.env.tmp && mv overleaf-toolkit/config/variables.env.tmp overleaf-toolkit/config/variables.env
    # PASSWORD_VALIDATION_PATTERN may contain $ like "a1$" - awk handles this correctly
    _replace_var "PASSWORD_VALIDATION_PATTERN" "${PASSWORD_VALIDATION_PATTERN}"
    _replace_var "PASSWORD_VALIDATION_MIN_LENGTH" "${PASSWORD_VALIDATION_MIN_LENGTH}"
    _replace_var "MAX_UPLOAD_SIZE" "${MAX_UPLOAD_SIZE}"
    _replace_var "COMPILE_TIMEOUT" "${COMPILE_TIMEOUT}"
    _replace_var "EMAIL_FROM_ADDRESS" "${EMAIL_FROM_ADDRESS}"
    _replace_var "SMTP_HOST" "${SMTP_HOST}"
    _replace_var "SMTP_PORT" "${SMTP_PORT}"
    _replace_var "SMTP_SECURE" "${SMTP_SECURE}"
    _replace_var "SMTP_USER" "${SMTP_USER}"
    _replace_var "SMTP_PASS" "${SMTP_PASS}"
    _replace_var "SMTP_TLS_REJECT_UNAUTH" "${SMTP_TLS_REJECT_UNAUTH}"
    _replace_var "SMTP_IGNORE_TLS" "${SMTP_IGNORE_TLS}"
    _replace_var "EXTERNAL_AUTH" "${EXTERNAL_AUTH}"

    # CRITICAL FIX: Remove OVERLEAF_SECURE_COOKIE if not using HTTPS
    # Node.js checks: secureCookie: process.env.OVERLEAF_SECURE_COOKIE != null
    # So variable must NOT exist for HTTP, not just be "false"
    if [ "${USE_SECURE_COOKIES}" = "false" ]; then
        sed -i '/^OVERLEAF_SECURE_COOKIE=/d' overleaf-toolkit/config/variables.env
    fi

    # Create docker-compose.override.yml
    cat > overleaf-toolkit/config/docker-compose.override.yml <<'YAML_EOF'
services:
  mongo:
    ports:
      - "127.0.0.1:27017:27017"

  sharelatex:
    image: ${OVERLEAF_IMAGE}:${OVERLEAF_IMAGE_TAG}
    sysctls:
      - net.ipv6.conf.all.disable_ipv6=1

    environment:
      SKIP_BINARY_FILES_MIGRATION_CHECK: "true"
      OVERLEAF_FILESTORE_MIGRATION_LEVEL: "2"

      # Features
      ENABLE_CONVERSIONS: "true"
      TRACK_CHANGES_ENABLED: "true"
      COMMENTS_ENABLED: "true"
      SYMBOL_PALETTE_ENABLED: "true"
      TEMPLATES_USER_ID: "system"
      REFERENCES_AUTOCOMPLETE_ENABLED: "true"
      OVERLEAF_TEMPLATE_GALLERY: "true"
      OVERLEAF_NON_ADMIN_CAN_PUBLISH_TEMPLATES: "true"

      # Experimental features (passed to enable-features.sh)
      ENABLE_NEW_EDITOR_UI: "${ENABLE_NEW_EDITOR_UI}"

    volumes:
      # Mount scripts to enable features on container startup
      - ../../scripts/enable-features.sh:/overleaf-lab/enable-features.sh:ro
      - ../../scripts/nginx-customizations.sh:/overleaf-lab/nginx-customizations.sh:ro
      # Mount entrypoint wrapper
      - ../../scripts/docker-entrypoint.sh:/docker-entrypoint-wrapper.sh:ro

    entrypoint: ["/bin/bash", "/docker-entrypoint-wrapper.sh"]
YAML_EOF

    # Replace variables in docker-compose.override.yml
    sed -i "s|\${OVERLEAF_IMAGE}|${OVERLEAF_IMAGE}|g" overleaf-toolkit/config/docker-compose.override.yml
    sed -i "s|\${OVERLEAF_IMAGE_TAG}|${OVERLEAF_IMAGE_TAG}|g" overleaf-toolkit/config/docker-compose.override.yml
    sed -i "s|\${ENABLE_NEW_EDITOR_UI}|${ENABLE_NEW_EDITOR_UI:-false}|g" overleaf-toolkit/config/docker-compose.override.yml

    echo -e "${GREEN}✓ Overleaf Toolkit configured${NC}"
else
    echo -e "${YELLOW}Note: Overleaf Toolkit not yet cloned (will be done during installation)${NC}"
fi

# -----------------------------------------------------------------------------
# 4. Create data directories
# -----------------------------------------------------------------------------
echo "[4/4] Creating data directories..."

mkdir -p data/overleaf
mkdir -p data/mongo
mkdir -p data/redis
mkdir -p data/compiles
mkdir -p data/output

echo -e "${GREEN}✓ Data directories created${NC}"

echo ""
echo "==============================================================================="
echo "Configuration applied successfully!"
echo "==============================================================================="
echo ""
echo "Configured:"
echo "  - Dashboard (overleaf-zotero-manager)"
echo "  - Zotero Proxies"
echo "  - Overleaf Toolkit"
echo "  - Data directories"
echo ""
