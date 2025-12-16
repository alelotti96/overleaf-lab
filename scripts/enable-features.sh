#!/bin/bash
# Enable Overleaf features by modifying settings.js
# This script is executed inside the container on startup

SETTINGS_FILE="/etc/overleaf/settings.js"

# Check if splitTestOverrides already exists
if grep -q "splitTestOverrides" "$SETTINGS_FILE"; then
    echo "splitTestOverrides already configured"
else

# Determine which features to enable
if [ "$ENABLE_NEW_EDITOR_UI" = "true" ]; then
    echo "New editor UI: enabled"
    # With new editor UI
    sed -i '/^module.exports = settings$/i\
\
// Enable Overleaf features\
// Added by overleaf-lab\
settings.splitTestOverrides = {\
  "history-ranges-support": "enabled",\
  "revert-file": "enabled",\
  "revert-project": "enabled",\
  "editor-redesign": "enabled",\
}\
' "$SETTINGS_FILE"
else
    echo "New editor UI: disabled"
    # Without new editor UI
    sed -i '/^module.exports = settings$/i\
\
// Enable Overleaf features\
// Added by overleaf-lab\
settings.splitTestOverrides = {\
  "history-ranges-support": "enabled",\
  "revert-file": "enabled",\
  "revert-project": "enabled",\
}\
' "$SETTINGS_FILE"
fi

echo "Overleaf features configured"
fi

# =============================================================================
# OIDC Multi-Issuer Patch for Azure AD Multi-Tenant
# =============================================================================
# Patches passport-openidconnect to accept multiple Azure tenant issuers

STRATEGY_FILE="/overleaf/node_modules/passport-openidconnect/lib/strategy.js"

if [ -f "$STRATEGY_FILE" ]; then
    # Check if already patched
    if grep -q "MULTI_ISSUER_PATCH" "$STRATEGY_FILE"; then
        echo "OIDC multi-issuer patch: already applied"
    else
        echo "Applying OIDC multi-issuer patch..."

        # Build allowed issuers array from environment variable
        # OIDC_ADDITIONAL_TENANT_IDS should be comma-separated tenant IDs
        if [ -n "$OIDC_ADDITIONAL_TENANT_IDS" ]; then
            # Convert comma-separated tenant IDs to JavaScript array of issuer URLs
            TENANT_IDS=$(echo "$OIDC_ADDITIONAL_TENANT_IDS" | tr ',' '\n')
            ISSUERS_JS=""
            for TENANT_ID in $TENANT_IDS; do
                TENANT_ID=$(echo "$TENANT_ID" | xargs)  # Trim whitespace
                if [ -n "$TENANT_ID" ]; then
                    if [ -n "$ISSUERS_JS" ]; then
                        ISSUERS_JS="$ISSUERS_JS, "
                    fi
                    ISSUERS_JS="${ISSUERS_JS}\\\"https://login.microsoftonline.com/${TENANT_ID}/v2.0\\\""
                fi
            done

            # Create backup
            cp "$STRATEGY_FILE" "${STRATEGY_FILE}.bak"

            # Find and replace the issuer validation line
            # Original: if (claims.iss !== self._issuer) {
            # New: Check if issuer is in our allowed list
            sed -i "s|if (claims.iss !== self._issuer) {|// MULTI_ISSUER_PATCH: Allow multiple Azure tenant issuers\\n  var allowedIssuers = [${ISSUERS_JS}];\\n  if (claims.iss !== self._issuer \&\& !allowedIssuers.includes(claims.iss)) {|" "$STRATEGY_FILE"

            echo "OIDC multi-issuer patch: applied successfully for tenant IDs: $OIDC_ADDITIONAL_TENANT_IDS"
        else
            echo "OIDC multi-issuer patch: skipped (no additional tenant IDs configured)"
        fi
    fi
else
    echo "OIDC multi-issuer patch: passport-openidconnect not found, skipping"
fi

# =============================================================================
# Hide Signup Link (keep login enabled)
# =============================================================================
# Injects custom CSS to hide signup/register links from the header

if grep -q "HIDE_SIGNUP_CSS" "$SETTINGS_FILE"; then
    echo "Hide signup CSS: already applied"
else
    echo "Applying hide signup CSS..."

    # Inject custom CSS into settings.js to hide signup links
    # This targets common signup link patterns while keeping login functional
    sed -i '/^module.exports = settings$/i\
\
// HIDE_SIGNUP_CSS: Hide signup links from header\
settings.customCss = `\
  /* Hide register/signup links */\
  a[href*="/register"],\
  a[href*="/sign-up"],\
  a[href*="register"],\
  .nav-register,\
  .signup-link {\
    display: none !important;\
  }\
`\
' "$SETTINGS_FILE"

    echo "Hide signup CSS: applied successfully"
fi

# =============================================================================
# Fix OIDC Logout Undefined Redirect
# =============================================================================
# Prevents /undefined error on logout by redirecting to home instead

if grep -q "OIDC_LOGOUT_FIX" "$SETTINGS_FILE"; then
    echo "OIDC logout fix: already applied"
else
    echo "Applying OIDC logout fix..."

    # Inject JavaScript to fix logout redirect
    sed -i '/^module.exports = settings$/i\
\
// OIDC_LOGOUT_FIX: Fix undefined logout redirect\
settings.customHeadContent = (settings.customHeadContent || "") + `\
  <script>\
    // Fix OIDC logout redirect from /undefined to home\
    (function() {\
      if (window.location.pathname === "/undefined") {\
        window.location.replace("/");\
      }\
    })();\
  </script>\
`\
' "$SETTINGS_FILE"

    echo "OIDC logout fix: applied successfully"
fi

# =============================================================================
# Enhanced Hide Signup (JavaScript fallback)
# =============================================================================
# Aggressively hides signup links using JavaScript

if grep -q "SIGNUP_JS_HIDE" "$SETTINGS_FILE"; then
    echo "Signup JavaScript hide: already applied"
else
    echo "Applying signup JavaScript hide..."

    # Separate script tag for signup hiding
    sed -i '/^module.exports = settings$/i\
\
// SIGNUP_JS_HIDE: Aggressive signup link hiding\
settings.customHeadContent = (settings.customHeadContent || "") + `\
  <script>\
    window.addEventListener("load", function() {\
      function hideSignup() {\
        document.querySelectorAll("a, button, [role=button]").forEach(function(el) {\
          var text = el.textContent.toLowerCase().trim();\
          var href = el.getAttribute("href") || "";\
          if (text === "sign up" || text === "signup" || \
              text === "register" || href.includes("/register")) {\
            el.style.display = "none";\
            el.style.visibility = "hidden";\
            el.style.opacity = "0";\
            el.remove();\
          }\
        });\
      }\
      hideSignup();\
      setTimeout(hideSignup, 500);\
      setTimeout(hideSignup, 2000);\
    });\
  </script>\
`\
' "$SETTINGS_FILE"

    echo "Signup JavaScript hide: applied successfully"
fi
