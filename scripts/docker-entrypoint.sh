#!/bin/bash
# Custom entrypoint wrapper for Overleaf
# Enables features before starting services

# Run features script if it exists
if [ -f /overleaf-lab/enable-features.sh ]; then
    bash /overleaf-lab/enable-features.sh
fi

# Execute the original entrypoint
exec /sbin/my_init "$@"
