#!/bin/bash
set -e

# Stop and remove Overleaf containers directly
docker stop sharelatex redis mongo 2>/dev/null || true
docker rm sharelatex redis mongo 2>/dev/null || true

echo "Overleaf containers stopped and removed"
