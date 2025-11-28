#!/usr/bin/env python3
"""
Overleaf-Zotero Manager
A unified web interface for managing self-hosted Overleaf users and Zotero proxy configurations.
"""

import os
import json
import secrets
from datetime import datetime
from functools import wraps

from flask import Flask, render_template, request, jsonify, redirect, url_for, session, flash, abort
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.middleware.proxy_fix import ProxyFix

from config import Config
from models.overleaf import OverleafManager
from models.zotero import ZoteroProxyManager

# Initialize Flask app
app = Flask(__name__)
app.config.from_object(Config)

# Enable proxy support when behind Cloudflare/reverse proxy
# This allows Flask to read X-Forwarded-* headers correctly
if app.config.get('BEHIND_PROXY', False):
    app.wsgi_app = ProxyFix(
        app.wsgi_app,
        x_for=1,      # X-Forwarded-For
        x_proto=1,    # X-Forwarded-Proto
        x_host=1,     # X-Forwarded-Host
        x_prefix=1    # X-Forwarded-Prefix
    )

CORS(app)

# Initialize managers
overleaf_manager = OverleafManager(app.config['MONGODB_URI'])
zotero_manager = ZoteroProxyManager(
    app.config['ZOTERO_PROXIES_PATH'],
    app.config['ZOTERO_PROXY_IMAGE']
)

# Authentication decorator
def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'logged_in' not in session:
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated_function

# Context processor to inject LAB_NAME into all templates
@app.context_processor
def inject_lab_name():
    return dict(lab_name=app.config['LAB_NAME'])

# Routes
@app.route('/')
def index():
    """Redirect to appropriate page based on hostname and login status."""
    # If coming from signup subdomain, redirect to public registration
    signup_subdomain = app.config.get('SIGNUP_SUBDOMAIN', '')

    # Check if request comes from signup hostname
    # request.host may include port, so we check the hostname part
    if signup_subdomain:
        hostname = request.host.split(':')[0]  # Remove port if present
        # Check if hostname starts with the signup subdomain (e.g., "zotero-signup")
        if hostname.startswith(signup_subdomain + '.') or hostname == signup_subdomain:
            return redirect(url_for('zotero_signup'))

    # Otherwise normal behavior: dashboard if logged in, login if not
    if 'logged_in' in session:
        return redirect(url_for('dashboard'))
    return redirect(url_for('login'))

@app.route('/login', methods=['GET', 'POST'])
def login():
    """Login page."""
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        
        if username == app.config['ADMIN_USERNAME'] and password == app.config['ADMIN_PASSWORD']:
            session['logged_in'] = True
            session['username'] = username
            flash('Logged in successfully!', 'success')
            return redirect(url_for('dashboard'))
        else:
            flash('Invalid username or password', 'error')
    
    return render_template('login.html')

@app.route('/logout')
def logout():
    """Logout the user."""
    session.clear()
    flash('Logged out successfully!', 'info')
    return redirect(url_for('login'))

@app.route('/dashboard')
@login_required
def dashboard():
    """Main dashboard."""
    stats = {
        'overleaf_users': overleaf_manager.get_user_count(),
        'zotero_proxies': zotero_manager.get_proxy_count()
    }
    return render_template('dashboard.html', stats=stats)

# Overleaf API endpoints
@app.route('/api/overleaf/users', methods=['GET'])
@login_required
def get_overleaf_users():
    """Get all Overleaf users."""
    try:
        users = overleaf_manager.list_users()
        return jsonify({'success': True, 'users': users})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/overleaf/users', methods=['POST'])
@login_required
def create_overleaf_user():
    """Create a new Overleaf user."""
    try:
        data = request.json
        email = data.get('email')
        password = data.get('password')  # Opzionale
        is_admin = data.get('is_admin', False)
        
        if not email:  # ← SOLO EMAIL OBBLIGATORIA
            return jsonify({'success': False, 'error': 'Email is required'}), 400
        
        result = overleaf_manager.create_user(email, password, is_admin)
        return jsonify(result)
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/overleaf/users/<email>', methods=['DELETE'])
@login_required
def delete_overleaf_user(email):
    """Delete an Overleaf user."""
    try:
        result = overleaf_manager.delete_user(email)
        return jsonify(result)
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/overleaf/users/<email>/admin', methods=['PUT'])
@login_required
def toggle_admin_status(email):
    """Toggle admin status for an Overleaf user."""
    try:
        data = request.json
        is_admin = data.get('is_admin', False)
        result = overleaf_manager.set_admin_status(email, is_admin)
        return jsonify(result)
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# Zotero API endpoints
@app.route('/api/zotero/proxies', methods=['GET'])
@login_required
def get_zotero_proxies():
    """Get all Zotero proxies."""
    try:
        proxies = zotero_manager.list_proxies()
        return jsonify({'success': True, 'proxies': proxies})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/zotero/proxies', methods=['POST'])
def create_zotero_proxy():
    """Create a new Zotero proxy."""
    try:
        data = request.json
        username = data.get('username')
        api_key = data.get('api_key')
        user_id = data.get('user_id')
        
        if not all([username, api_key, user_id]):
            return jsonify({'success': False, 'error': 'All fields are required'}), 400
        
        # Validate username (lowercase, no spaces)
        username = username.lower().strip()
        if ' ' in username or not username.isalnum() and '-' not in username:
            return jsonify({'success': False, 'error': 'Username must be lowercase with no spaces'}), 400
        
        result = zotero_manager.add_proxy(username, api_key, user_id)
        return jsonify(result)
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/zotero/proxies/<username>', methods=['PUT'])
@login_required
def update_zotero_proxy(username):
    """Update a Zotero proxy."""
    try:
        data = request.json
        api_key = data.get('api_key')
        user_id = data.get('user_id')
        
        if not api_key or not user_id:
            return jsonify({'success': False, 'error': 'API key and User ID are required'}), 400
        
        result = zotero_manager.update_proxy(username, api_key, user_id)
        return jsonify(result)
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/zotero/proxies/<username>', methods=['DELETE'])
@login_required
def delete_zotero_proxy(username):
    """Delete a Zotero proxy."""
    try:
        result = zotero_manager.remove_proxy(username)
        return jsonify(result)
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/system/status', methods=['GET'])
@login_required
def get_system_status():
    """Get system status."""
    try:
        status = {
            'mongodb': overleaf_manager.check_connection(),
            'docker': zotero_manager.check_docker(),
            'timestamp': datetime.now().isoformat()
        }
        return jsonify({'success': True, 'status': status})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# Template pages
@app.route('/overleaf')
@login_required
def overleaf_page():
    """Overleaf management page."""
    return render_template('overleaf.html')

@app.route('/zotero')
@login_required
def zotero_page():
    """Zotero management page."""
    return render_template('zotero.html')

@app.route('/api/overleaf/users/<email>/password', methods=['PUT'])
@login_required
def update_password(email):
    """Update user password."""
    try:
        data = request.json
        new_password = data.get('password')
        
        if not new_password:
            return jsonify({'success': False, 'error': 'Password is required'}), 400
        
        result = overleaf_manager.update_user_password(email, new_password)
        return jsonify(result)
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# app.py
@app.route('/zotero/signup', methods=['GET'])
def zotero_signup():
    """Public page for users to self-register Zotero integration."""
    if not app.config.get('ENABLE_PUBLIC_ZOTERO_SIGNUP', False):
        abort(404)
    return render_template('zotero_register.html')

@app.errorhandler(404)
def page_not_found(e):
    """Handle 404 errors."""
    return render_template('404.html'), 404

@app.errorhandler(500)
def internal_error(e):
    """Handle 500 errors."""
    return render_template('500.html'), 500

if __name__ == '__main__':
    # Create necessary directories
    os.makedirs('logs', exist_ok=True)

    # Run the app
    app.run(
        host=app.config.get('HOST', '0.0.0.0'),
        port=app.config.get('PORT', 5000),
        debug=app.config.get('DEBUG', False)
    )
