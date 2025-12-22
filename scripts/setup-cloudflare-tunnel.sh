#!/bin/bash

#===============================================================================
# CLOUDFLARE TUNNEL SETUP (AUTOMATED)
#===============================================================================
# This script automates the complete Cloudflare Tunnel setup for Overleaf
#===============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

echo "==============================================================================="
echo "          CLOUDFLARE TUNNEL SETUP"
echo "==============================================================================="
echo ""

# -----------------------------------------------------------------------------
# 1. Check/Install cloudflared
# -----------------------------------------------------------------------------
echo "[1/7] Checking cloudflared installation..."

if ! command -v cloudflared &> /dev/null; then
    echo -e "${YELLOW}cloudflared not found. Installing...${NC}"
    wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
    sudo dpkg -i cloudflared-linux-amd64.deb
    rm cloudflared-linux-amd64.deb
    echo -e "${GREEN}✓ cloudflared installed${NC}"
else
    echo -e "${GREEN}✓ cloudflared already installed${NC}"
fi

# -----------------------------------------------------------------------------
# 2. Login to Cloudflare
# -----------------------------------------------------------------------------
echo ""
echo "[2/7] Cloudflare authentication..."

# Check if already logged in by looking for cert.pem
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
    echo ""
    echo "You need to login to Cloudflare."
    echo "A browser window will open. Please authorize cloudflared."
    echo ""
    read -p "Press ENTER to continue..."

    cloudflared tunnel login

    if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
        echo -e "${RED}Error: Login failed. cert.pem not found.${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ Cloudflare login successful${NC}"
else
    echo -e "${GREEN}✓ Already logged in to Cloudflare${NC}"
fi

# -----------------------------------------------------------------------------
# 3. Get domain information
# -----------------------------------------------------------------------------
echo ""
echo "[3/7] Domain configuration..."
echo ""

# Load config to check if public signup is enabled
if [ -f "config.env.local" ]; then
    source config.env.local
fi

# Ask for domain
read -p "Enter your domain (e.g., example.com): " DOMAIN

if [ -z "$DOMAIN" ]; then
    echo -e "${RED}Error: Domain cannot be empty${NC}"
    exit 1
fi

# Ask for subdomains
read -p "Overleaf subdomain [overleaf]: " OVERLEAF_SUBDOMAIN
OVERLEAF_SUBDOMAIN=${OVERLEAF_SUBDOMAIN:-overleaf}

read -p "Dashboard subdomain (for remote admin access) [overleaf-dashboard]: " DASHBOARD_SUBDOMAIN
DASHBOARD_SUBDOMAIN=${DASHBOARD_SUBDOMAIN:-overleaf-dashboard}

# Only ask for signup subdomain if public signup is enabled
SIGNUP_SUBDOMAIN=""
SIGNUP_HOSTNAME=""
if [ "${ENABLE_PUBLIC_ZOTERO_SIGNUP}" = "true" ]; then
    read -p "Signup subdomain (for public Zotero registration) [zotero-signup]: " SIGNUP_SUBDOMAIN
    SIGNUP_SUBDOMAIN=${SIGNUP_SUBDOMAIN:-zotero-signup}
fi

# Build full hostnames
OVERLEAF_HOSTNAME="${OVERLEAF_SUBDOMAIN}.${DOMAIN}"
DASHBOARD_HOSTNAME="${DASHBOARD_SUBDOMAIN}.${DOMAIN}"
if [ "${ENABLE_PUBLIC_ZOTERO_SIGNUP}" = "true" ]; then
    SIGNUP_HOSTNAME="${SIGNUP_SUBDOMAIN}.${DOMAIN}"
fi

echo ""
echo "Your services will be accessible at:"
echo "  📝 Overleaf:   https://${OVERLEAF_HOSTNAME}"
echo "  🎛️  Dashboard: https://${DASHBOARD_HOSTNAME}"
if [ "${ENABLE_PUBLIC_ZOTERO_SIGNUP}" = "true" ]; then
    echo "  📋 Signup:    https://${SIGNUP_HOSTNAME}"
fi
echo "  📚 Zotero:     http://zotero-username:5000 (Docker network only)"
echo ""
read -p "Proceed with these hostnames? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Setup cancelled."
    exit 0
fi

# -----------------------------------------------------------------------------
# 4. Create tunnel
# -----------------------------------------------------------------------------
echo ""
echo "[4/7] Creating Cloudflare Tunnel..."

TUNNEL_NAME="overleaf-lab"

# Check if tunnel already exists
if cloudflared tunnel list 2>/dev/null | grep -q "$TUNNEL_NAME"; then
    echo -e "${YELLOW}Tunnel '$TUNNEL_NAME' already exists. Using existing tunnel.${NC}"
    TUNNEL_ID=$(cloudflared tunnel list | grep "$TUNNEL_NAME" | awk '{print $1}')
else
    echo "Creating new tunnel: $TUNNEL_NAME"
    cloudflared tunnel create "$TUNNEL_NAME"
    TUNNEL_ID=$(cloudflared tunnel list | grep "$TUNNEL_NAME" | awk '{print $1}')
fi

if [ -z "$TUNNEL_ID" ]; then
    echo -e "${RED}Error: Failed to get tunnel ID${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Tunnel created/found: $TUNNEL_ID${NC}"

# -----------------------------------------------------------------------------
# 5. Create tunnel configuration
# -----------------------------------------------------------------------------
echo ""
echo "[5/7] Creating tunnel configuration..."

mkdir -p "$HOME/.cloudflared"

# Create config.yml
cat > "$HOME/.cloudflared/config.yml" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $HOME/.cloudflared/$TUNNEL_ID.json
protocol: http2

ingress:
  # Overleaf
  - hostname: $OVERLEAF_HOSTNAME
    service: http://localhost:80
    originRequest:
      noTLSVerify: true
      connectTimeout: 120s

  # Dashboard (admin panel - protect with Access policy!)
  - hostname: $DASHBOARD_HOSTNAME
    service: http://localhost:5000
    originRequest:
      noTLSVerify: true
EOF

# Add signup section only if public signup is enabled
if [ "${ENABLE_PUBLIC_ZOTERO_SIGNUP}" = "true" ]; then
    cat >> "$HOME/.cloudflared/config.yml" <<EOF

  # Public Zotero signup (auto-redirects to /zotero/signup)
  - hostname: $SIGNUP_HOSTNAME
    service: http://localhost:5000
    originRequest:
      noTLSVerify: true
EOF
fi

# Add catch-all section
cat >> "$HOME/.cloudflared/config.yml" <<EOF

  # Catch-all rule
  - service: http_status:404
EOF

echo -e "${GREEN}✓ Tunnel configuration created${NC}"

# -----------------------------------------------------------------------------
# 6. Configure DNS records
# -----------------------------------------------------------------------------
echo ""
echo "[6/7] Configuring DNS records..."

echo "Adding DNS records for tunnel endpoints..."

# Function to add DNS record
add_dns_record() {
    local hostname=$1

    # Check if route already exists
    if cloudflared tunnel route dns list 2>/dev/null | grep -q "$hostname"; then
        echo "  ✓ DNS record for $hostname already exists"
    else
        echo "  Adding DNS record for $hostname..."
        if cloudflared tunnel route dns "$TUNNEL_NAME" "$hostname"; then
            echo "  ✓ DNS record added for $hostname"
        else
            echo -e "  ${YELLOW}⚠ Warning: Could not add DNS for $hostname (may need manual setup)${NC}"
        fi
    fi
}

add_dns_record "$OVERLEAF_HOSTNAME"
add_dns_record "$DASHBOARD_HOSTNAME"
if [ "${ENABLE_PUBLIC_ZOTERO_SIGNUP}" = "true" ]; then
    add_dns_record "$SIGNUP_HOSTNAME"
fi

echo -e "${GREEN}✓ DNS configuration complete${NC}"

# -----------------------------------------------------------------------------
# 7. Update Overleaf configuration
# -----------------------------------------------------------------------------
echo ""
echo "[7/7] Updating Overleaf configuration..."

if [ ! -f "config.env.local" ]; then
    echo -e "${RED}Error: config.env.local not found!${NC}"
    echo "Please run the installation first: ./install.sh"
    exit 1
fi

# Backup current config
cp config.env.local config.env.local.backup.$(date +%Y%m%d_%H%M%S)

# Update configuration with public URLs
sed -i "s|^OVERLEAF_URL=.*|OVERLEAF_URL=\"https://${OVERLEAF_HOSTNAME}\"|" config.env.local
sed -i "s|^DASHBOARD_URL=.*|DASHBOARD_URL=\"https://${DASHBOARD_HOSTNAME}\"|" config.env.local
if [ "${ENABLE_PUBLIC_ZOTERO_SIGNUP}" = "true" ]; then
    sed -i "s|^DASHBOARD_SIGNUP_URL=.*|DASHBOARD_SIGNUP_URL=\"https://${SIGNUP_HOSTNAME}\"|" config.env.local
    # Set signup subdomain for Flask hostname-based redirect
    sed -i "s|^SIGNUP_SUBDOMAIN=.*|SIGNUP_SUBDOMAIN=\"${SIGNUP_SUBDOMAIN}\"|" config.env.local
fi
sed -i "s|^BEHIND_PROXY=.*|BEHIND_PROXY=\"true\"|" config.env.local
sed -i "s|^USE_SECURE_COOKIES=.*|USE_SECURE_COOKIES=\"true\"|" config.env.local
sed -i "s|^SESSION_COOKIE_SECURE=.*|SESSION_COOKIE_SECURE=\"True\"|" config.env.local

echo -e "${GREEN}✓ Configuration updated${NC}"

# Apply configuration
echo ""
echo "Applying configuration to Overleaf..."
./scripts/configure.sh

echo ""
echo "Restarting services..."
cd overleaf-toolkit && bin/stop && SIBLING_CONTAINERS_PULL=false bin/up -d && cd ..
# Dashboard always installed, restart it to reload environment variables
if [ -d "overleaf-zotero-manager" ]; then
    echo "Restarting dashboard to apply new configuration..."
    cd overleaf-zotero-manager && docker compose down && docker compose up -d && cd ..
fi

# -----------------------------------------------------------------------------
# Start tunnel
# -----------------------------------------------------------------------------
echo ""
echo "==============================================================================="
echo "          TUNNEL SETUP COMPLETE!"
echo "==============================================================================="
echo ""
echo "Your Cloudflare Tunnel is configured and ready."
echo ""
read -p "Install tunnel as system service? (y/n) " -n 1 -r
echo

if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo ""

    # Copy config to system location (required for service)
    sudo mkdir -p /etc/cloudflared
    sudo cp "$HOME/.cloudflared/config.yml" /etc/cloudflared/
    sudo cp "$HOME/.cloudflared/"*.json /etc/cloudflared/
    sudo cp "$HOME/.cloudflared/cert.pem" /etc/cloudflared/ 2>/dev/null || true

    # Update credentials path in system config
    sudo sed -i "s|$HOME/.cloudflared|/etc/cloudflared|g" /etc/cloudflared/config.yml

    # Check if service already exists
    if systemctl is-enabled cloudflared.service >/dev/null 2>&1 || systemctl is-active cloudflared.service >/dev/null 2>&1; then
        echo "Cloudflared service already installed. Updating configuration and restarting..."
        sudo systemctl restart cloudflared
    else
        echo "Installing tunnel as service..."
        sudo cloudflared service install
        sudo systemctl start cloudflared
        sudo systemctl enable cloudflared
    fi

    echo ""
    echo "Checking tunnel status..."
    sleep 3
    sudo systemctl status cloudflared --no-pager -l

    echo ""
    echo -e "${GREEN}✓ Tunnel service installed and started${NC}"
else
    echo ""
    echo "You can start the tunnel manually with:"
    echo "  cloudflared tunnel run $TUNNEL_NAME"
fi

echo ""
echo "==============================================================================="
echo "          YOUR SERVICES ARE NOW PUBLIC!"
echo "==============================================================================="
echo ""
echo "Access your services at:"
echo "  📝 Overleaf:   https://${OVERLEAF_HOSTNAME}"
echo "  🎛️  Dashboard: https://${DASHBOARD_HOSTNAME}"
if [ "${ENABLE_PUBLIC_ZOTERO_SIGNUP}" = "true" ]; then
    echo "  📋 Signup:    https://${SIGNUP_HOSTNAME} (public, auto-redirects to signup page)"
fi
echo "  📚 Zotero:     http://zotero-username:5000 (Docker network only)"
echo ""
echo "IMPORTANT: Configure Cloudflare Access policies to secure your services!"
echo "  Go to: https://one.dash.cloudflare.com → Access → Applications"
echo ""
echo "  Create Self-hosted Applications:"
echo "  1. Overleaf (${OVERLEAF_HOSTNAME})"
echo "     → Restrict to lab members (email list) or group/institution (email domain)"
echo ""
echo "  2. Dashboard (${DASHBOARD_HOSTNAME})"
echo "     → Restrict to admins only (email list)"
if [ "${ENABLE_PUBLIC_ZOTERO_SIGNUP}" = "true" ]; then
    echo ""
    echo "  3. Zotero Signup (${SIGNUP_HOSTNAME})"
    echo "     → Restrict to lab members (email list) or group/institution (email domain)"
    echo "     → Dashboard and Signup point to the same app, but with different policies"
fi
echo ""
echo "==============================================================================="
