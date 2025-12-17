#!/bin/bash
# Custom entrypoint wrapper for Overleaf
# Enables features before and after service initialization

# Run main features script (OIDC patches, settings)
if [ -f /overleaf-lab/enable-features.sh ]; then
    bash /overleaf-lab/enable-features.sh
fi

# Copy nginx customizations to run AFTER nginx is configured
if [ -f /overleaf-lab/nginx-customizations.sh ] && [ ! -f /etc/my_init.d/999_nginx_customizations.sh ]; then
    cp /overleaf-lab/nginx-customizations.sh /etc/my_init.d/999_nginx_customizations.sh
    chmod +x /etc/my_init.d/999_nginx_customizations.sh
    echo "Nginx customizations script installed to /etc/my_init.d/"
fi

# Execute the original entrypoint
exec /sbin/my_init "$@"
