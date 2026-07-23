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
| `SANDBOXED_COMPILES` | "true" | Isolate each compile in a separate container for security |
| `TRACK_CHANGES_ENABLED` | "true" | Enable track changes feature |
| `OVERLEAF_PORT` | "80" | Overleaf HTTP port |
| `PASSWORD_VALIDATION_PATTERN` | "a1$" | Password requirements (passfield format) |
| `PASSWORD_VALIDATION_MIN_LENGTH` | "8" | Minimum password length |
| `MAX_UPLOAD_SIZE_MB` | "500" | Max upload size in MB (nginx + web app) |
| `OVERLEAF_INVITE_TOKEN_SECRET` | auto-generated | Required by Overleaf CE >= 6.2.0; generated at install time |
| `ENABLE_OVERLEAF_PUBLIC_REGISTRATION` | "false" | Public registration page at /register (native since CEP ext-v5.0). If the underlying env var is unset, CEP auto-enables the page when no external auth is configured, so it is always written explicitly |
| `ENABLED_LINKED_FILE_TYPES` | "project_file,project_output_file,url" | Allowed linked file types |
| `MONGO_VERSION` | "8.0" | MongoDB version ("4.4" for older CPUs without AVX) |
| `OVERLEAF_LINKED_URL_ALLOWED_RESOURCES` | "^http://zotero-[a-zA-Z0-9-]+:5000" | Regex whitelist for internal Zotero URLs (auto-configured, bypasses SSRF protection) |

## Document Conversion (Pandoc)

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_PANDOC_CONVERSIONS` | "true" | Import Word/Markdown documents, export projects as docx/Markdown/HTML (experimental upstream feature) |
| `PANDOC_IMAGE` | "overleafcep/pandoc-ol:3.10.0.0" | Conversion image (must include zip and an empty entrypoint; the official pandoc image does not work) |

## Branding: Footer & Header

The footer links are native (set via env vars read by Overleaf). The header and footer colors are injected as CSS by `scripts/nginx-customizations.sh`: Overleaf 6.2 ships a white header, offers no env var for the navbar color, and its footer has no dark-theme styling (it stays a white strip under the dark dashboard). Setting `HEADER_BG_COLOR` colors both bars, so the page gets a matching band at the top and at the bottom in either theme.

| Variable | Default | Description |
|----------|---------|-------------|
| `FOOTER_FORK_TEXT` | "Fork on GitHub!" | Text of the bottom-right footer link |
| `FOOTER_FORK_URL` | your fork URL | Target of the "Fork on GitHub" link |
| `FOOTER_CREDIT_TEXT` | "Maintained by …" | Bottom-left credit (leave empty to omit) |
| `FOOTER_CREDIT_URL` | maintainer URL | Link target for the credit |
| `HIDE_POWERED_BY` | "false" | Hide the "© 2025 Powered by Overleaf" line |
| `HEADER_BG_COLOR` | "#1b222c" | Header and footer background (empty = keep Overleaf's default white header and footer) |
| `HEADER_TEXT_COLOR` | "#ffffff" | Header and footer text/link color |
| `HEADER_EXTRAS_CUSTOM` | "" | Extra header menu entries, a JSON fragment without the outer `[ ]` (e.g. a `{"text":...,"dropdown":[...]}` item), appended to the built-in menu. Put site-specific menus here so they survive `configure.sh` runs |

## GitHub Synchronization [optional]

Two-way sync between Overleaf projects and GitHub repositories. Requires a [GitHub OAuth App](https://github.com/yu-i-i/overleaf-cep/wiki/Extended-CE:-GitHub-Synchronization) with callback URL `<OVERLEAF_URL>/user/github-sync/oauth2/callback`.

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_GITHUB_SYNC` | "false" | Enable GitHub synchronization |
| `GITHUB_SYNC_CLIENT_ID` | - | GitHub OAuth App client ID |
| `GITHUB_SYNC_CLIENT_SECRET` | - | GitHub OAuth App client secret |

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

