#!/bin/bash
# Nginx customizations for Overleaf
# This script runs AFTER nginx is configured (via /etc/my_init.d/)

NGINX_CONF="/etc/nginx/sites-enabled/sharelatex.conf"

if [ -f "$NGINX_CONF" ]; then
    if grep -q "OVERLEAF_LAB_NGINX_PATCH" "$NGINX_CONF"; then
        echo "Nginx customizations: already applied"
    else
        echo "Applying nginx customizations (hide signup + fix logout redirect)..."

        # Single sub_filter with both CSS and JavaScript
        sed -i '/location \/ {/a\
        # OVERLEAF_LAB_NGINX_PATCH: Hide signup + fix /undefined logout redirect\
        sub_filter "</head>" "<style>a[href=\\"/register\\"]{display:none!important;}</style><script>if(window.location.pathname===\"/undefined\"||window.location.href.includes(\"/undefined?\"))window.location.replace(\"/\");</script></head>";\
        sub_filter_once on;\
        sub_filter_types text/html;' "$NGINX_CONF"

        nginx -s reload 2>/dev/null || true

        echo "Nginx customizations: applied successfully"
    fi
else
    echo "Nginx customizations: nginx config not found, skipping"
fi
