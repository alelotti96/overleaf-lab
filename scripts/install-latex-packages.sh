#!/bin/bash

set -e  # Exit on error

echo "Installing system fonts..."
apt-get update

# Pre-accept Microsoft fonts EULA
echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" | debconf-set-selections

# Install fonts
DEBIAN_FRONTEND=noninteractive apt-get install -y fontconfig fonts-liberation ttf-mscorefonts-installer

# Rebuild font cache
fc-cache -f -v

echo "Updating tlmgr package manager..."
tlmgr update --self

echo "Installing TeX Live Full Scheme (all packages)..."
echo "⚠ Warning: This will download ~7GB of packages and may take 15-30 minutes"
echo ""

# Install scheme-full (complete TeX Live installation)
tlmgr install scheme-full

echo ""
echo "✓ TeX Live Full Scheme installed successfully"

# Update font and package database
echo ""
echo "Updating TeX Live database..."
tlmgr path add
mktexlsr 2>/dev/null || true
echo "✓ TeX Live configuration updated"
