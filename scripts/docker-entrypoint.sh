#!/bin/bash
# Custom entrypoint wrapper for Overleaf
# Enables restore feature before starting services

# Run restore feature script if it exists
if [ -f /restore-script/enable-restore-feature.sh ]; then
    bash /restore-script/enable-restore-feature.sh
fi

# Execute the original entrypoint
exec /sbin/my_init "$@"
