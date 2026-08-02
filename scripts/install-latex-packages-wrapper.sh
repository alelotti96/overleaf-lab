#!/bin/bash

#===============================================================================
# LATEX PACKAGES INSTALLATION WRAPPER
#===============================================================================
# This script installs extra LaTeX packages into the Overleaf container
# and commits it as a new Docker image
#===============================================================================

set -e

# Get script directory (parent of scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Installing extra LaTeX packages..."
echo ""

if [ ! -d "$SCRIPT_DIR/overleaf-toolkit" ]; then
    echo "Error: overleaf-toolkit directory not found!"
    echo "Please run the main installation first."
    exit 1
fi

cd "$SCRIPT_DIR/overleaf-toolkit"

# Start containers if not running
echo "Starting Overleaf containers..."
bin/up -d

# Wait for container to be ready and STABLE (not just running once)
echo "Waiting for Overleaf container to be ready and stable..."
MAX_WAIT=120
WAITED=0
STABLE_COUNT=0
REQUIRED_STABLE_CHECKS=2

while [ $WAITED -lt $MAX_WAIT ]; do
    CONTAINER_STATUS=$(docker inspect -f '{{.State.Status}}' sharelatex 2>/dev/null || echo "not_found")

    if [ "$CONTAINER_STATUS" = "running" ]; then
        STABLE_COUNT=$((STABLE_COUNT + 1))
        echo "Container running (stability check $STABLE_COUNT/$REQUIRED_STABLE_CHECKS)..."

        if [ $STABLE_COUNT -ge $REQUIRED_STABLE_CHECKS ]; then
            echo "✓ Container is stable"
            # Try to actually execute a command to verify it's really ready
            echo "Verifying container is fully operational..."
            if docker exec sharelatex test -d /overleaf 2>/dev/null; then
                echo "✓ Container is ready and operational"
                break
            else
                echo "Container running but not ready yet, continuing to wait..."
                STABLE_COUNT=0  # Reset and keep waiting
            fi
        fi
    elif [ "$CONTAINER_STATUS" = "restarting" ]; then
        echo "Container is restarting, waiting... ($WAITED/$MAX_WAIT seconds)"
        STABLE_COUNT=0  # Reset stability counter
    elif [ "$CONTAINER_STATUS" = "not_found" ]; then
        echo "Container not found!"
        exit 1
    else
        echo "Container status: $CONTAINER_STATUS, waiting... ($WAITED/$MAX_WAIT seconds)"
        STABLE_COUNT=0  # Reset stability counter
    fi

    sleep 5
    WAITED=$((WAITED + 5))
done

if [ $WAITED -ge $MAX_WAIT ]; then
    echo "Error: Container did not stabilize within $MAX_WAIT seconds"
    exit 1
fi

# Copy installation script to container
echo "Copying installation script to container..."
docker cp ../scripts/install-latex-packages.sh sharelatex:/root/

# Execute installation script
echo "Installing LaTeX packages (this may take several minutes)..."
docker exec sharelatex bash -c "chmod +x /root/install-latex-packages.sh && /root/install-latex-packages.sh"

# Commit the modified container as new image
echo ""
echo "Creating custom Docker image..."
docker commit sharelatex local/sharelatex-texlive-full:latest

cd "$SCRIPT_DIR"

echo ""
echo "==============================================================================="
echo "Custom LaTeX packages installed successfully!"
echo "==============================================================================="
echo ""
echo "A new Docker image 'local/sharelatex-texlive-full:latest' has been created."
echo ""
echo "NOTE: If you used install.sh, the image is already configured automatically."
echo ""
echo "If you ran this script manually, follow these steps to activate the image:"
echo "  1. Edit config.env.local"
echo "  2. Set OVERLEAF_IMAGE=local/sharelatex-texlive-full"
echo "  3. Set OVERLEAF_IMAGE_TAG=latest"
echo "  4. Run: ./scripts/configure.sh"
echo "  5. Restart Overleaf: cd overleaf-toolkit && bin/stop && bin/up -d"
echo ""
