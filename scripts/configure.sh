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

# Generate OVERLEAF_INVITE_TOKEN_SECRET if missing (required by Overleaf CE >= 6.2.0,
# the container refuses to start without it)
if [ -z "$OVERLEAF_INVITE_TOKEN_SECRET" ]; then
    echo "Generating OVERLEAF_INVITE_TOKEN_SECRET..."
    OVERLEAF_INVITE_TOKEN_SECRET=$(python3 -c 'import secrets; print(secrets.token_hex(32))' 2>/dev/null || openssl rand -hex 32)
    if grep -q '^OVERLEAF_INVITE_TOKEN_SECRET=' config.env.local; then
        sed -i "s|^OVERLEAF_INVITE_TOKEN_SECRET=.*|OVERLEAF_INVITE_TOKEN_SECRET=\"${OVERLEAF_INVITE_TOKEN_SECRET}\"|" config.env.local
    else
        printf '\n# Invite token secret (required by Overleaf CE >= 6.2.0, auto-generated)\nOVERLEAF_INVITE_TOKEN_SECRET="%s"\n' "$OVERLEAF_INVITE_TOKEN_SECRET" >> config.env.local
    fi
fi

# Upload limit is expressed in MB since Overleaf CE 6.2.0 (drives nginx
# client_max_body_size and web maxUploadSize). Convert legacy byte values.
if [ -n "$MAX_UPLOAD_SIZE_MB" ]; then
    MAX_UPLOAD_MB="$MAX_UPLOAD_SIZE_MB"
elif [ -n "$MAX_UPLOAD_SIZE" ] && [ "$MAX_UPLOAD_SIZE" -gt 10240 ] 2>/dev/null; then
    MAX_UPLOAD_MB=$((MAX_UPLOAD_SIZE / 1024 / 1024))
elif [ -n "$MAX_UPLOAD_SIZE" ]; then
    MAX_UPLOAD_MB="$MAX_UPLOAD_SIZE"
else
    MAX_UPLOAD_MB=500
fi

# Pandoc conversions (Word/Markdown import-export): enabled by default
ENABLE_PANDOC_CONVERSIONS="${ENABLE_PANDOC_CONVERSIONS:-true}"
PANDOC_IMAGE="${PANDOC_IMAGE:-overleafcep/pandoc-ol:3.10.0.0}"

# Get absolute paths
INSTALL_DIR="$PROJECT_ROOT"

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

    # Get password hash for dashboard admin
    # Priority: 1) Environment variable (from install.sh), 2) Hash from config, 3) Existing .env

    # Check if hash was passed from install.sh via environment
    if [ -n "$DASHBOARD_PASSWORD_HASH" ]; then
        ADMIN_PASSWORD_HASH="$DASHBOARD_PASSWORD_HASH"
        echo "  Using password hash from installation"
    elif [ -n "$DASHBOARD_ADMIN_PASSWORD" ]; then
        # Password provided in config - generate hash (for manual config changes)
        echo "  Generating password hash..."
        ADMIN_PASSWORD_HASH=$(python3 -c "
import hashlib, secrets, sys
password = sys.stdin.read().strip()  # strip newline from heredoc
salt = secrets.token_hex(16)
iterations = 600000
dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), iterations)
print(f'pbkdf2:sha256:{iterations}\${salt}\${dk.hex()}')
" <<< "$DASHBOARD_ADMIN_PASSWORD" 2>/dev/null)

        if [ -z "$ADMIN_PASSWORD_HASH" ]; then
            echo -e "${YELLOW}Error: Failed to hash password. Python3 is required.${NC}"
            exit 1
        fi
        echo "  Password hash generated successfully"

        # Remove plaintext password from config.env.local
        sed -i 's/^DASHBOARD_ADMIN_PASSWORD=.*/DASHBOARD_ADMIN_PASSWORD=""  # Hashed - set new password here to change it/' config.env.local
        echo "  Plaintext password removed from config.env.local"
    else
        # No password - check if hash already exists in .env
        if [ -f "overleaf-zotero-manager/.env" ]; then
            # Read existing hash and undo Docker Compose escaping ($$ -> $)
            ADMIN_PASSWORD_HASH=$(grep '^ADMIN_PASSWORD_HASH=' overleaf-zotero-manager/.env | cut -d'=' -f2- | sed 's/\$\$/\$/g')
        fi

        if [ -z "$ADMIN_PASSWORD_HASH" ]; then
            echo -e "${YELLOW}Error: No password configured${NC}"
            echo "  Set DASHBOARD_ADMIN_PASSWORD in config.env.local and re-run configure.sh"
            exit 1
        fi
        echo "  Using existing password hash"
    fi

    # Escape $ characters in hash for Docker Compose ($ -> $$)
    ADMIN_PASSWORD_HASH_ESCAPED=$(echo "$ADMIN_PASSWORD_HASH" | sed 's/\$/\$\$/g')

    cat > overleaf-zotero-manager/.env <<EOF
# Flask
FLASK_SECRET_KEY=${FLASK_SECRET_KEY}
FLASK_DEBUG=${FLASK_DEBUG}
FLASK_HOST=0.0.0.0
FLASK_PORT=${FLASK_PORT}

# Branding
LAB_NAME=${LAB_NAME}

# Admin credentials (password is securely hashed)
ADMIN_USERNAME=${ADMIN_EMAIL}
ADMIN_PASSWORD_HASH=${ADMIN_PASSWORD_HASH_ESCAPED}

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

# Git-bridge configuration
GIT_BRIDGE_ENABLED=true

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

# Upload limit in MB (applied to nginx client_max_body_size and web maxUploadSize)
MAX_UPLOAD_SIZE=${MAX_UPLOAD_MB}

# Compile settings
COMPILE_TIMEOUT=${COMPILE_TIMEOUT}

# Invite token secret (required since Overleaf CE 6.2.0)
OVERLEAF_INVITE_TOKEN_SECRET=${OVERLEAF_INVITE_TOKEN_SECRET}

# Public registration page (/register, native since CEP ext-v5.0).
# Must be set explicitly: when unset, CEP auto-enables the page if no
# external auth (OIDC/LDAP/SAML) is configured.
OVERLEAF_ENABLE_REGISTRATION_PAGE=${ENABLE_OVERLEAF_PUBLIC_REGISTRATION}

# Project history restore features (native env var since CEP ext-v5.0)
OVERLEAF_HISTORY_RESTORE=true

# Pandoc conversions: import Word/Markdown documents, export docx/Markdown/HTML
ENABLE_PANDOC_CONVERSIONS=${ENABLE_PANDOC_CONVERSIONS}
PANDOC_IMAGE=${PANDOC_IMAGE}

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

# Disable link sharing entirely: hides "Share by link" and blocks token URLs
# (/read/<token> and read-write links), including for anonymous visitors.
# NOTE: the previously used OVERLEAF_LINK_SHARING_ENABLED never existed upstream.
OVERLEAF_DISABLE_LINK_SHARING=true
EOF

    # -------------------------------------------------------------------------
    # Branding: footer links + dashboard header color
    # -------------------------------------------------------------------------
    # Footer is native (server-ce settings.js reads these JSON env vars).
    # Header color is injected as CSS by nginx-customizations.sh, which reads
    # HEADER_BG_COLOR / HEADER_TEXT_COLOR from the container environment
    # (variables.env is the sharelatex env_file).
    _fork_text="${FOOTER_FORK_TEXT:-Fork on GitHub!}"
    _fork_url="${FOOTER_FORK_URL:-https://github.com/overleaf/overleaf}"
    cat >> overleaf-toolkit/config/variables.env <<EOF

# Footer customization
OVERLEAF_RIGHT_FOOTER=[{"text":"${_fork_text}","url":"${_fork_url}"}]
NAV_HIDE_POWERED_BY=${HIDE_POWERED_BY:-false}
EOF
    if [ -n "${FOOTER_CREDIT_TEXT}" ]; then
        echo "OVERLEAF_LEFT_FOOTER=[{\"text\":\"${FOOTER_CREDIT_TEXT}\",\"url\":\"${FOOTER_CREDIT_URL}\"}]" >> overleaf-toolkit/config/variables.env
    fi
    if [ -n "${HEADER_BG_COLOR}" ]; then
        cat >> overleaf-toolkit/config/variables.env <<EOF

# Dashboard header (navbar) color, applied as CSS by nginx-customizations.sh
HEADER_BG_COLOR=${HEADER_BG_COLOR}
HEADER_TEXT_COLOR=${HEADER_TEXT_COLOR:-#ffffff}
EOF
    fi

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
OVERLEAF_OIDC_UPDATE_USER_DETAILS_ON_LOGIN=true
OIDC_ADDITIONAL_TENANT_IDS=${OIDC_ADDITIONAL_TENANT_IDS}
OIDC_GROUP_FILTERING_ENABLED=${OIDC_GROUP_FILTERING_ENABLED}
OIDC_ALLOWED_GROUPS=${OIDC_ALLOWED_GROUPS}
EOF
    fi

    # Add GitHub synchronization configuration if enabled
    if [ "${ENABLE_GITHUB_SYNC:-false}" = "true" ]; then
        cat >> overleaf-toolkit/config/variables.env <<EOF

# GitHub Synchronization (two-way sync with GitHub repositories)
GITHUB_SYNC_ENABLED=true
GITHUB_SYNC_CLIENT_ID=${GITHUB_SYNC_CLIENT_ID}
GITHUB_SYNC_CLIENT_SECRET=${GITHUB_SYNC_CLIENT_SECRET}
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
    _replace_var "MAX_UPLOAD_MB" "${MAX_UPLOAD_MB}"
    _replace_var "COMPILE_TIMEOUT" "${COMPILE_TIMEOUT}"
    _replace_var "OVERLEAF_INVITE_TOKEN_SECRET" "${OVERLEAF_INVITE_TOKEN_SECRET}"
    _replace_var "ENABLE_OVERLEAF_PUBLIC_REGISTRATION" "${ENABLE_OVERLEAF_PUBLIC_REGISTRATION:-false}"
    _replace_var "ENABLE_PANDOC_CONVERSIONS" "${ENABLE_PANDOC_CONVERSIONS}"
    _replace_var "PANDOC_IMAGE" "${PANDOC_IMAGE}"
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

    # Ensure whitelist file exists (for docker mount)
    if [ ! -f "scripts/whitelisted_emails.txt" ]; then
        if [ -f "scripts/whitelisted_emails.txt.sample" ]; then
            cp scripts/whitelisted_emails.txt.sample scripts/whitelisted_emails.txt
            echo "Created scripts/whitelisted_emails.txt from sample"
        else
            touch scripts/whitelisted_emails.txt
            echo "Created empty scripts/whitelisted_emails.txt"
        fi
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

      # Super Admin role (passed to enable-features.sh)
      SUPER_ADMIN_EMAIL: "${SUPER_ADMIN_EMAIL}"

    volumes:
      # Mount scripts to enable features on container startup
      - ../../scripts/enable-features.sh:/overleaf-lab/enable-features.sh:ro
      - ../../scripts/nginx-customizations.sh:/overleaf-lab/nginx-customizations.sh:ro
      # Mount email whitelist for group filtering bypass (optional)
      - ../../scripts/whitelisted_emails.txt:/overleaf-lab/whitelisted_emails.txt:ro
      # Mount super_admin patch script
      - ../../scripts/patch-super-admin.js:/overleaf-lab/patch-super-admin.js:ro
      # Mount entrypoint wrapper
      - ../../scripts/docker-entrypoint.sh:/docker-entrypoint-wrapper.sh:ro

    entrypoint: ["/bin/bash", "/docker-entrypoint-wrapper.sh"]
YAML_EOF

    # Replace variables in docker-compose.override.yml
    sed -i "s|\${OVERLEAF_IMAGE}|${OVERLEAF_IMAGE}|g" overleaf-toolkit/config/docker-compose.override.yml
    sed -i "s|\${OVERLEAF_IMAGE_TAG}|${OVERLEAF_IMAGE_TAG}|g" overleaf-toolkit/config/docker-compose.override.yml
    sed -i "s|\${SUPER_ADMIN_EMAIL}|${SUPER_ADMIN_EMAIL:-}|g" overleaf-toolkit/config/docker-compose.override.yml

    echo -e "${GREEN}✓ Overleaf Toolkit configured${NC}"
else
    echo -e "${YELLOW}Note: Overleaf Toolkit not yet cloned (will be done during installation)${NC}"
fi

# -----------------------------------------------------------------------------
# 4. Create data directories
# -----------------------------------------------------------------------------
echo "[4/4] Creating data directories..."

mkdir -p overleaf-toolkit/data/overleaf
mkdir -p overleaf-toolkit/data/mongo
mkdir -p overleaf-toolkit/data/redis

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
