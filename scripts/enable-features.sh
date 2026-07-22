#!/bin/bash
# Enable Overleaf features - executed inside the container on startup
#
# Note: since CEP 6.2.0-ext-v5.0 the features previously enabled here via
# settings.js splitTestOverrides are native env vars set in variables.env:
#   - history restore  -> OVERLEAF_HISTORY_RESTORE=true
#   - editor redesign  -> always on upstream (no longer optional)
#   - pandoc import/export -> ENABLE_PANDOC_CONVERSIONS=true + PANDOC_IMAGE
# No settings.js patching is needed anymore.

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
# Also patches AuthorizationManager.mjs so that only super_admins can open
# other users' projects by URL (the CEP image ships ADMIN_PRIVILEGE_AVAILABLE=true,
# which would otherwise give every isAdmin user OWNER access to any project).
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

    # Set adminRoles: ['super_admin'] for the SUPER_ADMIN_EMAIL user, in two layers:
    #  1) a SYNCHRONOUS attempt now - reliably promotes the user if it already exists
    #     (e.g. on any container restart after the launchpad user was created). This is
    #     the dependable path and always runs at startup.
    #  2) a best-effort BACKGROUND watcher (setsid-detached so it survives the entrypoint
    #     handing off to my_init) that promotes the user if it is created LATER, right
    #     after a fresh install, without a restart. If it does not survive, layer 1 on
    #     the next restart still promotes reliably. Both are idempotent.
    if [ -n "$SUPER_ADMIN_EMAIL" ]; then
        echo "Setting super_admin role for: $SUPER_ADMIN_EMAIL"
        node -e "
const { MongoClient } = require('mongodb');
(async () => {
  const client = new MongoClient(process.env.MONGO_CONNECTION_STRING || 'mongodb://mongo:27017');
  try {
    await client.connect();
    const r = await client.db('sharelatex').collection('users').updateOne(
      { email: '$SUPER_ADMIN_EMAIL' },
      { \$set: { adminRoles: ['super_admin'] } }
    );
    console.log(r.matchedCount > 0
      ? '[Super Admin] adminRoles set for $SUPER_ADMIN_EMAIL'
      : '[Super Admin] $SUPER_ADMIN_EMAIL not created yet; promoted on next restart or by the watcher');
  } finally { await client.close(); }
})().catch(e => console.error('[Super Admin] MongoDB error:', e.message));
" 2>&1 || echo "Super admin sync setup failed (non-critical; can be set via the dashboard)"
        setsid node -e "
const { MongoClient } = require('mongodb');
const EMAIL = '$SUPER_ADMIN_EMAIL';
const DEADLINE = Date.now() + 15 * 60 * 1000;
async function once() {
  const client = new MongoClient(process.env.MONGO_CONNECTION_STRING || 'mongodb://mongo:27017');
  try { await client.connect();
    const r = await client.db('sharelatex').collection('users').updateOne({ email: EMAIL }, { \$set: { adminRoles: ['super_admin'] } });
    return r.matchedCount > 0;
  } finally { await client.close(); }
}
(async () => { for (;;) { let ok = false; try { ok = await once(); } catch (e) {} if (ok) { console.log('[Super Admin] watcher promoted ' + EMAIL); process.exit(0); } if (Date.now() > DEADLINE) process.exit(0); await new Promise(r => setTimeout(r, 15000)); } })();
" </dev/null >/proc/1/fd/1 2>&1 &
        echo "  super_admin: synchronous attempt done, background watcher started"
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
