"""Overleaf user management module."""

import os
import json
import subprocess
from typing import List, Dict, Any
import logging

from pymongo import MongoClient
from bson import ObjectId
from datetime import datetime, timezone
import pytz
import redis

logger = logging.getLogger(__name__)

class OverleafManager:
    """Manage Overleaf users through MongoDB and Redis."""

    def __init__(self, mongodb_uri: str, redis_host: str = 'redis', redis_port: int = 6379):
        """Initialize the Overleaf manager."""
        self.mongodb_uri = mongodb_uri
        self.client = MongoClient(mongodb_uri)
        self.db = self.client.sharelatex
        self.users_collection = self.db.users
        self.italy_tz = pytz.timezone('Europe/Rome')

        # Redis connection for sessions
        try:
            self.redis_client = redis.Redis(host=redis_host, port=redis_port, decode_responses=True)
            self.redis_client.ping()
        except Exception as e:
            logger.warning(f"Redis connection failed: {e}")
            self.redis_client = None
        
    def _convert_to_local_time(self, dt):
        """Convert UTC datetime to Italy timezone."""
        if dt and isinstance(dt, datetime):
            if dt.tzinfo is None:
                # Assume UTC if no timezone
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(self.italy_tz).strftime('%Y-%m-%d %H:%M')
        return None
        
    def check_connection(self) -> bool:
        """Check if MongoDB is accessible."""
        try:
            self.client.server_info()
            return True
        except Exception as e:
            logger.error(f"MongoDB connection failed: {e}")
            return False
    
    def list_users(self) -> List[Dict[str, Any]]:
        """List all Overleaf users."""
        try:
            users = []
            for user in self.users_collection.find():
                user_id = user.get('_id')
                
                # Get REAL last activity from projects
                last_activity = None
                if user_id:
                    recent_project = self.db.projects.find_one(
                        {'owner_ref': user_id},
                        sort=[('lastUpdated', -1)]
                    )
                    if recent_project and 'lastUpdated' in recent_project:
                        last_activity = recent_project['lastUpdated']
                
                # Convert to local time
                last_seen = self._convert_to_local_time(last_activity) or 'Never active'
                created_at = self._convert_to_local_time(user.get('signUpDate'))
                last_logged_in = self._convert_to_local_time(user.get('lastLoggedIn'))
                
                users.append({
                    'id': str(user.get('_id')),
                    'email': user.get('email'),
                    'first_name': user.get('first_name', ''),
                    'last_name': user.get('last_name', ''),
                    'is_admin': user.get('isAdmin', False),
                    'created_at': created_at or '',
                    'last_logged_in': last_logged_in or '',
                    'last_seen': last_seen,
                    'features': user.get('features', {}),
                    'confirmed': user.get('confirmed', False)
                })
            return users
        except Exception as e:
            logger.error(f"Failed to list users: {e}")
            raise
    
    def get_user_count(self) -> int:
        """Get the total number of users."""
        try:
            return self.users_collection.count_documents({})
        except Exception as e:
            logger.error(f"Failed to count users: {e}")
            return 0
    
    def create_user(self, email: str, password: str = None, is_admin: bool = False) -> Dict[str, Any]:
        """Create a new Overleaf user using official script."""
        try:
            # Check if user already exists
            if self.users_collection.find_one({'email': email}):
                return {'success': False, 'error': 'User already exists'}
            
            # Build command using official Overleaf script
            cmd = [
                'docker', 'exec', 'sharelatex', '/bin/bash', '-c',
                f"cd /overleaf/services/web && node modules/server-ce-scripts/scripts/create-user --email={email}"
            ]
            
            # Add admin flag if needed
            if is_admin:
                cmd[-1] += " --admin"
            
            # Add password or send invitation email
            if password:
                cmd[-1] += f" --password={password}"
            else:
                cmd[-1] += " --no-set-password"  # Sends email with password setup link
            
            # Execute command
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=True
            )
            
            logger.info(f"Created user: {email} (admin: {is_admin})")
            
            # Get user ID from database
            user = self.users_collection.find_one({'email': email})
            user_id = str(user['_id']) if user else None
            
            return {
                'success': True,
                'user_id': user_id,
                'email': email,
                'is_admin': is_admin,
                'message': 'User created. Activation email sent.' if not password else 'User created with password.'
            }
                
        except subprocess.CalledProcessError as e:
            error_msg = e.stderr if e.stderr else str(e)
            logger.error(f"Failed to create user {email}: {error_msg}")
            return {'success': False, 'error': error_msg}
        except Exception as e:
            logger.error(f"Failed to create user {email}: {e}")
            return {'success': False, 'error': str(e)}
    
    def delete_user(self, email: str) -> Dict[str, Any]:
        """Delete an Overleaf user."""
        try:
            # Find user
            user = self.users_collection.find_one({'email': email})
            if not user:
                return {'success': False, 'error': 'User not found'}
            
            # Delete user's projects first
            user_id = user['_id']
            self.db.projects.delete_many({'owner_ref': user_id})
            
            # Delete user's tokens
            self.db.tokens.delete_many({'user_id': user_id})
            
            # Delete user
            result = self.users_collection.delete_one({'_id': user_id})
            
            if result.deleted_count:
                logger.info(f"Deleted user: {email}")
                return {'success': True, 'message': f'User {email} deleted successfully'}
            else:
                return {'success': False, 'error': 'Failed to delete user'}
                
        except Exception as e:
            logger.error(f"Failed to delete user {email}: {e}")
            return {'success': False, 'error': str(e)}
    
    def set_admin_status(self, email: str, is_admin: bool) -> Dict[str, Any]:
        """Set admin status for a user."""
        try:
            result = self.users_collection.update_one(
                {'email': email},
                {'$set': {'isAdmin': is_admin}}
            )
            
            if result.modified_count:
                logger.info(f"Updated admin status for {email}: {is_admin}")
                return {'success': True, 'email': email, 'is_admin': is_admin}
            elif result.matched_count:
                return {'success': True, 'message': 'User already has this status'}
            else:
                return {'success': False, 'error': 'User not found'}
                
        except Exception as e:
            logger.error(f"Failed to update admin status for {email}: {e}")
            return {'success': False, 'error': str(e)}
    
    def get_user_by_email(self, email: str) -> Dict[str, Any]:
        """Get user details by email."""
        try:
            user = self.users_collection.find_one({'email': email})
            if user:
                return {
                    'id': str(user.get('_id')),
                    'email': user.get('email'),
                    'first_name': user.get('first_name', ''),
                    'last_name': user.get('last_name', ''),
                    'is_admin': user.get('isAdmin', False),
                    'created_at': user.get('signUpDate', ''),
                    'last_logged_in': user.get('lastLoggedIn', ''),
                    'confirmed': user.get('confirmed', False)
                }
            return None
        except Exception as e:
            logger.error(f"Failed to get user {email}: {e}")
            return None
    
    def update_user_password(self, email: str, new_password: str) -> Dict[str, Any]:
        """Update user password directly in MongoDB."""
        try:
            import bcrypt

            # Check if user exists
            user = self.users_collection.find_one({'email': email})
            if not user:
                return {'success': False, 'error': 'User not found'}

            # Hash the new password
            hashed_password = bcrypt.hashpw(new_password.encode('utf-8'), bcrypt.gensalt())

            # Update password in MongoDB
            result = self.users_collection.update_one(
                {'email': email},
                {'$set': {'hashedPassword': hashed_password}}
            )

            if result.modified_count > 0:
                logger.info(f"Updated password for {email}")
                return {'success': True, 'message': 'Password updated successfully'}
            else:
                return {'success': False, 'error': 'Password update failed'}

        except Exception as e:
            logger.error(f"Failed to update password for {email}: {e}")
            return {'success': False, 'error': str(e)}

    def get_active_sessions(self) -> List[Dict[str, Any]]:
        """Get projects with recent activity (last 1 hour) and their collaborators."""
        try:
            from datetime import timedelta

            # Projects with activity in last 1 hour
            cutoff = datetime.now(timezone.utc) - timedelta(hours=1)

            active_projects = []
            for proj in self.db.projects.find(
                {'lastUpdated': {'$gte': cutoff}},
                sort=[('lastUpdated', -1)]
            ).limit(20):
                # Get owner info
                owner_id = proj.get('owner_ref')
                owner = self.users_collection.find_one({'_id': owner_id}) if owner_id else None
                owner_email = owner.get('email', 'Unknown') if owner else 'Unknown'

                # Get collaborators (people who can edit)
                collaborators = []
                for collab_id in proj.get('collaberator_refs', []):
                    collab = self.users_collection.find_one({'_id': collab_id})
                    if collab:
                        collaborators.append(collab.get('email', ''))

                active_projects.append({
                    'project_name': proj.get('name', 'Untitled'),
                    'owner_email': owner_email,
                    'collaborators': collaborators,
                    'last_activity': self._convert_to_local_time(proj.get('lastUpdated')),
                })

            return active_projects
        except Exception as e:
            logger.error(f"Failed to get active projects: {e}")
            return []

    def get_logged_in_sessions(self) -> List[Dict[str, Any]]:
        """Get logged in sessions from Redis (users with valid session cookies)."""
        try:
            if not self.redis_client:
                return []

            sessions = []
            # Get all session keys from Redis
            session_keys = self.redis_client.keys("sess:*")

            for key in session_keys:
                try:
                    session_data = self.redis_client.get(key)
                    if not session_data:
                        continue

                    data = json.loads(session_data)
                    passport = data.get('passport', {})
                    user_info = passport.get('user', {})

                    if user_info:
                        # Parse expiry date
                        expires = None
                        cookie = data.get('cookie', {})
                        if cookie.get('expires'):
                            try:
                                expires_dt = datetime.fromisoformat(cookie['expires'].replace('Z', '+00:00'))
                                expires = expires_dt.astimezone(self.italy_tz).strftime('%Y-%m-%d %H:%M')
                            except:
                                pass

                        sessions.append({
                            'session_id': key.replace('sess:', ''),
                            'user_id': user_info.get('_id', ''),
                            'email': user_info.get('email', 'Unknown'),
                            'first_name': user_info.get('first_name', ''),
                            'last_name': user_info.get('last_name', ''),
                            'expires': expires,
                        })
                except Exception as e:
                    logger.debug(f"Failed to parse session {key}: {e}")
                    continue

            return sessions
        except Exception as e:
            logger.error(f"Failed to get logged in sessions: {e}")
            return []

    def get_active_projects(self) -> List[Dict[str, Any]]:
        """Get recently active projects (updated in last 24 hours)."""
        try:
            from datetime import timedelta
            cutoff = datetime.now(timezone.utc) - timedelta(hours=24)

            projects = []
            for proj in self.db.projects.find(
                {'lastUpdated': {'$gte': cutoff}},
                sort=[('lastUpdated', -1)]
            ).limit(50):
                # Get owner info
                owner = self.users_collection.find_one({'_id': proj.get('owner_ref')})
                owner_email = owner.get('email', 'Unknown') if owner else 'Unknown'

                projects.append({
                    'project_id': str(proj.get('_id')),
                    'name': proj.get('name', 'Untitled'),
                    'owner_email': owner_email,
                    'last_updated': self._convert_to_local_time(proj.get('lastUpdated')),
                })

            return projects
        except Exception as e:
            logger.error(f"Failed to get active projects: {e}")
            return []

    def get_session_count(self) -> int:
        """Get the number of projects with activity in last 1 hour."""
        try:
            from datetime import timedelta
            cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
            return self.db.projects.count_documents({'lastUpdated': {'$gte': cutoff}})
        except Exception as e:
            logger.error(f"Failed to count active projects: {e}")
            return 0