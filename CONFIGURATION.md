# Configuration Reference

This project uses a unified configuration file that wraps and manages environment variables for all components (Overleaf, Dashboard, Zotero proxies). Instead of editing multiple `.env` files across different directories, you configure everything in one place.

- **`config.env`** — Template with default values and documentation
- **`config.env.local`** — Your actual configuration (created by `install.sh`)

The install script reads `config.env.local` and edits the appropriate config files for each component.

## General Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `LAB_NAME` | "Your Lab Name" | Name shown in UI |
| `ADMIN_EMAIL` | - | Admin email for dashboard login |
| `ENABLE_PUBLIC_ZOTERO_SIGNUP` | "false" | Allow Zotero self-registration |
| `OVERLEAF_URL` | "http://localhost" | Public Overleaf URL |
| `DASHBOARD_URL` | "http://localhost:5000" | Dashboard URL |
| `BEHIND_PROXY` | "false" | Set "true" if behind reverse proxy with HTTPS |
| `USE_SECURE_COOKIES` | "false" | Set "true" for HTTPS (must match BEHIND_PROXY) |

## Overleaf Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `COMPILE_TIMEOUT` | "180" | Compile timeout in seconds (3 min) |
| `SANDBOXED_COMPILES` | "false" | Enable sandboxed compiles |
| `TRACK_CHANGES_ENABLED` | "true" | Enable track changes feature |
| `OVERLEAF_PORT` | "80" | Overleaf HTTP port |
| `PASSWORD_VALIDATION_PATTERN` | "aa11$8" | Password requirements (letters, numbers, special, min 8) |
| `MAX_UPLOAD_SIZE` | "524288000" | Max upload size in bytes (500MB) |
| `ENABLED_LINKED_FILE_TYPES` | "project_file,project_output_file,url" | Allowed linked file types |
| `OVERLEAF_LINKED_URL_ALLOWED_RESOURCES` | "^http://zotero-[a-zA-Z0-9-]+:5000" | Regex whitelist for internal Zotero URLs (auto-configured, bypasses SSRF protection) |

## Email (SMTP) [optional]

| Variable | Default | Description |
|----------|---------|-------------|
| `EMAIL_FROM_ADDRESS` | - | Sender email address |
| `SMTP_HOST` | - | SMTP server hostname |
| `SMTP_PORT` | "587" | SMTP port |
| `SMTP_SECURE` | "false" | Use SSL/TLS |
| `SMTP_USER` | - | SMTP username |
| `SMTP_PASS` | - | SMTP password |
| `EMAIL_CONFIRMATION_DISABLED` | "true" | Skip email confirmation |

## Dashboard

| Variable | Default | Description |
|----------|---------|-------------|
| `FLASK_SECRET_KEY` | - | Flask secret (auto-generated) |
| `DASHBOARD_ADMIN_PASSWORD` | - | Dashboard login password |
| `FLASK_PORT` | "5000" | Dashboard port |
| `MONGODB_URI` | "mongodb://mongo:27017/sharelatex" | MongoDB connection |
| `SESSION_COOKIE_SECURE` | "False" | Set "True" for HTTPS |

## Zotero

| Variable | Default | Description |
|----------|---------|-------------|
| `ZOTERO_PROXY_IMAGE` | "zotero-overleaf-proxy:local" | Per-user container image |

---

## Customizations vs Base Overleaf

This project adds the following on top of standard Overleaf:

### Docker Image
- Uses `overleafcep/sharelatex` (Extended CE) instead of `sharelatex/sharelatex`

### LaTeX Packages
During installation, you can choose to add LaTeX packages:
- **Full TeXLive**: all packages
- **Essential only**: common academic packages

### Zotero Integration
- Per-user Zotero proxy containers
- Internal URLs: `http://zotero-{username}:5000` (Docker network only)
- Dashboard for managing users and Zotero credentials

### Network Architecture
```
Internet
    │
    ├── :80   → Overleaf (sharelatex container)
    └── :5000 → Dashboard (overleaf-zotero-manager)

Docker internal network:
    Overleaf → http://zotero-{user}:5000 (per-user Zotero containers)
```

