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
# OIDC Group-Based Access Control with Email Whitelist
# =============================================================================
# Patches passport-openidconnect to verify Azure AD group membership
# Users in whitelist bypass group check (useful for users with 150+ groups)
# Whitelist is read at runtime - changes take effect immediately without restart

WHITELIST_FILE="/overleaf-lab/whitelisted_emails.txt"

if [ -f "$STRATEGY_FILE" ]; then
    if [ "$OIDC_GROUP_FILTERING_ENABLED" = "true" ] && [ -n "$OIDC_ALLOWED_GROUPS" ]; then
        if grep -q "GROUP_FILTER_PATCH" "$STRATEGY_FILE"; then
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

            # Add fs require at the top of the file if not present
            if ! grep -q "var groupFilterFs = require('fs');" "$STRATEGY_FILE"; then
                sed -i "1s/^/var groupFilterFs = require('fs');\\n/" "$STRATEGY_FILE"
            fi

            # Insert group verification that reads whitelist at runtime
            sed -i "/GROUP_FILTER_PATCH/! s|var profile = {|// GROUP_FILTER_PATCH: Verify user is in allowed groups or whitelist\\n      var allowedGroups = [${GROUPS_JS}];\\n      var userEmail = claims.email ? claims.email.toLowerCase() : '';\\n      // Read whitelist at runtime (changes take effect immediately)\\n      var whitelistedEmails = [];\\n      try {\\n        var whitelistContent = groupFilterFs.readFileSync('/overleaf-lab/whitelisted_emails.txt', 'utf8');\\n        whitelistedEmails = whitelistContent.split('\\\\n').map(function(e) { return e.trim().toLowerCase(); }).filter(function(e) { return e \\&\\& !e.startsWith('#'); });\\n      } catch (e) { /* whitelist file not found, continue without it */ }\\n      var isWhitelisted = whitelistedEmails.includes(userEmail);\\n      if (isWhitelisted) {\\n        console.log('[Group Filter] User whitelisted: ' + userEmail);\\n      } else if (claims.groups \\&\\& Array.isArray(claims.groups)) {\\n        var userInAllowedGroup = claims.groups.some(function(g) { return allowedGroups.includes(g); });\\n        if (!userInAllowedGroup) {\\n          console.log('[Group Filter] User not in allowed group: ' + userEmail);\\n          return self.fail({ message: 'Your account is not authorized to access this Overleaf instance (not in allowed group). Please contact your lab administrator.' }, 403);\\n        }\\n      } else {\\n        console.log('[Group Filter] No groups in token for: ' + userEmail);\\n        return self.fail({ message: 'Your account does not have group information. Please contact your administrator to configure Azure AD groups claim or request whitelist access.' }, 403);\\n      }\\n      var profile = {|" "$STRATEGY_FILE"

            echo "OIDC group filtering patch: applied successfully"
            echo "  Allowed groups: $OIDC_ALLOWED_GROUPS"
            echo "  Whitelist file: $WHITELIST_FILE (read at runtime)"
        fi
    else
        echo "OIDC group filtering: disabled or no groups configured"
    fi
else
    echo "OIDC group filtering patch: passport-openidconnect not found, skipping"
fi

# =============================================================================
# Super Admin Role Patch
# =============================================================================
# Patches AdminToolsRouter.mjs and router.mjs to restrict sensitive admin
# routes (/admin, /admin/project/*) to users with super_admin role.
# Normal admins can still access /admin/user (Manage Users).
#
# Also sets adminRoles: ["super_admin"] for the SUPER_ADMIN_EMAIL user in MongoDB.
# Falls back to OVERLEAF_ADMIN_EMAIL (= ADMIN_EMAIL from config.env) if SUPER_ADMIN_EMAIL is not set.

ADMIN_TOOLS_ROUTER="/overleaf/services/web/modules/admin-tools/app/src/AdminToolsRouter.mjs"
MAIN_ROUTER="/overleaf/services/web/app/src/router.mjs"
PATCH_SCRIPT="/overleaf-lab/patch-super-admin.js"

# Fallback: use OVERLEAF_ADMIN_EMAIL if SUPER_ADMIN_EMAIL is not explicitly set
SUPER_ADMIN_EMAIL="${SUPER_ADMIN_EMAIL:-$OVERLEAF_ADMIN_EMAIL}"

if [ -f "$PATCH_SCRIPT" ]; then
    # Always run the patch script - it handles re-patching from backup internally
    echo "Applying super admin route patches..."
    cd /overleaf/services/web && node "$PATCH_SCRIPT"
    echo "Super admin route patches: done"

    # Set adminRoles for the super_admin user in MongoDB
    if [ -n "$SUPER_ADMIN_EMAIL" ]; then
        echo "Setting super_admin role for: $SUPER_ADMIN_EMAIL"
        node -e "
const { MongoClient } = require('mongodb');
async function main() {
  const client = new MongoClient(process.env.MONGO_CONNECTION_STRING || 'mongodb://mongo:27017');
  try {
    await client.connect();
    const db = client.db('sharelatex');
    const result = await db.collection('users').updateOne(
      { email: '$SUPER_ADMIN_EMAIL' },
      { \$set: { adminRoles: ['super_admin'] } }
    );
    if (result.matchedCount > 0) {
      console.log('[Super Admin] adminRoles set for $SUPER_ADMIN_EMAIL');
    } else {
      console.log('[Super Admin] User $SUPER_ADMIN_EMAIL not found in DB (will be set when user exists)');
    }
  } finally {
    await client.close();
  }
}
main().catch(err => console.error('[Super Admin] MongoDB error:', err));
" 2>&1 || echo "Super admin MongoDB setup: failed (non-critical, can be set via dashboard)"
    else
        echo "Super admin: SUPER_ADMIN_EMAIL not set, skipping MongoDB role setup"
    fi
else
    echo "Super admin patch: patch-super-admin.js not found, skipping"
fi

# =============================================================================
# Nginx customizations are handled by nginx-customizations.sh
# which is copied to /etc/my_init.d/ to run after nginx is configured
# =============================================================================
