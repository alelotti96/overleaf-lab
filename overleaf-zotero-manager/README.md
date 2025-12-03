# Overleaf-Zotero Manager
A web dashboard for managing self-hosted Overleaf users and Zotero proxy integrations.

The install.sh script handles all installation steps described in this readme when installing overleaf. If you already have an Overleaf instance running, follow this guide to install the dashboard alongside it.

## Features

### Overleaf User Management
- Create new Overleaf users with activation emails
- Delete users
- Change user passwords
- Toggle admin privileges
- View user statistics (creation date, last login, last compile)

### Zotero Proxy Management
- Add new Zotero proxy containers for users
- Update Zotero API credentials
- Remove proxy containers
- View active proxies and their status
- Automatic validation of Zotero credentials

### Activity Monitor
- Live project activity tracking (last 1 hour)
- View project owner and collaborators
- Auto-refresh every 10 seconds

### Public Self-Service
- Public registration page for users to add their Zotero integration
- No admin intervention required for Zotero setup
- Automatic container provisioning

## Architecture

The dashboard is a Flask web application that:
- Connects to Overleaf's MongoDB database to manage users
- Manages Docker containers for individual Zotero proxies
- Provides a clean web interface for all administrative tasks

## Prerequisites

- Python 3.8+
- Docker and Docker Compose
- Access to Overleaf's MongoDB (typically on same network)
- Overleaf Toolkit installed

## Installation

### 1. Configure Environment

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` and configure:

```bash
# Generate a secure secret key
python3 -c "import secrets; print(secrets.token_hex(32))"

# Edit .env with your values
nano .env
```

**Required settings:**
- `FLASK_SECRET_KEY`: Use the generated secret key
- `ADMIN_USERNAME` and `ADMIN_PASSWORD`: Your admin credentials
- `LAB_NAME`: Your lab/organization name (shown in UI)
- `OVERLEAF_TOOLKIT_PATH`: Absolute path to overleaf-toolkit directory
- `ZOTERO_PROXIES_PATH`: Absolute path to zotero-proxies directory (ZOTERO_PROXIES_PATH=/home/<username>/overleaf-lab/zotero-proxies)
- `OVERLEAF_URL`: Public URL where your Overleaf is accessible
- `MONGODB_URI`: Connection string to Overleaf's MongoDB

**Optional settings:**
- `ENABLE_PUBLIC_ZOTERO_SIGNUP`: Set to true to enable the public registration page at /zotero/signup (default: false)
- `SIGNUP_SUBDOMAIN`: If using a separate subdomain for signup (e.g., zotero-signup.domain.com), requests will be automatically redirected to /zotero/signup

**Important:** Initialize the zotero-proxies directory before first run:

```bash
cp ~/overleaf-lab/zotero-proxies/docker-compose.yml.example \
   ~/overleaf-lab/zotero-proxies/docker-compose.yml

```

In your overleaf env file (overleaf-toolkit/config/variables.env) set:

- `ENABLED_LINKED_FILE_TYPES`=project_file,project_output_file,url
- Optionally set `OVERLEAF_HEADER_EXTRAS=[{"text":"Zotero Integration","url":"http://localhost:5000/signup","class":"subdued"},{"text":"Admin Dashboard","url":"http://localhost:5000","class":"subdued"}]` to add links to the Overleaf header

### 2. Build Dashboard and Zotero Proxy Image

Build the Docker image for individual Zotero proxy containers:

```bash
sudo docker build -t overleaf-zotero-manager:local .
cd zotero-proxy
docker build -t zotero-overleaf-proxy:local .
cd ..

```

The dashboard will be available at `http://localhost:5000`

## Usage

### Accessing the Dashboard

1. Navigate to `http://your-server:5000`
2. Log in with your admin credentials
3. You'll see the main dashboard with statistics

### Dashboard Pages

- **Users**: View, create, delete Overleaf users, reset passwords, assign/remove admin rights
- **Zotero**: Add/remove Zotero users, configure API keys per user
- **Activity**: Live project activity tracking with owner and collaborators
- **Signup** (public): Page where users can self-register their Zotero credentials

## License

See LICENSE file in the root directory.
