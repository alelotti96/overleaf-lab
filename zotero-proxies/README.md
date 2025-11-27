# Zotero Proxies for Overleaf

This directory contains the Docker-based Zotero proxy system that allows multiple users to connect their personal Zotero libraries to Overleaf.

## Architecture

The system consists of:
- **Individual Proxy Containers**: One container per user, each connected to their personal Zotero library
- **Docker Network**: All containers share the `overleaf_default` network for internal communication
- **Direct Access**: Overleaf accesses each user's container directly via Docker network (no reverse proxy needed)

## How It Works

Each user gets:
1. A dedicated Docker container running the Zotero proxy
2. A unique internal URL: `http://zotero-{username}:5000`
3. Access to their entire Zotero library or specific collections

When Overleaf uses a Zotero URL:
1. The request goes directly to the user's container via Docker network
2. The container fetches their bibliography from Zotero API
3. Returns a `.bib` file that Overleaf can use

## Management via Dashboard

**Users are managed via the Dashboard web UI** - no manual configuration needed!

The Dashboard (`overleaf-zotero-manager`) handles:
- Adding new Zotero users
- Validating Zotero credentials
- Creating/removing Docker containers
- Managing environment variables

See the main project README for Dashboard setup instructions.

