#!/bin/bash

#===============================================================================
# OVERLEAF-LAB INSTALLATION SCRIPT
#===============================================================================
# This script automates the complete installation of:
# - Overleaf Community Edition
# - Overleaf Toolkit
# - Zotero Integration System
# - Management Dashboard
#===============================================================================

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Verify we're in the correct directory
if [ ! -f "config.env" ] || [ ! -d "scripts" ]; then
    echo -e "${RED}Error: This script must be run from the overleaf-lab directory${NC}"
    echo "Please cd to the overleaf-lab directory and run: ./install.sh"
    exit 1
fi

# Store absolute path to prevent issues with relative paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==============================================================================="
echo "          OVERLEAF-LAB INSTALLATION"
echo "==============================================================================="
echo ""

# -----------------------------------------------------------------------------
# 1. Check prerequisites
# -----------------------------------------------------------------------------
echo "[1/7] Checking prerequisites..."

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo -e "${YELLOW}Docker not found. Installing automatically...${NC}"
    echo ""
    chmod +x ./scripts/install-docker.sh
    ./scripts/install-docker.sh
    echo -e "${GREEN}✓ Docker installed successfully!${NC}"
    echo "Re-launching installer with Docker permissions..."
    echo ""
    exec sg docker -c "$0 $*"
else
    echo -e "${GREEN}✓ Docker is installed${NC}"
fi

# Check Docker Compose
if ! docker compose version &> /dev/null; then
    echo -e "${RED}Error: Docker Compose is not available.${NC}"
    exit 1
else
    echo -e "${GREEN}✓ Docker Compose is available${NC}"
fi

# Check Docker permissions
if ! docker ps &> /dev/null; then
    echo -e "${YELLOW}Docker permission denied. Checking if you're in the docker group...${NC}"

    if groups | grep -q docker; then
        # User is in docker group but needs to activate it
        echo "You're in the docker group but it's not active in this session."
        echo "Re-launching installer with correct permissions..."
        echo ""
        exec sg docker -c "$0 $*"
    else
        # User is not in docker group
        echo -e "${RED}You're not in the docker group.${NC}"
        echo "Adding you to the docker group now..."
        sudo usermod -aG docker $USER
        echo ""
        echo -e "${GREEN}Added to docker group!${NC}"
        echo "Re-launching installer with correct permissions..."
        echo ""
        exec sg docker -c "$0 $*"
    fi
else
    echo -e "${GREEN}✓ Docker permissions OK${NC}"
fi

# Check internet connection
if ! ping -c 1 google.com &> /dev/null; then
    echo -e "${RED}Error: No internet connection detected.${NC}"
    exit 1
else
    echo -e "${GREEN}✓ Internet connection available${NC}"
fi

# Check CPU AVX support (required for MongoDB 5.0+)
if ! grep -q avx /proc/cpuinfo 2>/dev/null; then
    echo -e "${YELLOW}⚠ Your CPU does not support AVX (older CPU detected)${NC}"
    echo "  MongoDB 5.0+ requires AVX. Using MongoDB 4.4 instead."

    # Auto-set MONGO_VERSION=4.4 in config.env.local if exists, or remember for later
    if [ -f config.env.local ]; then
        if grep -q "^MONGO_VERSION=" config.env.local; then
            sed -i 's/^MONGO_VERSION=.*/MONGO_VERSION="4.4"/' config.env.local
        else
            echo 'MONGO_VERSION="4.4"' >> config.env.local
        fi
    fi
    export MONGO_VERSION="4.4"
    echo -e "${GREEN}✓ MongoDB 4.4 will be used (compatible with your CPU)${NC}"
else
    echo -e "${GREEN}✓ CPU supports AVX (MongoDB 8.0 compatible)${NC}"
fi

# -----------------------------------------------------------------------------
# 2. Configuration setup
# -----------------------------------------------------------------------------
echo ""
echo "[2/7] Configuration setup..."

if [ ! -f config.env.local ]; then
    echo "Let's configure your installation..."
    echo ""

    # Lab name
    read -p "Lab name (e.g., 'Physics Lab'): " LAB_NAME
    LAB_NAME=${LAB_NAME:-"My Lab"}

    # Dashboard credentials (always installed for admin management)
    echo ""
    echo "==============================================================================="
    echo "DASHBOARD ADMIN CREDENTIALS"
    echo "==============================================================================="
    echo "The dashboard is a web UI (port 5000) for managing:"
    echo "  - Overleaf users (create, activate, manage)"
    echo "  - Zotero integration (add/remove user bibliographies)"
    echo ""
    echo "This is SEPARATE from Overleaf login (which you'll create via /launchpad)."
    echo ""

    # Dashboard admin email
    read -p "Dashboard admin email: " ADMIN_EMAIL
    ADMIN_EMAIL=${ADMIN_EMAIL:-"admin@example.com"}

    # Dashboard admin password
    while true; do
        read -sp "Dashboard admin password: " DASHBOARD_PASSWORD
        echo
        read -sp "Confirm password: " DASHBOARD_PASSWORD_CONFIRM
        echo

        if [ "$DASHBOARD_PASSWORD" = "$DASHBOARD_PASSWORD_CONFIRM" ]; then
            DASHBOARD_PASSWORD=${DASHBOARD_PASSWORD:-"changeme"}
            break
        else
            echo -e "${RED}Passwords do not match. Please try again.${NC}"
            echo ""
        fi
    done
    echo ""

    # Ask about public Zotero signup page
    echo ""
    echo "Enable Zotero signup page?"
    echo "If enabled, users can self-register their Zotero API keys via a public web form."
    echo "If disabled, you must configure Zotero users manually via the admin dashboard."
    echo "(Recommended: disable for public deployments to prevent unauthorized access)"
    echo ""
    read -p "Enable Zotero signup? (y/n): " -n 1 -r
    echo

    if [[ $REPLY =~ ^[Yy]$ ]]; then
        ENABLE_PUBLIC_ZOTERO_SIGNUP="true"
    else
        ENABLE_PUBLIC_ZOTERO_SIGNUP="false"
    fi

    echo ""
    read -p "Configure SMTP for user activation emails? (y/n): " -n 1 -r
    echo

    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo ""
        echo "SMTP Configuration"
        echo "For Gmail: use smtp.gmail.com with App Password"
        echo ""

        # SMTP
        read -p "SMTP host (e.g., smtp.gmail.com): " SMTP_HOST
        SMTP_HOST=${SMTP_HOST:-"smtp.gmail.com"}

        read -p "SMTP port [587]: " SMTP_PORT
        SMTP_PORT=${SMTP_PORT:-"587"}

        read -p "SMTP username: " SMTP_USER

        read -sp "SMTP password: " SMTP_PASS
        echo

        read -p "SMTP FROM address: " SMTP_FROM
        SMTP_FROM=${SMTP_FROM:-"noreply@${ADMIN_EMAIL#*@}"}
    else
        echo "Skipping SMTP configuration (you can add it later in config.env.local)"
        SMTP_HOST="smtp.example.com"
        SMTP_PORT="587"
        SMTP_USER=""
        SMTP_PASS=""
        SMTP_FROM="noreply@example.com"
    fi

    # OIDC Authentication
    echo ""
    echo "==============================================================================="
    echo "OIDC AUTHENTICATION (Single Sign-On)"
    echo "==============================================================================="
    echo "Enable Microsoft/Google login with automatic account creation"
    echo "Requires Azure/Google app setup (see documentation)"
    echo ""
    read -p "Enable OIDC authentication? (y/N): " -n 1 -r
    echo

    if [[ $REPLY =~ ^[Yy]$ ]]; then
        ENABLE_OIDC="true"
        echo ""

        read -p "Provider name (e.g., 'University of Bologna'): " OIDC_PROVIDER_NAME
        OIDC_PROVIDER_NAME=${OIDC_PROVIDER_NAME:-"SSO Provider"}

        read -p "Client ID (from Azure/Google): " OIDC_CLIENT_ID

        read -sp "Client Secret (from Azure/Google): " OIDC_CLIENT_SECRET
        echo

        read -p "Tenant ID (Azure only, leave empty for Google): " OIDC_TENANT_ID

        # Ask about multi-tenant support if using Azure
        AZURE_MULTI_TENANT="false"
        if [ -n "$OIDC_TENANT_ID" ]; then
            echo ""
            echo "Is your Azure app configured for multi-tenant (multiple Azure organizations)?"
            echo "Select 'yes' if users from different Azure tenants need to login"
            read -p "Multi-tenant Azure app? (y/N): " -n 1 -r
            echo
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                AZURE_MULTI_TENANT="true"
                echo ""
                echo "Enter all Azure tenant IDs where your users are located (comma-separated)."
                echo "You can find tenant IDs in Azure Portal > Azure Active Directory > Overview"
                echo "Example: tenant-id-1,tenant-id-2"
                read -p "Additional tenant IDs: " OIDC_ADDITIONAL_TENANT_IDS
            else
                OIDC_ADDITIONAL_TENANT_IDS=""
            fi
        else
            OIDC_ADDITIONAL_TENANT_IDS=""
        fi

        read -p "Allowed email domains (comma-separated, e.g., 'company.com,university.edu'): " OIDC_ALLOWED_DOMAINS
        OIDC_ALLOWED_DOMAINS=${OIDC_ALLOWED_DOMAINS:-""}

        # Auto-detect provider type and generate OIDC URLs
        if [ -n "$OIDC_TENANT_ID" ]; then
            # Microsoft Azure
            if [ "$AZURE_MULTI_TENANT" = "true" ]; then
                # Multi-tenant: use "organizations" endpoint
                OIDC_ISSUER="https://login.microsoftonline.com/organizations/v2.0"
                OIDC_AUTHORIZATION_URL="https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize"
                OIDC_TOKEN_URL="https://login.microsoftonline.com/organizations/oauth2/v2.0/token"
                OIDC_END_SESSION_URL="https://login.microsoftonline.com/organizations/oauth2/v2.0/logout"
            else
                # Single-tenant: use specific tenant ID
                OIDC_ISSUER="https://login.microsoftonline.com/${OIDC_TENANT_ID}/v2.0"
                OIDC_AUTHORIZATION_URL="https://login.microsoftonline.com/${OIDC_TENANT_ID}/oauth2/v2.0/authorize"
                OIDC_TOKEN_URL="https://login.microsoftonline.com/${OIDC_TENANT_ID}/oauth2/v2.0/token"
                OIDC_END_SESSION_URL="https://login.microsoftonline.com/${OIDC_TENANT_ID}/oauth2/v2.0/logout"
            fi
            OIDC_USER_INFO_URL="https://graph.microsoft.com/oidc/userinfo"
            OIDC_SCOPE="openid profile email"
        else
            # Google
            OIDC_ISSUER="https://accounts.google.com"
            OIDC_AUTHORIZATION_URL="https://accounts.google.com/o/oauth2/v2/auth"
            OIDC_TOKEN_URL="https://oauth2.googleapis.com/token"
            OIDC_USER_INFO_URL="https://openidconnect.googleapis.com/v1/userinfo"
            OIDC_END_SESSION_URL="https://accounts.google.com/o/oauth2/revoke"
            OIDC_SCOPE="openid profile email"
        fi

        echo -e "${GREEN}OIDC will be enabled${NC}"
    else
        ENABLE_OIDC="false"
    fi

    # Experimental features
    echo ""
    echo "==============================================================================="
    echo "EXPERIMENTAL FEATURES"
    echo "==============================================================================="
    read -p "Enable new editor UI? (experimental, may have bugs) (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        ENABLE_NEW_EDITOR_UI="true"
        echo -e "${GREEN}New editor UI will be enabled${NC}"
    else
        ENABLE_NEW_EDITOR_UI="false"
    fi

    # Create config.env.local
    cp config.env config.env.local

    # Update values
    sed -i "s|LAB_NAME=.*|LAB_NAME=\"${LAB_NAME}\"|" config.env.local
    sed -i "s|ADMIN_EMAIL=.*|ADMIN_EMAIL=\"${ADMIN_EMAIL}\"|" config.env.local
    sed -i "s|ENABLE_PUBLIC_ZOTERO_SIGNUP=.*|ENABLE_PUBLIC_ZOTERO_SIGNUP=\"${ENABLE_PUBLIC_ZOTERO_SIGNUP}\"|" config.env.local
    sed -i "s|DASHBOARD_ADMIN_PASSWORD=.*|DASHBOARD_ADMIN_PASSWORD=\"${DASHBOARD_PASSWORD}\"|" config.env.local
    sed -i "s|SMTP_HOST=.*|SMTP_HOST=\"${SMTP_HOST}\"|" config.env.local
    sed -i "s|SMTP_PORT=.*|SMTP_PORT=\"${SMTP_PORT}\"|" config.env.local
    sed -i "s|SMTP_USER=.*|SMTP_USER=\"${SMTP_USER}\"|" config.env.local
    sed -i "s|SMTP_PASS=.*|SMTP_PASS=\"${SMTP_PASS}\"|" config.env.local
    sed -i "s|EMAIL_FROM_ADDRESS=.*|EMAIL_FROM_ADDRESS=\"${SMTP_FROM}\"|" config.env.local

    # Set MongoDB version (4.4 for old CPUs without AVX)
    if [ -n "$MONGO_VERSION" ]; then
        sed -i "s|MONGO_VERSION=.*|MONGO_VERSION=\"${MONGO_VERSION}\"|" config.env.local
    fi

    # Set experimental features
    sed -i "s|ENABLE_NEW_EDITOR_UI=.*|ENABLE_NEW_EDITOR_UI=\"${ENABLE_NEW_EDITOR_UI}\"|" config.env.local

    # Set OIDC configuration
    sed -i "s|ENABLE_OIDC=.*|ENABLE_OIDC=\"${ENABLE_OIDC}\"|" config.env.local
    if [ "$ENABLE_OIDC" = "true" ]; then
        sed -i "s|OIDC_PROVIDER_NAME=.*|OIDC_PROVIDER_NAME=\"${OIDC_PROVIDER_NAME}\"|" config.env.local
        sed -i "s|OIDC_CLIENT_ID=.*|OIDC_CLIENT_ID=\"${OIDC_CLIENT_ID}\"|" config.env.local
        sed -i "s|OIDC_CLIENT_SECRET=.*|OIDC_CLIENT_SECRET=\"${OIDC_CLIENT_SECRET}\"|" config.env.local
        sed -i "s|OIDC_ISSUER=.*|OIDC_ISSUER=\"${OIDC_ISSUER}\"|" config.env.local
        sed -i "s|OIDC_AUTHORIZATION_URL=.*|OIDC_AUTHORIZATION_URL=\"${OIDC_AUTHORIZATION_URL}\"|" config.env.local
        sed -i "s|OIDC_TOKEN_URL=.*|OIDC_TOKEN_URL=\"${OIDC_TOKEN_URL}\"|" config.env.local
        sed -i "s|OIDC_USER_INFO_URL=.*|OIDC_USER_INFO_URL=\"${OIDC_USER_INFO_URL}\"|" config.env.local
        sed -i "s|OIDC_END_SESSION_URL=.*|OIDC_END_SESSION_URL=\"${OIDC_END_SESSION_URL}\"|" config.env.local
        sed -i "s|OIDC_SCOPE=.*|OIDC_SCOPE=\"${OIDC_SCOPE}\"|" config.env.local
        sed -i "s|OIDC_ALLOWED_DOMAINS=.*|OIDC_ALLOWED_DOMAINS=\"${OIDC_ALLOWED_DOMAINS}\"|" config.env.local
        sed -i "s|OIDC_ADDITIONAL_TENANT_IDS=.*|OIDC_ADDITIONAL_TENANT_IDS=\"${OIDC_ADDITIONAL_TENANT_IDS}\"|" config.env.local
    fi

    echo ""
    echo -e "${GREEN}✓ Configuration created${NC}"
else
    echo -e "${GREEN}✓ Configuration file found${NC}"

    # Update MONGO_VERSION if AVX not supported and not already set to 4.4
    if [ "$MONGO_VERSION" = "4.4" ]; then
        if grep -q "^MONGO_VERSION=" config.env.local; then
            sed -i 's/^MONGO_VERSION=.*/MONGO_VERSION="4.4"/' config.env.local
        else
            echo 'MONGO_VERSION="4.4"' >> config.env.local
        fi
    fi
fi

# -----------------------------------------------------------------------------
# 3. Clone repositories
# -----------------------------------------------------------------------------
echo ""
echo "[3/7] Cloning Overleaf repositories..."

if [ ! -d "overleaf-toolkit" ]; then
    echo "Cloning Overleaf Toolkit..."
    if git clone https://github.com/overleaf/toolkit.git overleaf-toolkit; then
        echo -e "${GREEN}✓ Overleaf Toolkit cloned${NC}"
    else
        echo -e "${RED}Error: Failed to clone Overleaf Toolkit${NC}"
        exit 1
    fi
else
    echo -e "${GREEN}✓ Overleaf Toolkit already exists${NC}"
fi

# Verify toolkit structure
if [ ! -f "overleaf-toolkit/bin/init" ]; then
    echo -e "${RED}Error: overleaf-toolkit/bin/init not found!${NC}"
    echo "The toolkit repository may be incomplete. Try removing it and cloning again:"
    echo "  rm -rf overleaf-toolkit"
    exit 1
fi

# -----------------------------------------------------------------------------
# 4. Initialize Overleaf Toolkit
# -----------------------------------------------------------------------------
echo ""
echo "[4/7] Initializing Overleaf Toolkit..."

cd "$SCRIPT_DIR/overleaf-toolkit"

# Run bin/init if not already initialized
if [ ! -f "config/overleaf.rc" ] || [ ! -f "config/variables.env" ]; then
    echo "Running bin/init to create configuration files..."
    if bin/init; then
        echo -e "${GREEN}✓ Configuration files created${NC}"
    else
        echo -e "${RED}Error: bin/init failed${NC}"
        echo "Try running manually: cd overleaf-toolkit && bin/init"
        exit 1
    fi
else
    echo -e "${GREEN}✓ Toolkit already initialized (config files exist)${NC}"
fi

# Verify initialization
if [ ! -f "config/overleaf.rc" ]; then
    echo -e "${RED}Error: config/overleaf.rc not created!${NC}"
    echo "Please check the toolkit installation and try again."
    exit 1
fi

# Verify bin scripts exist and are executable
if [ ! -x "bin/up" ] || [ ! -x "bin/stop" ]; then
    # Scripts might exist but not be executable, try to fix
    if [ -e "bin/up" ] && [ -e "bin/stop" ]; then
        echo "Making bin scripts executable..."
        chmod +x bin/*
    else
        echo -e "${RED}Error: Essential bin scripts (up/stop) not found!${NC}"
        echo "The toolkit may be incomplete. Try:"
        echo "  rm -rf overleaf-toolkit"
        echo "  git clone https://github.com/overleaf/toolkit.git overleaf-toolkit"
        exit 1
    fi
fi

echo -e "${GREEN}✓ Overleaf Toolkit initialized and verified${NC}"
cd "$SCRIPT_DIR"

# -----------------------------------------------------------------------------
# 5. Apply configuration
# -----------------------------------------------------------------------------
echo ""
echo "[5/7] Applying configuration to all components..."

if [ -f "./scripts/configure.sh" ]; then
    chmod +x ./scripts/configure.sh
    ./scripts/configure.sh
    echo -e "${GREEN}✓ Configuration applied${NC}"
else
    echo -e "${YELLOW}Warning: configure.sh not found, skipping configuration step${NC}"
fi

# Build custom TeX Live image with system fonts (for sandboxed compiles)
echo ""
echo "Building custom TeX Live image with system fonts..."
echo "This may take a few minutes on first run..."
if docker build -t local/texlive-fonts:latest "$SCRIPT_DIR/texlive-fonts"; then
    echo -e "${GREEN}✓ TeX Live image with fonts built${NC}"
else
    echo -e "${YELLOW}Warning: Could not build custom TeX Live image${NC}"
    echo "Sandboxed compiles will use default texlive image (some fonts may be missing)"
fi

# -----------------------------------------------------------------------------
# 6. Start Overleaf
# -----------------------------------------------------------------------------
echo ""
echo "[6/7] Starting Overleaf services..."

cd "$SCRIPT_DIR/overleaf-toolkit"
# Skip pulling texlive image (we use local/texlive-fonts:latest built above)
SIBLING_CONTAINERS_PULL=false bin/up -d
cd "$SCRIPT_DIR"

echo "Waiting for Overleaf to start and stabilize (this may take a few minutes)..."
MAX_WAIT=120
WAITED=0
STABLE_COUNT=0
RESTART_COUNT=0
REQUIRED_STABLE_CHECKS=2
MAX_RESTARTS=3

while [ $WAITED -lt $MAX_WAIT ]; do
    CONTAINER_STATUS=$(docker inspect -f '{{.State.Status}}' sharelatex 2>/dev/null || echo "not_found")

    if [ "$CONTAINER_STATUS" = "running" ]; then
        STABLE_COUNT=$((STABLE_COUNT + 1))
        RESTART_COUNT=0  # Reset restart counter when running
        echo "Container running (stability check $STABLE_COUNT/$REQUIRED_STABLE_CHECKS)..."

        if [ $STABLE_COUNT -ge $REQUIRED_STABLE_CHECKS ]; then
            echo -e "${GREEN}✓ Overleaf container is stable${NC}"
            # Try to actually execute a command to verify it's really ready
            echo "Verifying container is fully operational..."
            if docker exec sharelatex test -d /overleaf 2>/dev/null; then
                echo -e "${GREEN}✓ Container is ready and operational${NC}"
                break
            else
                echo "Container running but not ready yet, continuing to wait..."
                STABLE_COUNT=0  # Reset and keep waiting
            fi
        fi
    elif [ "$CONTAINER_STATUS" = "restarting" ]; then
        RESTART_COUNT=$((RESTART_COUNT + 1))
        echo "Container is restarting (attempt $RESTART_COUNT)... ($WAITED/$MAX_WAIT seconds)"

        if [ $RESTART_COUNT -ge $MAX_RESTARTS ]; then
            echo ""
            echo -e "${RED}ERROR: Container keeps restarting! Showing logs:${NC}"
            echo "==============================================================================="
            cd "$SCRIPT_DIR/overleaf-toolkit"
            bin/logs sharelatex 2>&1 | tail -50
            cd "$SCRIPT_DIR"
            echo "==============================================================================="
            echo ""
            echo -e "${RED}Container failed to start properly.${NC}"
            echo "Common issues:"
            echo "  1. Port 80 already in use (check with: sudo lsof -i :80)"
            echo "  2. Insufficient memory (Overleaf needs at least 2GB RAM)"
            echo "  3. Configuration error in variables.env"
            echo ""
            echo "To debug further, run: cd overleaf-toolkit && bin/logs sharelatex"
            exit 1
        fi

        STABLE_COUNT=0  # Reset stability counter
    else
        echo "Container status: $CONTAINER_STATUS, waiting... ($WAITED/$MAX_WAIT seconds)"
        STABLE_COUNT=0  # Reset stability counter
    fi

    sleep 5
    WAITED=$((WAITED + 5))
done

if [ $WAITED -ge $MAX_WAIT ]; then
    echo -e "${RED}ERROR: Container did not stabilize within $MAX_WAIT seconds${NC}"
    echo "Showing recent logs:"
    echo "==============================================================================="
    cd "$SCRIPT_DIR/overleaf-toolkit"
    bin/logs sharelatex 2>&1 | tail -50
    cd "$SCRIPT_DIR"
    echo "==============================================================================="
    echo ""
    echo "Check logs with: cd overleaf-toolkit && bin/logs sharelatex"
    exit 1
fi

echo -e "${GREEN}✓ Overleaf started${NC}"

# -----------------------------------------------------------------------------
# Note: Project restore feature is now automatically enabled via enable-features.sh

# -----------------------------------------------------------------------------
# Configure upload limit in settings.defaults.js
# -----------------------------------------------------------------------------
# Note: NGINX client_max_body_size is handled by overleafcep image via env vars
echo ""
echo "Configuring upload size limit..."
source "$SCRIPT_DIR/config.env.local"
MAX_UPLOAD_MB=$((${MAX_UPLOAD_SIZE:-524288000} / 1024 / 1024))
MAX_UPLOAD_BYTES=$((MAX_UPLOAD_MB * 1024 * 1024))

SETTINGS_FILE="/overleaf/services/web/config/settings.defaults.js"
if docker exec sharelatex bash -c "sed -i 's/maxUploadSize:[^,]*/maxUploadSize: ${MAX_UPLOAD_BYTES}/' ${SETTINGS_FILE}" 2>/dev/null; then
    echo -e "${GREEN}✓ Upload limit configured (${MAX_UPLOAD_MB}MB)${NC}"
else
    echo -e "${YELLOW}Warning: Could not configure maxUploadSize${NC}"
fi


# -----------------------------------------------------------------------------
# 7. Start Dashboard and Zotero Proxies
# -----------------------------------------------------------------------------
echo ""
echo "[7/7] Starting Dashboard and Zotero Proxies..."

# Build the Zotero proxy image first (used by dashboard to create user containers)
echo "Building Zotero proxy image..."
docker build -t zotero-overleaf-proxy:local "$SCRIPT_DIR/overleaf-zotero-manager/zotero-proxy"
echo -e "${GREEN}✓ Zotero proxy image built${NC}"

# Start dashboard (always installed)
if [ -d "$SCRIPT_DIR/overleaf-zotero-manager" ] && [ -f "$SCRIPT_DIR/overleaf-zotero-manager/.env" ]; then
    cd "$SCRIPT_DIR/overleaf-zotero-manager"
    docker compose up -d --build
    cd "$SCRIPT_DIR"
    echo -e "${GREEN}✓ Dashboard started${NC}"
    echo ""
    echo "Dashboard admin credentials configured:"
    echo "  Email: ${ADMIN_EMAIL}"
    echo "  Access: http://localhost:5000"
else
    echo -e "${YELLOW}Warning: Dashboard not configured, skipping${NC}"
fi

# Start Zotero proxies (if configured)
if [ -d "$SCRIPT_DIR/zotero-proxies" ]; then
    # Check if .env has actual user credentials (not just comments)
    if [ -f "$SCRIPT_DIR/zotero-proxies/.env" ] && grep -q "^[^#].*API_KEY=" "$SCRIPT_DIR/zotero-proxies/.env" 2>/dev/null; then
        echo "Starting Zotero proxies..."
        cd "$SCRIPT_DIR/zotero-proxies"
        docker compose up -d
        cd "$SCRIPT_DIR"
        echo -e "${GREEN}✓ Zotero proxies started${NC}"
    else
        echo -e "${YELLOW}Note: Zotero proxies not configured yet (no user credentials).${NC}"
        echo "      You can configure them later via the dashboard."
    fi
else
    echo -e "${YELLOW}Warning: zotero-proxies directory not found${NC}"
fi

# -----------------------------------------------------------------------------
# Installation Complete
# -----------------------------------------------------------------------------
echo ""
echo "==============================================================================="
echo "          INSTALLATION COMPLETE!"
echo "==============================================================================="
echo ""

# Load config to show URLs
if [ -f config.env.local ]; then
    source config.env.local
    echo "Your Overleaf Lab is ready:"
    echo ""
fi

echo ""
echo "==============================================================================="
echo "DASHBOARD LOGIN CREDENTIALS:"
echo "==============================================================================="
echo "  Email: ${ADMIN_EMAIL}"
echo "  Password: [the password you just set]"
echo ""
echo "⚠️  IMPORTANT: These credentials are for the DASHBOARD only (port 5000)."
echo "    Overleaf login is separate - create it via /launchpad after first access."
echo "==============================================================================="
echo ""
echo "Next steps:"
echo ""
echo "  1. Create Overleaf admin user:"
echo "     Visit: ${OVERLEAF_URL:-http://localhost}/launchpad"
echo "     Register your first Overleaf admin account"
echo ""
echo "  2. Access dashboard (already configured):"
echo "     Visit: http://localhost:${FLASK_PORT:-5000}"
echo "     Login with the dashboard credentials above"
echo ""
echo "For help and documentation, see:"
echo "  - README.md for quick start guide"
echo "  - INSTALLATION.md for detailed documentation"
echo ""
echo "==============================================================================="
echo ""
echo "==============================================================================="
echo "PUBLIC ACCESS (Optional)"
echo "==============================================================================="
echo ""
echo "To make your Overleaf Lab accessible from the internet:"
echo ""
echo "Prerequisites:"
echo "  1. Have a Cloudflare account"
echo "  2. Register a domain with Cloudflare (or transfer DNS to Cloudflare)"
echo ""
echo "Then run: ./scripts/setup-cloudflare-tunnel.sh"
echo ""
echo "This will:"
echo "  - Install cloudflared (if not present)"
echo "  - Create a secure tunnel to your services"
echo "  - Configure DNS records automatically"
echo "  - Set up HTTPS with Cloudflare certificates"
echo ""
echo "==============================================================================="
