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
            # Dark navbar. We scope on .navbar-container (the div that wraps the
            # whole navbar in the 6.2 redesign) rather than the outer <nav> class,
            # because the nav element's class varies (navbar-main vs
            # website-redesign-navbar) while .navbar-container is the stable, always
            # present wrapper (confirmed in the live DOM). Top-level links/toggle go
            # white; the dropdown panel gets the header colour and its items the text
            # colour with a subtle hover, so submenu items are always readable
            # regardless of Overleaf's default (no dark-on-dark, no white-on-white).
            CUSTOM_CSS="${CUSTOM_CSS}nav.navbar-main,nav.website-redesign-navbar,.navbar-container{background-color:${HEADER_BG_COLOR}!important;}.navbar-container a,.navbar-container .navbar-title,.navbar-container .navbar-brand,.navbar-container .nav-link,.navbar-container .dropdown-toggle{color:${HEADER_TEXT_COLOR}!important;}.navbar-container .dropdown-menu{background-color:${HEADER_BG_COLOR}!important;border:1px solid rgba(255,255,255,0.15)!important;}.navbar-container .dropdown-menu .dropdown-item{color:${HEADER_TEXT_COLOR}!important;background-color:transparent!important;}.navbar-container .dropdown-menu .dropdown-item:hover,.navbar-container .dropdown-menu .dropdown-item:focus{background-color:rgba(255,255,255,0.12)!important;color:${HEADER_TEXT_COLOR}!important;}"
            echo "  Header color: ${HEADER_BG_COLOR} (text ${HEADER_TEXT_COLOR})"
        fi

        # Add sub_filter to inject the CSS and increase proxy buffers for OIDC.
        # The single-quoted sed is broken to splice in "${CUSTOM_CSS}".
        #
        # NOTE: we deliberately do NOT set proxy_read_timeout / proxy_send_timeout
        # here. The CEP nginx template already defines them (10m = 600s) inside this
        # same `location / {` block, which (a) already exceeds the non-streaming LLM
        # chat's 300s server-side timeout, so no override is needed, and (b) makes any
        # addition a DUPLICATE directive - nginx aborts at boot with "[emerg] ...
        # directive is duplicate" and never listens (the container stays Up, so the
        # failure is only visible in the logs). See the LLM module notes.
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
