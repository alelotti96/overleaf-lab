#!/bin/bash

# Update Overleaf CEP image without touching MongoDB, Redis, or other services

set -e

cd "$(dirname "$0")/.."

OVERRIDE_FILE="overleaf-toolkit/config/docker-compose.override.yml"

# Get current version
CURRENT_VERSION=$(grep -oP 'overleafcep/sharelatex:\K[^"]+' "$OVERRIDE_FILE" 2>/dev/null || echo "unknown")

echo "=================================="
echo "  Overleaf CEP Update Script"
echo "=================================="
echo ""
echo "Current version: $CURRENT_VERSION"
echo ""

# Check for available versions
echo "Checking available versions from Docker Hub..."
echo ""

# Try to get tags from Docker Hub API
TAGS=$(curl -s "https://hub.docker.com/v2/repositories/overleafcep/sharelatex/tags?page_size=10" 2>/dev/null | \
       grep -oP '"name":"[^"]+' | sed 's/"name":"//' | head -10)

if [ -n "$TAGS" ]; then
    echo "Recent available versions:"
    echo "$TAGS" | while read tag; do
        if [ "$tag" = "$CURRENT_VERSION" ]; then
            echo "  - $tag (current)"
        else
            echo "  - $tag"
        fi
    done
else
    echo "Could not fetch versions. Check manually at:"
    echo "https://hub.docker.com/r/overleafcep/sharelatex/tags"
fi

echo ""
echo "You can also check releases at:"
echo "https://github.com/yu-i-i/overleaf-cep/wiki"
echo ""

# Ask for new version
read -p "Enter new version (or press Enter to cancel): " NEW_VERSION

if [ -z "$NEW_VERSION" ]; then
    echo "Cancelled."
    exit 0
fi

if [ "$NEW_VERSION" = "$CURRENT_VERSION" ]; then
    echo "Already on version $NEW_VERSION. Nothing to do."
    exit 0
fi

echo ""
echo "Updating from $CURRENT_VERSION to $NEW_VERSION..."

# Backup current config
cp "$OVERRIDE_FILE" "${OVERRIDE_FILE}.backup.$(date +%Y%m%d_%H%M%S)"

# Update version in docker-compose.override.yml
sed -i "s|overleafcep/sharelatex:${CURRENT_VERSION}|overleafcep/sharelatex:${NEW_VERSION}|g" "$OVERRIDE_FILE"

echo "Configuration updated."
echo ""

# -----------------------------------------------------------------------------
# Migration steps (idempotent - safe to run on every update)
# -----------------------------------------------------------------------------
CONFIG_LOCAL="config.env.local"
VARIABLES_ENV="overleaf-toolkit/config/variables.env"
VERSION_FILE="overleaf-toolkit/config/version"

# Base upstream version is the part before "-ext-" (e.g. 6.2.0-ext-v5.0 -> 6.2.0)
BASE_CURRENT="${CURRENT_VERSION%%-*}"
BASE_NEW="${NEW_VERSION%%-*}"

if [ "$BASE_CURRENT" != "$BASE_NEW" ]; then
    echo "Base Overleaf version jump detected: ${BASE_CURRENT} -> ${BASE_NEW}"
    echo "Applying migration steps..."
    echo ""
fi

# 1) Keep the toolkit version file aligned with the upstream base version
#    (the git-bridge image tag follows overleaf-toolkit/config/version)
if [ -f "$VERSION_FILE" ]; then
    TOOLKIT_VERSION=$(tr -d '[:space:]' < "$VERSION_FILE")
    if [ "$TOOLKIT_VERSION" != "$BASE_NEW" ]; then
        cp "$VERSION_FILE" "${VERSION_FILE}.backup.$(date +%Y%m%d_%H%M%S)"
        echo "$BASE_NEW" > "$VERSION_FILE"
        echo "Toolkit version file updated: ${TOOLKIT_VERSION} -> ${BASE_NEW}"
    fi
fi

# 2) OVERLEAF_INVITE_TOKEN_SECRET is required since Overleaf CE 6.2.0
#    (the container refuses to start without it)
if ! grep -q '^OVERLEAF_INVITE_TOKEN_SECRET=' "$VARIABLES_ENV"; then
    INVITE_SECRET=""
    if [ -f "$CONFIG_LOCAL" ]; then
        INVITE_SECRET=$(grep '^OVERLEAF_INVITE_TOKEN_SECRET=' "$CONFIG_LOCAL" 2>/dev/null | cut -d'"' -f2)
    fi
    if [ -z "$INVITE_SECRET" ]; then
        INVITE_SECRET=$(python3 -c 'import secrets; print(secrets.token_hex(32))' 2>/dev/null || openssl rand -hex 32)
    fi
    {
        echo ""
        echo "# Invite token secret (required since Overleaf CE 6.2.0)"
        echo "OVERLEAF_INVITE_TOKEN_SECRET=${INVITE_SECRET}"
    } >> "$VARIABLES_ENV"
    echo "Added OVERLEAF_INVITE_TOKEN_SECRET to variables.env"
    # Persist in config.env.local so future configure.sh runs keep the same secret
    if [ -f "$CONFIG_LOCAL" ]; then
        if grep -q '^OVERLEAF_INVITE_TOKEN_SECRET=' "$CONFIG_LOCAL"; then
            sed -i "s|^OVERLEAF_INVITE_TOKEN_SECRET=.*|OVERLEAF_INVITE_TOKEN_SECRET=\"${INVITE_SECRET}\"|" "$CONFIG_LOCAL"
        else
            printf '\n# Invite token secret (required by Overleaf CE >= 6.2.0, auto-generated)\nOVERLEAF_INVITE_TOKEN_SECRET="%s"\n' "$INVITE_SECRET" >> "$CONFIG_LOCAL"
        fi
    fi
fi

# 3) Native history restore (replaces the old settings.js splitTestOverrides patch)
if ! grep -q '^OVERLEAF_HISTORY_RESTORE=' "$VARIABLES_ENV"; then
    {
        echo ""
        echo "# Project history restore features (native env var since CEP ext-v5.0)"
        echo "OVERLEAF_HISTORY_RESTORE=true"
    } >> "$VARIABLES_ENV"
    echo "Enabled OVERLEAF_HISTORY_RESTORE"
fi

# 4) Pandoc conversions: import Word/Markdown, export docx/Markdown/HTML
PANDOC_IMAGE_VAL=""
if [ -f "$CONFIG_LOCAL" ]; then
    PANDOC_IMAGE_VAL=$(grep '^PANDOC_IMAGE=' "$CONFIG_LOCAL" 2>/dev/null | cut -d'"' -f2)
fi
PANDOC_IMAGE_VAL="${PANDOC_IMAGE_VAL:-overleafcep/pandoc-ol:3.10.0.0}"

if ! grep -q '^ENABLE_PANDOC_CONVERSIONS=' "$VARIABLES_ENV"; then
    {
        echo ""
        echo "# Pandoc conversions: import Word/Markdown documents, export docx/Markdown/HTML"
        echo "ENABLE_PANDOC_CONVERSIONS=true"
        echo "PANDOC_IMAGE=${PANDOC_IMAGE_VAL}"
    } >> "$VARIABLES_ENV"
    echo "Enabled Pandoc conversions (image: ${PANDOC_IMAGE_VAL})"
fi
if [ -f "$CONFIG_LOCAL" ] && ! grep -q '^ENABLE_PANDOC_CONVERSIONS=' "$CONFIG_LOCAL"; then
    printf '\n# Pandoc conversions (Word/Markdown import-export)\nENABLE_PANDOC_CONVERSIONS="true"\nPANDOC_IMAGE="%s"\n' "$PANDOC_IMAGE_VAL" >> "$CONFIG_LOCAL"
fi

# 5) MAX_UPLOAD_SIZE is interpreted in MB since Overleaf CE 6.2.0
#    (nginx uses "client_max_body_size ${MAX_UPLOAD_SIZE}m").
#    Convert legacy byte values (e.g. 524288000) to MB.
CUR_UPLOAD=$(grep '^MAX_UPLOAD_SIZE=' "$VARIABLES_ENV" 2>/dev/null | head -1 | cut -d'=' -f2 | tr -d '[:space:]')
if [ -n "$CUR_UPLOAD" ] && [ "$CUR_UPLOAD" -gt 10240 ] 2>/dev/null; then
    NEW_UPLOAD=$((CUR_UPLOAD / 1024 / 1024))
    sed -i "s|^MAX_UPLOAD_SIZE=.*|MAX_UPLOAD_SIZE=${NEW_UPLOAD}|" "$VARIABLES_ENV"
    echo "Converted MAX_UPLOAD_SIZE from bytes to MB: ${CUR_UPLOAD} -> ${NEW_UPLOAD}"
fi

# 6) Public registration page (/register, new in CEP ext-v5.0).
#    When the env var is NOT set, CEP auto-enables the page if no external auth
#    (OIDC/LDAP/SAML) is configured - anyone could sign up. Ask explicitly.
if ! grep -q '^OVERLEAF_ENABLE_REGISTRATION_PAGE=' "$VARIABLES_ENV"; then
    REGISTRATION_VAL=""
    if [ -f "$CONFIG_LOCAL" ]; then
        REGISTRATION_VAL=$(grep '^ENABLE_OVERLEAF_PUBLIC_REGISTRATION=' "$CONFIG_LOCAL" 2>/dev/null | cut -d'"' -f2)
    fi
    if [ -z "$REGISTRATION_VAL" ]; then
        echo ""
        echo "CEP ext-v5.0 introduces a public registration page: anyone reaching"
        echo "your Overleaf URL can create an account at /register."
        echo "Answer 'n' to disable it (admins create/invite users manually)."
        read -p "Enable Overleaf public registration page? (y/N): " REGISTRATION_REPLY
        if [[ $REGISTRATION_REPLY =~ ^[Yy]$ ]]; then
            REGISTRATION_VAL="true"
        else
            REGISTRATION_VAL="false"
        fi
    fi
    {
        echo ""
        echo "# Public registration page (/register, native since CEP ext-v5.0)."
        echo "# Must be set explicitly: when unset, CEP auto-enables the page if no"
        echo "# external auth (OIDC/LDAP/SAML) is configured."
        echo "OVERLEAF_ENABLE_REGISTRATION_PAGE=${REGISTRATION_VAL}"
    } >> "$VARIABLES_ENV"
    echo "Set OVERLEAF_ENABLE_REGISTRATION_PAGE=${REGISTRATION_VAL}"
    # Persist in config.env.local so future configure.sh runs keep the same choice
    if [ -f "$CONFIG_LOCAL" ] && ! grep -q '^ENABLE_OVERLEAF_PUBLIC_REGISTRATION=' "$CONFIG_LOCAL"; then
        printf '\n# Overleaf public registration page (/register, native since CEP ext-v5.0)\nENABLE_OVERLEAF_PUBLIC_REGISTRATION="%s"\n' "$REGISTRATION_VAL" >> "$CONFIG_LOCAL"
    fi
fi

# 7) Link sharing: the previously written OVERLEAF_LINK_SHARING_ENABLED never
#    existed upstream (no-op) - the real switch is OVERLEAF_DISABLE_LINK_SHARING.
#    Replace the dead variable, or add the real one if missing.
if grep -q '^OVERLEAF_LINK_SHARING_ENABLED=' "$VARIABLES_ENV"; then
    sed -i 's|^# Disable public link sharing (require login to access projects)$|# Disable link sharing entirely (blocks /read/<token> and read-write token URLs)|' "$VARIABLES_ENV"
    sed -i 's|^OVERLEAF_LINK_SHARING_ENABLED=.*|OVERLEAF_DISABLE_LINK_SHARING=true|' "$VARIABLES_ENV"
    echo "Replaced no-op OVERLEAF_LINK_SHARING_ENABLED with OVERLEAF_DISABLE_LINK_SHARING=true"
elif ! grep -q '^OVERLEAF_DISABLE_LINK_SHARING=' "$VARIABLES_ENV"; then
    {
        echo ""
        echo "# Disable link sharing entirely (blocks /read/<token> and read-write token URLs)"
        echo "OVERLEAF_DISABLE_LINK_SHARING=true"
    } >> "$VARIABLES_ENV"
    echo "Added OVERLEAF_DISABLE_LINK_SHARING=true"
fi

# Pull the Pandoc conversion image if conversions are enabled
# (with sandboxed compiles it runs as a sibling container, so it must be present locally)
ENABLE_PANDOC_VAL=$(grep '^ENABLE_PANDOC_CONVERSIONS=' "$VARIABLES_ENV" 2>/dev/null | head -1 | cut -d'=' -f2 | tr -d '[:space:]')
if [ "$ENABLE_PANDOC_VAL" = "true" ]; then
    echo ""
    echo "Pulling Pandoc conversion image..."
    docker pull "$PANDOC_IMAGE_VAL" || echo "Warning: could not pull ${PANDOC_IMAGE_VAL} (Word/Markdown conversions will not work until pulled)"
fi

echo ""

# Pull new image
echo "Pulling new image..."
cd overleaf-toolkit
bin/docker-compose pull sharelatex

echo ""
echo "Restarting Overleaf..."
bin/stop
# Skip pulling local texlive image (it's built locally, not on Docker Hub)
SIBLING_CONTAINERS_PULL=false bin/up -d

echo ""
echo "=================================="
echo "  Update complete!"
echo "=================================="
echo ""
echo "Updated: $CURRENT_VERSION -> $NEW_VERSION"
echo ""
echo "MongoDB, Redis, and Dashboard were NOT touched."
echo "Your data and projects are preserved."
echo ""
if [ "$BASE_CURRENT" != "$BASE_NEW" ]; then
    echo "Migration steps applied for the ${BASE_CURRENT} -> ${BASE_NEW} jump:"
    echo "  - OVERLEAF_INVITE_TOKEN_SECRET ensured in variables.env"
    echo "  - Word/Markdown import-export (Pandoc) enabled"
    echo "  - Native history restore enabled"
    echo "  - Public registration page (/register) set explicitly (your y/n answer)"
    echo "  - Toolkit version file aligned (git-bridge image follows it)"
    echo ""
    echo "Note: since Overleaf CE 6.2.0 the redesigned editor is mandatory -"
    echo "all users will see the new editor UI."
    echo ""
fi
echo "Check Overleaf at: http://localhost"
