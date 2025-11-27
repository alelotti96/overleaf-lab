#!/bin/bash

#===============================================================================
# OVERLEAF-LAB UNINSTALLER
#===============================================================================
# This script removes all Overleaf-Lab components
#===============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==============================================================================="
echo "                    OVERLEAF-LAB UNINSTALLER"
echo "==============================================================================="
echo ""
echo -e "${RED}WARNING: This will remove all Overleaf data and configurations!${NC}"
echo ""
echo "This will:"
echo "  • Stop and remove all containers (Overleaf, MongoDB, Zotero proxies, Dashboard)"
echo "  • Remove Docker images created by this installation"
echo "  • Remove Docker volumes (all your Overleaf projects will be lost!)"
echo "  • Remove the overleaf-toolkit directory"
echo "  • Optionally remove Cloudflare tunnel"
echo "  • Optionally remove Docker from your system"
echo ""
read -p "Are you absolutely sure you want to continue? (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
    echo "Uninstallation cancelled."
    exit 0
fi

echo ""
echo "==============================================================================="
echo "Step 1: Stopping and removing containers"
echo "==============================================================================="

# Stop Overleaf containers
if [ -d "$SCRIPT_DIR/overleaf-toolkit" ]; then
    echo "Stopping Overleaf containers..."
    cd "$SCRIPT_DIR/overleaf-toolkit"
    bin/stop 2>/dev/null || true
    cd "$SCRIPT_DIR"
fi

# Stop Zotero proxies
if [ -d "$SCRIPT_DIR/zotero-proxies" ]; then
    echo "Stopping Zotero proxy containers..."
    cd "$SCRIPT_DIR/zotero-proxies"
    docker compose down 2>/dev/null || true
    cd "$SCRIPT_DIR"
fi

# Stop dashboard
if [ -d "$SCRIPT_DIR/overleaf-zotero-manager" ]; then
    echo "Stopping dashboard container..."
    cd "$SCRIPT_DIR/overleaf-zotero-manager"
    docker compose down 2>/dev/null || true
    cd "$SCRIPT_DIR"
fi

# Remove any remaining Zotero containers
echo "Removing Zotero containers..."
docker ps -a | grep "zotero-" | awk '{print $1}' | xargs -r docker rm -f 2>/dev/null || true

echo -e "${GREEN}✓ All containers stopped and removed${NC}"
echo ""

echo "==============================================================================="
echo "Step 2: Removing Docker volumes"
echo "==============================================================================="
echo ""
echo -e "${YELLOW}This will delete all your Overleaf projects permanently!${NC}"
read -p "Remove Docker volumes? (yes/no): " REMOVE_VOLUMES

if [ "$REMOVE_VOLUMES" = "yes" ]; then
    echo "Removing Docker volumes..."
    docker volume rm sharelatex 2>/dev/null || true
    docker volume rm mongo_data 2>/dev/null || true
    docker volume rm redis_data 2>/dev/null || true
    docker volume ls | grep "overleaf" | awk '{print $2}' | xargs -r docker volume rm 2>/dev/null || true
    echo -e "${GREEN}✓ Docker volumes removed${NC}"
else
    echo "Keeping Docker volumes (you can remove them manually later with: docker volume prune)"
fi

echo ""

echo "==============================================================================="
echo "Step 3: Removing Docker images"
echo "==============================================================================="

echo "Removing custom images..."
docker rmi local/sharelatex-texlive-full:latest 2>/dev/null || true
docker rmi zotero-overleaf-proxy:local 2>/dev/null || true
# Remove any zotero user containers and images
docker images | grep "zotero-" | awk '{print $3}' | xargs -r docker rmi -f 2>/dev/null || true
# Dashboard image is built on-the-fly, remove by pattern
docker images | grep "overleaf-zotero-manager" | awk '{print $3}' | xargs -r docker rmi -f 2>/dev/null || true

echo ""
read -p "Remove Overleaf base images? (This will save disk space) (yes/no): " REMOVE_IMAGES

if [ "$REMOVE_IMAGES" = "yes" ]; then
    echo "Removing Overleaf images..."
    docker images | grep "overleafcep/sharelatex" | awk '{print $3}' | xargs -r docker rmi -f 2>/dev/null || true
    docker images | grep "sharelatex/sharelatex" | awk '{print $3}' | xargs -r docker rmi -f 2>/dev/null || true
    docker images | grep "mongo" | awk '{print $3}' | xargs -r docker rmi -f 2>/dev/null || true
    docker images | grep "redis" | awk '{print $3}' | xargs -r docker rmi -f 2>/dev/null || true
    echo -e "${GREEN}✓ Docker images removed${NC}"
else
    echo "Keeping Docker images"
fi

echo ""

echo "==============================================================================="
echo "Step 4: Removing directories and files"
echo "==============================================================================="

# Remove directories
if [ -d "$SCRIPT_DIR/overleaf-toolkit" ]; then
    echo "Removing overleaf-toolkit directory..."
    rm -rf "$SCRIPT_DIR/overleaf-toolkit"
    echo -e "${GREEN}✓ overleaf-toolkit removed${NC}"
fi

if [ -d "$SCRIPT_DIR/data" ]; then
    echo "Removing data directory..."
    rm -rf "$SCRIPT_DIR/data"
    echo -e "${GREEN}✓ data directory removed${NC}"
fi

# Remove generated config files
if [ -f "$SCRIPT_DIR/config.env.local" ]; then
    echo "Removing config.env.local..."
    rm -f "$SCRIPT_DIR/config.env.local"
    rm -f "$SCRIPT_DIR/config.env.local.backup".*
fi

if [ -f "$SCRIPT_DIR/overleaf-zotero-manager/.env" ]; then
    echo "Removing dashboard .env..."
    rm -f "$SCRIPT_DIR/overleaf-zotero-manager/.env"
fi

if [ -f "$SCRIPT_DIR/zotero-proxies/.env" ]; then
    echo "Removing zotero-proxies .env..."
    rm -f "$SCRIPT_DIR/zotero-proxies/.env"
fi

if [ -f "$SCRIPT_DIR/zotero-proxies/docker-compose.yml" ]; then
    echo "Removing zotero-proxies docker-compose.yml..."
    rm -f "$SCRIPT_DIR/zotero-proxies/docker-compose.yml"
fi

echo -e "${GREEN}✓ Configuration files removed${NC}"
echo ""

echo "==============================================================================="
echo "Step 5: Cloudflare tunnel removal (optional)"
echo "==============================================================================="
echo ""
read -p "Do you want to remove Cloudflare tunnel if installed? (yes/no): " REMOVE_CLOUDFLARE

if [ "$REMOVE_CLOUDFLARE" = "yes" ]; then
    echo ""
    echo -e "${YELLOW}Removing Cloudflare tunnel...${NC}"

    # Use cloudflared's built-in uninstall if available
    if command -v cloudflared &> /dev/null; then
        echo "Uninstalling cloudflared service..."
        sudo cloudflared service uninstall 2>/dev/null || true
    fi

    # Stop and disable cloudflared service (in case of manual installation)
    sudo systemctl stop cloudflared 2>/dev/null || true
    sudo systemctl disable cloudflared 2>/dev/null || true

    # Remove service files
    sudo rm -f /etc/systemd/system/cloudflared.service 2>/dev/null || true
    sudo rm -f /etc/systemd/system/cloudflared-update.service 2>/dev/null || true
    sudo systemctl daemon-reload 2>/dev/null || true

    # Remove cloudflared configuration
    sudo rm -rf /etc/cloudflared 2>/dev/null || true
    rm -rf ~/.cloudflared 2>/dev/null || true

    # Remove cloudflared binary (if installed via package manager or manually)
    if command -v apt-get &> /dev/null; then
        sudo apt-get purge -y cloudflared 2>/dev/null || true
    elif command -v dnf &> /dev/null; then
        sudo dnf remove -y cloudflared 2>/dev/null || true
    elif command -v yum &> /dev/null; then
        sudo yum remove -y cloudflared 2>/dev/null || true
    fi

    # Remove manual installation
    sudo rm -f /usr/local/bin/cloudflared 2>/dev/null || true

    echo -e "${GREEN}✓ Cloudflare tunnel removed${NC}"
    echo ""
    echo -e "${YELLOW}Note: You may need to manually delete the tunnel from Cloudflare dashboard${NC}"
    echo "  Visit: https://one.dash.cloudflare.com → Zero Trust → Networks → Tunnels"
else
    echo "Keeping Cloudflare tunnel"
fi

echo ""

echo "==============================================================================="
echo "Step 6: Docker removal (optional)"
echo "==============================================================================="
echo ""
read -p "Do you want to remove Docker from your system? (yes/no): " REMOVE_DOCKER

if [ "$REMOVE_DOCKER" = "yes" ]; then
    echo ""
    echo -e "${YELLOW}Removing Docker...${NC}"

    # Stop Docker service
    sudo systemctl stop docker 2>/dev/null || true
    sudo systemctl stop docker.socket 2>/dev/null || true

    # Remove Docker packages
    if command -v apt-get &> /dev/null; then
        echo "Detected Debian/Ubuntu system..."
        sudo apt-get purge -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin 2>/dev/null || true
        sudo apt-get autoremove -y 2>/dev/null || true
    elif command -v dnf &> /dev/null; then
        echo "Detected Fedora/RHEL system..."
        sudo dnf remove -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin 2>/dev/null || true
    elif command -v yum &> /dev/null; then
        echo "Detected CentOS/RHEL system..."
        sudo yum remove -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin 2>/dev/null || true
    fi

    # Remove Docker data directories
    sudo rm -rf /var/lib/docker 2>/dev/null || true
    sudo rm -rf /var/lib/containerd 2>/dev/null || true
    sudo rm -rf /etc/docker 2>/dev/null || true
    sudo rm -rf ~/.docker 2>/dev/null || true

    # Remove Docker repository files
    sudo rm -f /etc/apt/keyrings/docker.gpg 2>/dev/null || true
    sudo rm -f /etc/apt/sources.list.d/docker.list 2>/dev/null || true

    # Remove Docker group
    sudo groupdel docker 2>/dev/null || true

    echo -e "${GREEN}✓ Docker removed${NC}"
else
    echo "Keeping Docker installed"
    echo ""
    echo "You can clean up unused Docker resources with:"
    echo "  docker system prune -a --volumes"
fi

echo ""
echo "==============================================================================="
echo "                    UNINSTALLATION COMPLETE"
echo "==============================================================================="
echo ""
echo -e "${GREEN}Overleaf-Lab has been removed from your system.${NC}"
echo ""

if [ "$REMOVE_DOCKER" != "yes" ]; then
    echo "Docker is still installed. To remove unused Docker data, run:"
    echo "  docker system prune -a --volumes"
    echo ""
fi

echo "To reinstall, run: ./install.sh"
echo ""
