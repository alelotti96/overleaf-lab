# Overleaf-Zotero Manager

A unified web dashboard for managing self-hosted Overleaf users and Zotero proxy integrations.

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
- `ZOTERO_PROXIES_PATH`: Absolute path to zotero-proxies directory
- `OVERLEAF_URL`: Public URL where your Overleaf is accessible
- `MONGODB_URI`: Connection string to Overleaf's MongoDB

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
docker-compose up -d dashboard
```

The dashboard will be available at `http://localhost:5000`

## Usage

### Accessing the Dashboard

1. Navigate to `http://your-server:5000`
2. Log in with your admin credentials
3. You'll see the main dashboard with statistics

### Managing Overleaf Users

**Create a new user:**
1. Go to "Overleaf Users" tab
2. Click "Add New User"
3. Enter email address
4. Optionally grant admin privileges
5. User receives activation email with password setup link

**Change user password:**
1. Find user in the table
2. Click the key icon
3. Enter new password

**Toggle admin status:**
1. Find user in the table
2. Click the shield icon
3. Confirm the change

**Delete user:**
1. Find user in the table
2. Click the trash icon
3. Confirm deletion (irreversible!)

### Managing Zotero Proxies

**Add a new proxy (Admin):**
1. Go to "Zotero Proxies" tab
2. Click "Add New Proxy"
3. Enter username, Zotero API Key, and User ID
4. System validates credentials with Zotero API
5. Container is automatically created and started

**User self-service registration:**
1. Share the public URL: `http://your-server:5000/zotero/signup`
2. Users follow the 5-step wizard to:
   - Get Zotero API credentials
   - Register their account
   - Receive integration instructions
   - Configure Overleaf project
3. No admin intervention needed!

**Update proxy credentials:**
1. Find proxy in the table
2. Click the edit icon
3. Enter new API Key and User ID
4. Container automatically restarts with new credentials

**Remove a proxy:**
1. Find proxy in the table
2. Click the trash icon
3. Container is stopped and removed

## Security Considerations

1. **Change default credentials**: Always change `ADMIN_PASSWORD` from default
2. **Use HTTPS in production**: Set `SESSION_COOKIE_SECURE=True` when using HTTPS
3. **Secure secret key**: Generate a strong `FLASK_SECRET_KEY`
4. **Firewall**: Restrict access to port 5000 to authorized networks
5. **MongoDB access**: Ensure MongoDB is not publicly accessible
6. **Zotero API keys**: Stored in `.env` files - keep them secret

## Troubleshooting

### Cannot connect to MongoDB

**Symptoms**: Dashboard shows "MongoDB connection failed"

**Solutions**:
- Verify MongoDB is running: `docker ps | grep mongo`
- Check `MONGODB_URI` in `.env` matches your setup
- If using Docker: ensure dashboard is on same network as MongoDB
- Test connection: `docker exec mongo mongosh --eval "db.version()"`

### Cannot create Zotero proxy

**Symptoms**: Error when adding new proxy user

**Solutions**:
- Verify Docker is running: `docker info`
- Check Zotero API credentials are valid
- Ensure `zotero-proxies/` directory exists and is writable
- Check Docker logs: `docker logs zotero-username`

### User creation fails

**Symptoms**: "Failed to create user" error

**Solutions**:
- Check MongoDB connection
- Verify email format is correct
- Check Overleaf is running: `cd overleaf-toolkit && bin/status`
- Review logs in `logs/app.log`

### Dashboard won't start

**Symptoms**: Python errors on startup

**Solutions**:
- Install dependencies: `pip install -r requirements.txt`
- Check `.env` file exists and is valid
- Verify paths in `.env` point to existing directories
- Check port 5000 is not already in use: `netstat -tuln | grep 5000`

## License

See LICENSE file in the root directory.
