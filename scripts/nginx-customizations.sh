#!/bin/bash
# Nginx customizations for Overleaf
# This script runs AFTER nginx is configured (via /etc/my_init.d/)

NGINX_CONF="/etc/nginx/sites-enabled/overleaf.conf"

if [ -f "$NGINX_CONF" ]; then
    if grep -q "OVERLEAF_LAB_NGINX_PATCH" "$NGINX_CONF"; then
        echo "Nginx customizations: already applied"
    else
        echo "Applying nginx customizations (hide signup + fix logout redirect)..."

        # Add sub_filter to hide signup button and increase proxy buffers for OIDC
        sed -i '/location \/ {/a\
        # OVERLEAF_LAB_NGINX_PATCH\
        sub_filter "</head>" "<style>a[href=\\"/register\\"]{display:none!important;}</style></head>";\
        sub_filter_once on;\
        sub_filter_types text/html;\
        # OVERLEAF_LAB_NGINX_PATCH: Increase proxy buffers for large OIDC headers\
        proxy_buffer_size 128k;\
        proxy_buffers 4 256k;\
        proxy_busy_buffers_size 256k;' "$NGINX_CONF"

        # Add location blocks to fix OIDC undefined redirects
        sed -i '/location \/ {/i\
        # OVERLEAF_LAB_NGINX_PATCH: Fix /undefined logout redirect\
        location = /undefined {\
                return 302 /;\
        }\
\
        # OVERLEAF_LAB_NGINX_PATCH: Fix /oidc/login/undefined\
        location = /oidc/login/undefined {\
                return 302 /oidc/login$is_args$args;\
        }\
' "$NGINX_CONF"

        nginx -s reload 2>/dev/null || true

        echo "Nginx customizations: applied successfully"
    fi
else
    echo "Nginx customizations: nginx config not found, skipping"
fi
