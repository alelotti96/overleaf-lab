#!/bin/bash

#===============================================================================
# SET UPLOAD LIMIT
#===============================================================================
# This script configures the upload size limit in Overleaf by modifying
# settings.defaults.js (the per-file limit)
#
# Note: NGINX client_max_body_size is handled by the overleafcep image
# via environment variables in variables.env (MAX_UPLOAD_SIZE)
#===============================================================================

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

echo "==============================================================================="
echo "          SET UPLOAD SIZE LIMIT"
echo "==============================================================================="
echo ""

# Check if container is running
if ! docker ps | grep -q sharelatex; then
    echo -e "${RED}Error: Overleaf container is not running${NC}"
    echo "Start it with: cd overleaf-toolkit && bin/up -d"
    exit 1
fi

# Load config
if [ -f "config.env.local" ]; then
    source config.env.local
    DEFAULT_MB=$((${MAX_UPLOAD_SIZE:-524288000} / 1024 / 1024))
else
    DEFAULT_MB=500
fi

echo "Current MAX_UPLOAD_SIZE in config: ${DEFAULT_MB}MB"
echo ""
read -p "Enter new upload limit in MB [${DEFAULT_MB}]: " NEW_LIMIT_MB
NEW_LIMIT_MB=${NEW_LIMIT_MB:-${DEFAULT_MB}}

echo ""
echo "Setting upload limit to ${NEW_LIMIT_MB}MB..."

# Calculate bytes
NEW_LIMIT_BYTES=$((NEW_LIMIT_MB * 1024 * 1024))

# Configure Web App maxUploadSize in settings.defaults.js
echo ""
echo "Configuring web app maxUploadSize..."

SETTINGS_FILE="/overleaf/services/web/config/settings.defaults.js"

# Check current value
CURRENT_VALUE=$(docker exec sharelatex grep -oP 'maxUploadSize:\s*\K[0-9]+' "$SETTINGS_FILE" 2>/dev/null | head -1 || echo "unknown")
echo "  Current maxUploadSize: ${CURRENT_VALUE}"

# Use sed to replace the maxUploadSize value
if docker exec sharelatex bash -c "sed -i 's/maxUploadSize:[^,]*/maxUploadSize: ${NEW_LIMIT_BYTES}/' ${SETTINGS_FILE}"; then
    echo -e "${GREEN}✓ Web app maxUploadSize configured${NC}"
else
    echo -e "${YELLOW}Warning: Could not modify settings.defaults.js${NC}"
fi

# Update config.env.local
echo ""
echo "Updating config.env.local..."
sed -i "s|^MAX_UPLOAD_SIZE=.*|MAX_UPLOAD_SIZE=\"${NEW_LIMIT_BYTES}\"|" config.env.local
echo -e "${GREEN}✓ config.env.local updated${NC}"

echo ""
echo "==============================================================================="
echo -e "${GREEN}Upload limit configured: ${NEW_LIMIT_MB}MB${NC}"
echo "==============================================================================="
echo ""
echo -e "${YELLOW}NOTE: To persist changes, restart Overleaf:${NC}"
echo "  cd overleaf-toolkit && bin/stop && bin/up -d"
echo ""
