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

            # Find and replace the issuer validation line AND error message in one operation
            # Original: if (claims.iss !== self._issuer) { return self.fail({ message: 'ID token not issued by expected OpenID provider.' }, 403);
            # New: Check if issuer is in our allowed list with custom error message
            sed -i "s|if (claims.iss !== self._issuer) { return self.fail({ message: 'ID token not issued by expected OpenID provider.' }, 403);|// MULTI_ISSUER_PATCH: Allow multiple Azure tenant issuers\\n  var allowedIssuers = [${ISSUERS_JS}];\\n  if (claims.iss !== self._issuer \&\& !allowedIssuers.includes(claims.iss)) { return self.fail({ message: 'Your account is not authorized to access this Overleaf instance. Please contact your lab administrator if you believe this is an error.' }, 403);|" "$STRATEGY_FILE"

            echo "OIDC multi-issuer patch: applied successfully for tenant IDs: $OIDC_ADDITIONAL_TENANT_IDS"
        else
            echo "OIDC multi-issuer patch: skipped (no additional tenant IDs configured)"
        fi
    fi
else
    echo "OIDC multi-issuer patch: passport-openidconnect not found, skipping"
fi

# =============================================================================
# OIDC Group-Based Access Control
# =============================================================================
# Patches passport-openidconnect to verify Azure AD group membership

if [ -f "$STRATEGY_FILE" ]; then
    if [ "$OIDC_GROUP_FILTERING_ENABLED" = "true" ] && [ -n "$OIDC_ALLOWED_GROUPS" ]; then
        # Check if already patched
        if grep -q "GROUP_FILTERING_PATCH" "$STRATEGY_FILE"; then
            echo "OIDC group filtering patch: already applied"
        else
            echo "Applying OIDC group filtering patch..."

            # Convert comma-separated group IDs to JavaScript array
            GROUP_IDS=$(echo "$OIDC_ALLOWED_GROUPS" | tr ',' '\n')
            GROUPS_JS=""
            for GROUP_ID in $GROUP_IDS; do
                GROUP_ID=$(echo "$GROUP_ID" | xargs)  # Trim whitespace
                if [ -n "$GROUP_ID" ]; then
                    if [ -n "$GROUPS_JS" ]; then
                        GROUPS_JS="$GROUPS_JS, "
                    fi
                    GROUPS_JS="${GROUPS_JS}\\\"${GROUP_ID}\\\""
                fi
            done

            # Insert group verification after issuer check
            # This checks if user is member of at least one allowed group
            sed -i "/GROUP_FILTERING_PATCH/! s|var profile = {|// GROUP_FILTERING_PATCH: Verify user is in allowed groups\\n      var allowedGroups = [${GROUPS_JS}];\\n      if (claims.groups \&\& Array.isArray(claims.groups)) {\\n        var userInAllowedGroup = claims.groups.some(function(g) { return allowedGroups.includes(g); });\\n        if (!userInAllowedGroup) {\\n          return self.fail({ message: 'Your account is not authorized to access this Overleaf instance (not in allowed group). Please contact your lab administrator.' }, 403);\\n        }\\n      } else {\\n        return self.fail({ message: 'Your account does not have group information. Please contact your administrator to configure Azure AD groups claim.' }, 403);\\n      }\\n      var profile = {|" "$STRATEGY_FILE"

            echo "OIDC group filtering patch: applied successfully for group IDs: $OIDC_ALLOWED_GROUPS"
            echo ""
            echo "IMPORTANT: Configure Azure AD to include groups claim:"
            echo "  1. App Registration → Token configuration → + Add groups claim"
            echo "  2. Select 'Security groups'"
            echo "  3. Save"
        fi
    else
        echo "OIDC group filtering: disabled or no groups configured"
    fi
else
    echo "OIDC group filtering patch: passport-openidconnect not found, skipping"
fi

# =============================================================================
# Nginx customizations are handled by nginx-customizations.sh
# which is copied to /etc/my_init.d/ to run after nginx is configured
# =============================================================================
