#!/bin/bash
# Enable Overleaf features by modifying settings.js
# This script is executed inside the container on startup

SETTINGS_FILE="/etc/overleaf/settings.js"

# Check if splitTestOverrides already exists
if grep -q "splitTestOverrides" "$SETTINGS_FILE"; then
    echo "splitTestOverrides already configured"
    exit 0
fi

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

# =============================================================================
# OIDC Multi-Issuer Patch for Azure AD Multi-Tenant
# =============================================================================
# Patches passport-openidconnect to accept multiple Azure tenant issuers

STRATEGY_FILE="/overleaf/services/web/node_modules/passport-openidconnect/lib/strategy.js"

if [ -f "$STRATEGY_FILE" ]; then
    # Check if already patched
    if grep -q "MULTI_ISSUER_PATCH" "$STRATEGY_FILE"; then
        echo "OIDC multi-issuer patch: already applied"
    else
        echo "Applying OIDC multi-issuer patch..."

        # Valid Azure tenant issuers (hardcoded for University of Bologna)
        # unibo.it tenant: 5daeca35-64fd-43e7-b049-679b8fb3a805
        # studio.unibo.it tenant: e99647dc-1b08-454a-bf8c-699181b389ab
        ISSUER1="https://login.microsoftonline.com/5daeca35-64fd-43e7-b049-679b8fb3a805/v2.0"
        ISSUER2="https://login.microsoftonline.com/e99647dc-1b08-454a-bf8c-699181b389ab/v2.0"

        # Create backup
        cp "$STRATEGY_FILE" "${STRATEGY_FILE}.bak"

        # Find and replace the issuer validation line
        # Original: if (claims.iss !== self._issuer) {
        # New: Check if issuer is in our allowed list
        sed -i "s|if (claims.iss !== self._issuer) {|// MULTI_ISSUER_PATCH: Allow multiple Azure tenant issuers\n  var allowedIssuers = ['${ISSUER1}', '${ISSUER2}'];\n  if (claims.iss !== self._issuer \&\& !allowedIssuers.includes(claims.iss)) {|" "$STRATEGY_FILE"

        echo "OIDC multi-issuer patch: applied successfully"
    fi
else
    echo "OIDC multi-issuer patch: passport-openidconnect not found, skipping"
fi
