# Public HTTPS Exposure

Guide to expose Overleaf publicly via Cloudflare Tunnel with automatic HTTPS.

## Automatic Method (Recommended)

You'll only need to:
1. Have a Cloudflare account (free)
2. Have a domain configured in Cloudflare
3. Provide your domain when prompted (e.g., `example.com`)
4. Choose subdomains (or use defaults)

Run the automated setup script:

```bash
./scripts/setup-cloudflare-tunnel.sh
```

The script does everything automatically:
- ✓ Installs cloudflared
- ✓ Authenticates with Cloudflare (opens browser)
- ✓ Creates the tunnel
- ✓ Configures DNS records automatically
- ✓ Updates config files with public URLs
- ✓ Restarts Docker containers with new settings
- ✓ Updates Overleaf UI to show public URLs
- ✓ Installs as system service (optional)



By default your services will be accessible at:
- **Overleaf**: https://overleaf.yourdomain.com
- **Dashboard**: https://overleaf-dashboard.yourdomain.com
- **Signup** (if enabled): https://zotero-signup.yourdomain.com (auto-redirects to registration page)

## Securing with Cloudflare Access

After setup, add access policies via [Cloudflare Zero Trust](https://one.dash.cloudflare.com) → **Access** → **Applications**:

1. Add each service as a **Self-hosted application**
2. Configure access policies:
   - **Overleaf** (overleaf.yourdomain.com): restrict to lab members (email list) or group/institution (email domain)
   - **Dashboard** (overleaf-dashboard.yourdomain.com): restrict to admins only (email list)
   - **Signup** (zotero-signup.yourdomain.com): restrict to lab members (email list) or group/institution (email domain)

Note: Dashboard and Signup point to the same backend (Flask app on port 5000) but use different Access policies. The Signup subdomain is automatically redirected to the registration page by the Flask app.

This adds authentication at Cloudflare's edge, before traffic reaches your server.

---

