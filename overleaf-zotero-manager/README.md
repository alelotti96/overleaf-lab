# Overleaf-Zotero Manager

A web dashboard for managing self-hosted Overleaf users and Zotero proxy integrations.

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
- ENABLE_PUBLIC_ZOTERO_SIGNUP: Set to true to enable the public registration page at /zotero/signup (default: false)
- SIGNUP_SUBDOMAIN: If using a separate subdomain for signup (e.g., zotero-signup.domain.com), requests will be automatically redirected to /zotero/signup

**Note:** The installation script (`install.sh` in parent directory) automatically configures these paths.

### 2. Install Python Dependencies

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 3. Run the Application

#### Development Mode

```bash
python3 app.py
```

#### Production Mode with Docker

The dashboard is included in the main docker-compose setup. See parent directory for deployment instructions.

```bash
docker-compose up -d overleaf-zotero-manager

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
