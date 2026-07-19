#!/bin/bash
# Nginx customizations for Overleaf
# This script runs AFTER nginx is configured (via /etc/my_init.d/)
#
# Reads HEADER_BG_COLOR / HEADER_TEXT_COLOR from the container environment
# (set in overleaf-toolkit/config/variables.env, the sharelatex env_file).

NGINX_CONF="/etc/nginx/sites-enabled/overleaf.conf"

if [ -f "$NGINX_CONF" ]; then
    if grep -q "OVERLEAF_LAB_NGINX_PATCH" "$NGINX_CONF"; then
        echo "Nginx customizations: already applied"
    else
        echo "Applying nginx customizations (hide signup + fix logout redirect + header color)..."

        # -------------------------------------------------------------------
        # Build the CSS injected into every page's <head>
        # -------------------------------------------------------------------
        # 1) Hide the register/signup button.
        #    \\" becomes \" in the config file, so nginx emits a literal " .
        CUSTOM_CSS='a[href=\\"/register\\"]{display:none!important;}'

        # 2) Optionally restore a dark dashboard header (Overleaf 6.2 ships a
        #    white one and offers no env var for the navbar color).
        if [ -n "$HEADER_BG_COLOR" ]; then
            HEADER_TEXT_COLOR="${HEADER_TEXT_COLOR:-#ffffff}"
            CUSTOM_CSS="${CUSTOM_CSS}nav.navbar-main,nav.website-redesign-navbar{background-color:${HEADER_BG_COLOR}!important;}nav.navbar-main a,nav.navbar-main .navbar-title,nav.navbar-main .navbar-brand,nav.navbar-main .nav-link{color:${HEADER_TEXT_COLOR}!important;}"
            echo "  Header color: ${HEADER_BG_COLOR} (text ${HEADER_TEXT_COLOR})"
        fi

        # Add sub_filter to inject the CSS and increase proxy buffers for OIDC.
        # The single-quoted sed is broken to splice in "${CUSTOM_CSS}".
        sed -i '/location \/ {/a\
        # OVERLEAF_LAB_NGINX_PATCH\
        sub_filter "</head>" "<style>'"${CUSTOM_CSS}"'</style></head>";\
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
