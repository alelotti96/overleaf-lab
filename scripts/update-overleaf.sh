#!/bin/bash

# Update Overleaf CEP image without touching MongoDB, Redis, or other services

set -e

cd "$(dirname "$0")/.."

OVERRIDE_FILE="overleaf-toolkit/config/docker-compose.override.yml"

# Get current version
CURRENT_VERSION=$(grep -oP 'overleafcep/sharelatex:\K[^"]+' "$OVERRIDE_FILE" 2>/dev/null || echo "unknown")

echo "=================================="
echo "  Overleaf CEP Update Script"
echo "=================================="
echo ""
echo "Current version: $CURRENT_VERSION"
echo ""

# Check for available versions
echo "Checking available versions from Docker Hub..."
echo ""

# Try to get tags from Docker Hub API
TAGS=$(curl -s "https://hub.docker.com/v2/repositories/overleafcep/sharelatex/tags?page_size=10" 2>/dev/null | \
       grep -oP '"name":"[^"]+' | sed 's/"name":"//' | head -10)

if [ -n "$TAGS" ]; then
    echo "Recent available versions:"
    echo "$TAGS" | while read tag; do
        if [ "$tag" = "$CURRENT_VERSION" ]; then
            echo "  - $tag (current)"
        else
            echo "  - $tag"
        fi
    done
else
    echo "Could not fetch versions. Check manually at:"
    echo "https://hub.docker.com/r/overleafcep/sharelatex/tags"
fi

echo ""
echo "You can also check releases at:"
echo "https://github.com/yu-i-i/overleaf-cep/wiki"
echo ""

# Ask for new version
read -p "Enter new version (or press Enter to cancel): " NEW_VERSION

if [ -z "$NEW_VERSION" ]; then
    echo "Cancelled."
    exit 0
fi

if [ "$NEW_VERSION" = "$CURRENT_VERSION" ]; then
    echo "Already on version $NEW_VERSION. Nothing to do."
    exit 0
fi

echo ""
echo "Updating from $CURRENT_VERSION to $NEW_VERSION..."

# Backup current config
cp "$OVERRIDE_FILE" "${OVERRIDE_FILE}.backup.$(date +%Y%m%d_%H%M%S)"

# Update version in docker-compose.override.yml
sed -i "s|overleafcep/sharelatex:${CURRENT_VERSION}|overleafcep/sharelatex:${NEW_VERSION}|g" "$OVERRIDE_FILE"

echo "Configuration updated."
echo ""

# Pull new image
echo "Pulling new image..."
cd overleaf-toolkit
bin/docker-compose pull sharelatex

echo ""
echo "Restarting Overleaf..."
bin/stop
# Skip pulling local texlive image (it's built locally, not on Docker Hub)
SIBLING_CONTAINERS_PULL=false bin/up -d

echo ""
echo "=================================="
echo "  Update complete!"
echo "=================================="
echo ""
echo "Updated: $CURRENT_VERSION -> $NEW_VERSION"
echo ""
echo "MongoDB, Redis, and Dashboard were NOT touched."
echo "Your data and projects are preserved."
echo ""
echo "Check Overleaf at: http://localhost"
