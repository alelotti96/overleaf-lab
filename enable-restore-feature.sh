#!/bin/bash
# Enable project restore feature by modifying Overleaf settings.js
# This script is executed inside the container on startup

SETTINGS_FILE="/etc/overleaf/settings.js"

# Check if splitTestOverrides already exists
if grep -q "splitTestOverrides" "$SETTINGS_FILE"; then
    echo "splitTestOverrides already configured"
    exit 0
fi

# Add splitTestOverrides before module.exports
sed -i '/^module.exports = settings$/i\
\
// Enable project and file restoration features\
// Added by overleaf-lab\
settings.splitTestOverrides = {\
  "history-ranges-support": "enabled",\
  "revert-file": "enabled",\
  "revert-project": "enabled",\
}\
' "$SETTINGS_FILE"

echo "✓ Project restore feature enabled in settings.js"
