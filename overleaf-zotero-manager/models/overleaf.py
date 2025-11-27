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
logger = logging.getLogger(__name__)

class OverleafManager:
    """Manage Overleaf users through MongoDB."""
    
    def __init__(self, mongodb_uri: str):
        """Initialize the Overleaf manager."""
        self.mongodb_uri = mongodb_uri
        self.client = MongoClient(mongodb_uri)
        self.db = self.client.sharelatex
        self.users_collection = self.db.users
        self.italy_tz = pytz.timezone('Europe/Rome')
        
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