"""Configuration for Overleaf-Zotero Manager."""

import os
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

class Config:
    """Application configuration."""
    
    # Flask Configuration
    SECRET_KEY = os.environ.get('FLASK_SECRET_KEY', os.urandom(32))
    DEBUG = os.environ.get('FLASK_DEBUG', 'False').lower() == 'true'
    HOST = os.environ.get('FLASK_HOST', '0.0.0.0')
    PORT = int(os.environ.get('FLASK_PORT', 5000))

    # Branding
    LAB_NAME = os.environ.get('LAB_NAME', 'Lab Name')
    
    # Admin Credentials
    ADMIN_USERNAME = os.environ.get('ADMIN_USERNAME', 'admin')
    ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', 'changeme')
    
    # MongoDB Configuration (Overleaf)
    MONGODB_URI = os.environ.get('MONGODB_URI', 'mongodb://localhost:27017/sharelatex')
    
    # Paths Configuration
    OVERLEAF_TOOLKIT_PATH = os.environ.get('OVERLEAF_TOOLKIT_PATH', './overleaf-toolkit')
    ZOTERO_PROXIES_PATH = os.environ.get('ZOTERO_PROXIES_PATH', './zotero-proxies')
    ZOTERO_PROXY_IMAGE = os.environ.get('ZOTERO_PROXY_IMAGE', 'zotero-overleaf-proxy:local')

    # Service URLs
    OVERLEAF_URL = os.environ.get('OVERLEAF_URL', 'http://localhost')

    # Signup subdomain (for automatic redirect when using separate signup hostname)
    # e.g., "zotero-signup" will redirect zotero-signup.domain.com to /zotero/signup
    SIGNUP_SUBDOMAIN = os.environ.get('SIGNUP_SUBDOMAIN', '')

    # Enable public Zotero signup page (if False, /zotero/signup returns 404)
    ENABLE_PUBLIC_ZOTERO_SIGNUP = os.environ.get('ENABLE_PUBLIC_ZOTERO_SIGNUP', 'false').lower() == 'true'

    # Proxy Configuration
    # When running behind Cloudflare Tunnel or reverse proxy, set to True
    BEHIND_PROXY = os.environ.get('BEHIND_PROXY', 'false').lower() == 'true'

    # Session Configuration
    SESSION_COOKIE_SECURE = os.environ.get('SESSION_COOKIE_SECURE', 'False').lower() == 'true'
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = 'Lax'
    
    # Logging
    LOG_LEVEL = os.environ.get('LOG_LEVEL', 'INFO')
    LOG_FILE = os.environ.get('LOG_FILE', 'logs/app.log')

    @staticmethod
    def validate():
        """Validate configuration."""
        errors = []
        
        # Check required paths exist
        if not os.path.exists(Config.OVERLEAF_TOOLKIT_PATH):
            errors.append(f"Overleaf toolkit path not found: {Config.OVERLEAF_TOOLKIT_PATH}")
        
        if not os.path.exists(Config.ZOTERO_PROXIES_PATH):
            errors.append(f"Zotero proxies path not found: {Config.ZOTERO_PROXIES_PATH}")
        
        # Check MongoDB connection
        try:
            from pymongo import MongoClient
            client = MongoClient(Config.MONGODB_URI, serverSelectionTimeoutMS=5000)
            client.server_info()
        except Exception as e:
            errors.append(f"MongoDB connection failed: {str(e)}")
        
        # Warn about default credentials
        if Config.ADMIN_PASSWORD == 'changeme':
            errors.append("WARNING: Using default admin password. Please change it in .env file!")
        
        return errors
