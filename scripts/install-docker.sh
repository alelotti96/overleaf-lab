#!/bin/bash

#===============================================================================
# DOCKER INSTALLATION SCRIPT
#===============================================================================
# Installs Docker Engine on Ubuntu/Debian systems
#===============================================================================

set -e

echo "Installing Docker on Ubuntu/Debian..."
echo ""

# Check if running on Ubuntu or Debian
if [ ! -f /etc/os-release ]; then
    echo "Error: Cannot determine OS. This script is for Ubuntu/Debian only."
    exit 1
fi

source /etc/os-release
if [[ "$ID" != "ubuntu" && "$ID" != "debian" ]]; then
    echo "Error: This script supports Ubuntu and Debian only."
    echo "For other distributions, please install Docker manually:"
    echo "https://docs.docker.com/engine/install/"
    exit 1
fi

echo "Detected: $PRETTY_NAME"
echo ""

# Update package index
echo "Updating package index..."
sudo apt-get update

# Install prerequisites
echo "Installing prerequisites..."
sudo apt-get install -y \
    ca-certificates \
    curl \
    gnupg \
    lsb-release

# Add Docker's official GPG key
echo "Adding Docker's GPG key..."
sudo mkdir -p /etc/apt/keyrings
# Remove existing key if present to avoid gpg error
sudo rm -f /etc/apt/keyrings/docker.gpg
curl -fsSL https://download.docker.com/linux/$ID/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg

# Set up repository
echo "Setting up Docker repository..."
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$ID \
  $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker Engine
echo "Installing Docker Engine..."
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Start Docker service
echo "Starting Docker service..."
sudo systemctl start docker
sudo systemctl enable docker

# Add current user to docker group
echo "Adding user $USER to docker group..."
sudo usermod -aG docker $USER

echo ""
echo "==============================================================================="
echo "Docker installed successfully!"
echo "==============================================================================="
echo ""
