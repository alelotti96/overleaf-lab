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
        echo "Applying nginx customizations (hide signup + fix logout redirect + header/footer color)..."

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
            CUSTOM_CSS="${CUSTOM_CSS}nav.navbar-main,nav.website-redesign-navbar,.navbar-container{background-color:${HEADER_BG_COLOR}!important;}.navbar-container a,.navbar-container .navbar-title,.navbar-container .navbar-brand,.navbar-container .nav-link,.navbar-container .dropdown-toggle{color:${HEADER_TEXT_COLOR}!important;}.navbar-container .dropdown-menu{--bs-dropdown-bg:${HEADER_BG_COLOR};--bs-dropdown-color:${HEADER_TEXT_COLOR};--bs-dropdown-link-color:${HEADER_TEXT_COLOR};--bs-dropdown-link-hover-color:${HEADER_TEXT_COLOR};--bs-dropdown-link-hover-bg:rgba(255,255,255,0.12);--bs-dropdown-link-active-color:${HEADER_TEXT_COLOR};--bs-dropdown-link-active-bg:rgba(255,255,255,0.2);--bs-dropdown-border-color:rgba(255,255,255,0.15);background-color:${HEADER_BG_COLOR}!important;border:1px solid rgba(255,255,255,0.15)!important;}.navbar-container .dropdown-menu .dropdown-item{color:${HEADER_TEXT_COLOR}!important;background-color:transparent!important;}.navbar-container .dropdown-menu .dropdown-item:hover,.navbar-container .dropdown-menu .dropdown-item:focus,.navbar-container .dropdown-menu .dropdown-item:active,.navbar-container .dropdown-menu .dropdown-item.active{background-color:rgba(255,255,255,0.12)!important;color:${HEADER_TEXT_COLOR}!important;}.navbar-container a:hover,.navbar-container a:focus,.navbar-container .nav-link:hover,.navbar-container .nav-link:focus,.navbar-container .dropdown-toggle:hover,.navbar-container .dropdown-toggle:focus,.navbar-container .dropdown-toggle.show,.navbar-container .dropdown-toggle[aria-expanded=true],.navbar-container .btn:hover,.navbar-container .btn:focus{background-color:transparent!important;color:${HEADER_TEXT_COLOR}!important;box-shadow:none!important;}"
            # 3) Same treatment for the footer, which has no dark-theme styling and
            #    stays a white strip with grey text under the dark dashboard. We
            #    cannot make this conditional on the theme: layout-base.pug hardcodes
            #    data-theme="light" on <body> even on the dark pages, so there is no
            #    DOM marker to scope a dark-only rule on. Applying the header colours
            #    unconditionally sidesteps that and gives a matching dark band top and
            #    bottom in either theme. Both footer roots are covered (site-footer is
            #    the thin footer used on app pages, fat-footer the marketing one) and
            #    the descendants are reset wholesale, since the inner markup differs
            #    between the pug and the React variants of each.
            CUSTOM_CSS="${CUSTOM_CSS}footer.site-footer,footer.fat-footer{background-color:${HEADER_BG_COLOR}!important;border-top:1px solid rgba(255,255,255,0.1)!important;}footer.site-footer *,footer.fat-footer *{background-color:transparent!important;color:${HEADER_TEXT_COLOR}!important;}footer.site-footer .text-muted,footer.fat-footer .text-muted{opacity:0.75;}footer.site-footer a:hover,footer.site-footer a:focus,footer.fat-footer a:hover,footer.fat-footer a:focus{text-decoration:underline;}"
            echo "  Header/footer color: ${HEADER_BG_COLOR} (text ${HEADER_TEXT_COLOR})"
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
