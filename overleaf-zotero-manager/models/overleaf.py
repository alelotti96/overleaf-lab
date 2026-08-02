"""Overleaf user management module."""

import os
import json
import subprocess
from typing import List, Dict, Any, Optional
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
                    'admin_roles': user.get('adminRoles', []),
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

    def set_super_admin_status(self, email: str, is_super_admin: bool) -> Dict[str, Any]:
        """Set or remove super_admin role for a user."""
        try:
            if is_super_admin:
                # Add super_admin to adminRoles and ensure isAdmin is true
                result = self.users_collection.update_one(
                    {'email': email},
                    {
                        '$set': {'isAdmin': True},
                        '$addToSet': {'adminRoles': 'super_admin'}
                    }
                )
            else:
                # Remove super_admin from adminRoles
                result = self.users_collection.update_one(
                    {'email': email},
                    {'$pull': {'adminRoles': 'super_admin'}}
                )

            if result.matched_count:
                logger.info(f"Updated super_admin status for {email}: {is_super_admin}")
                return {'success': True, 'email': email, 'is_super_admin': is_super_admin}
            else:
                return {'success': False, 'error': 'User not found'}

        except Exception as e:
            logger.error(f"Failed to update super_admin status for {email}: {e}")
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
                    'admin_roles': user.get('adminRoles', []),
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
    def list_reviews(self, limit: int = 200) -> List[Dict[str, Any]]:
        """List the compliance reviews stored by the LLM module.

        The module writes one document per finished review into
        `llmComplianceReports`. The heavy part of a report is the `result` field,
        which is deliberately left out here: the tally, the model and the rubric are
        kept at the top level of the document precisely so that a listing does not
        have to load every report body.

        REVIEWS THAT FAILED ARE IN THIS COLLECTION TOO, marked `failed: true` with an
        `errorCode` and carrying no `counts` field at all. They are listed, because a
        review that never finished is often the only trace that somebody tried, but
        they must never read as clean ones: `ok`/`partial`/`missing` come back as None
        for them rather than as zeros, so the template renders a dash and a badge
        instead of a row that looks like a thesis with no findings against it.

        Returns an empty list when the collection does not exist yet, which is the
        normal state until the first review is run.
        """
        try:
            cursor = (
                self.db.llmComplianceReports.find(
                    {},
                    # The report body AND its archived HTML copy stay out of the
                    # listing: both are heavy, and htmlBytes is kept at the top
                    # level precisely so a row can say "there is an HTML copy"
                    # without weighing anything.
                    {'result': 0, 'html': 0},
                )
                .sort('createdAt', -1)
                .limit(limit)
            )

            reviews = []
            user_cache: Dict[str, str] = {}
            project_cache: Dict[str, str] = {}

            for doc in cursor:
                user_id = str(doc.get('userId') or '')
                if user_id and user_id not in user_cache:
                    try:
                        user = self.users_collection.find_one(
                            {'_id': ObjectId(user_id)}, {'email': 1}
                        )
                        user_cache[user_id] = user.get('email', 'Unknown') if user else 'Unknown'
                    except Exception:
                        user_cache[user_id] = 'Unknown'

                project_id = str(doc.get('projectId') or '')
                if project_id and project_id not in project_cache:
                    try:
                        project = self.db.projects.find_one(
                            {'_id': ObjectId(project_id)}, {'name': 1}
                        )
                        project_cache[project_id] = (
                            project.get('name', 'Untitled') if project else 'Deleted project'
                        )
                    except Exception:
                        project_cache[project_id] = 'Unknown'

                failed = bool(doc.get('failed'))
                counts = doc.get('counts') or {}
                delta = doc.get('delta') or {}
                duration_ms = doc.get('durationMs')

                # A failed review has no verdicts, so it gets no numbers. Reading the
                # tally with `.get(key, 0)` would turn "this review never ran" into
                # "0 ok, 0 partial, 0 missing", which in the table below is exactly
                # what a flawless thesis looks like. None renders as a dash.
                reviews.append({
                    'id': str(doc.get('_id')),
                    'created_at': self._convert_to_local_time(doc.get('createdAt')),
                    'finished_at': self._convert_to_local_time(doc.get('finishedAt')),
                    'user_email': user_cache.get(user_id, 'Unknown'),
                    'project_id': project_id,
                    'project_name': project_cache.get(project_id, 'Unknown'),
                    'rubric_name': doc.get('rubricName', ''),
                    'model': doc.get('model', ''),
                    'failed': failed,
                    'error_code': doc.get('errorCode') if failed else None,
                    'ok': None if failed else counts.get('ok', 0),
                    'partial': None if failed else counts.get('partial', 0),
                    'missing': None if failed else counts.get('missing', 0),
                    'na': None if failed else counts.get('na', 0),
                    'duration_min': round(duration_ms / 60000) if duration_ms else None,
                    # True when the store archived the student-facing HTML copy.
                    # Reports written before that feature have only the JSON.
                    'has_html': bool(doc.get('htmlBytes')),
                    # A delta compares verdicts, so a review with none has nothing to
                    # compare. The module never computes one for a failure either.
                    'resolved': None if failed else (
                        len(delta.get('resolved') or []) if delta.get('comparable') else None
                    ),
                    'regressed': None if failed else (
                        len(delta.get('regressed') or []) if delta.get('comparable') else None
                    ),
                })

            return reviews
        except Exception as e:
            logger.error(f"Failed to list compliance reviews: {e}")
            return []

    def _review_jsonable(self, value):
        """Flatten Mongo types to plain JSON, recursively.

        The download exists to build a HISTORY somebody can diff and analyse
        outside this dashboard, so the file must be readable by any tool: an
        ObjectId or a datetime that json.dumps cannot serialise would make the
        whole export depend on bson being installed wherever it is opened.
        """
        if isinstance(value, dict):
            return {key: self._review_jsonable(inner) for key, inner in value.items()}
        if isinstance(value, list):
            return [self._review_jsonable(inner) for inner in value]
        if isinstance(value, ObjectId):
            return str(value)
        if isinstance(value, datetime):
            return value.isoformat()
        return value

    def get_review_document(self, review_id: str) -> Optional[Dict[str, Any]]:
        """One stored review, whole: the full report body included.

        This is what the dashboard's JSON download serves. list_reviews
        deliberately leaves the `result` field out because a listing must stay
        light; here the body IS the point, so the document comes back complete,
        with the user email and project name resolved the way the listing
        resolves them (the raw ids alone would make the archive unreadable a
        year later, when the project may be deleted and the id resolves to
        nothing). The archived HTML copy is NOT here: it has its own download,
        and inlining fifty KB of markup into every JSON would pollute exactly
        the file this endpoint exists to keep analysable.
        """
        try:
            doc = self.db.llmComplianceReports.find_one(
                {'_id': ObjectId(review_id)}, {'html': 0}
            )
        except Exception as e:
            logger.error(f"Failed to load review {review_id}: {e}")
            return None
        if not doc:
            return None
        return self._decorated_review(doc)

    def get_review_html(self, review_id: str) -> Optional[Dict[str, Any]]:
        """The archived student-facing HTML report of one review, plus the bits
        the route needs for a file name. None when the review predates the
        archiving feature (only the JSON exists for those)."""
        try:
            doc = self.db.llmComplianceReports.find_one(
                {'_id': ObjectId(review_id)},
                {'html': 1, 'projectId': 1, 'finishedAt': 1, 'createdAt': 1},
            )
        except Exception as e:
            logger.error(f"Failed to load review html {review_id}: {e}")
            return None
        if not doc or not doc.get('html'):
            return None
        return self._decorated_review(doc)

    def _decorated_review(self, doc: Dict[str, Any]) -> Dict[str, Any]:
        """The stored document plus the resolved names, flattened for JSON."""
        out = self._review_jsonable(doc)
        try:
            user = self.users_collection.find_one(
                {'_id': ObjectId(str(doc.get('userId') or ''))}, {'email': 1}
            )
            out['userEmail'] = user.get('email', 'Unknown') if user else 'Unknown'
        except Exception:
            out['userEmail'] = 'Unknown'
        try:
            project = self.db.projects.find_one(
                {'_id': ObjectId(str(doc.get('projectId') or ''))}, {'name': 1}
            )
            out['projectName'] = project.get('name', 'Untitled') if project else 'Deleted project'
        except Exception:
            out['projectName'] = 'Unknown'
        return out

    def iter_review_documents(self):
        """Every stored review, oldest first, one document at a time.

        A generator on purpose: the report bodies are the heavy part, and the
        bulk export must not hold every one of them in memory at once. Oldest
        first, so an export appended to a previous one keeps a stable order.
        """
        try:
            # Same shape as the single JSON download: data only, the HTML copy is
            # derivable from `result` and would triple the archive for nothing.
            cursor = self.db.llmComplianceReports.find({}, {'html': 0}).sort('createdAt', 1)
            for doc in cursor:
                yield self._decorated_review(doc)
        except Exception as e:
            logger.error(f"Failed to iterate compliance reviews: {e}")
            return

    def get_review_stats(self) -> Dict[str, Any]:
        """Totals for the dashboard cards: reviews stored, and how many in the last week.

        `total` and `last_week` count reviews that actually produced a report. Failed
        ones live in the same collection (see list_reviews) and are counted separately
        rather than folded in: "128 reviews" has to mean 128 reports somebody can open,
        or the card quietly overstates how much marking the tool has really done. The
        failures are reported as their own number instead of being hidden, because a
        rising count there is the signal that the backend is unhealthy.
        """
        try:
            from datetime import timedelta
            week_ago = datetime.now(timezone.utc) - timedelta(days=7)
            done_only = {'failed': {'$ne': True}}
            return {
                'total': self.db.llmComplianceReports.count_documents(done_only),
                'last_week': self.db.llmComplianceReports.count_documents(
                    {**done_only, 'createdAt': {'$gte': week_ago}}
                ),
                'failed': self.db.llmComplianceReports.count_documents({'failed': True}),
                'failed_last_week': self.db.llmComplianceReports.count_documents(
                    {'failed': True, 'createdAt': {'$gte': week_ago}}
                ),
            }
        except Exception as e:
            logger.error(f"Failed to count compliance reviews: {e}")
            return {'total': 0, 'last_week': 0, 'failed': 0, 'failed_last_week': 0}

    def list_pending_reviews(self) -> List[Dict[str, Any]]:
        """Reviews that are queued or running right now.

        The LLM module writes a document into `llmComplianceJobs` when a review is
        enqueued and deletes it when the review ends, whatever the outcome, so
        whatever is left in there is work still owed. `abandoned` entries are the
        ones that were resumed too many times without ever finishing and are shown
        too, because they are the only trace left of a review that kept failing.
        """
        try:
            cursor = self.db.llmComplianceJobs.find(
                {'status': {'$in': ['queued', 'running', 'abandoned']}}
            ).sort('createdAt', 1)

            pending = []
            for doc in cursor:
                user_email = 'Unknown'
                try:
                    user = self.users_collection.find_one(
                        {'_id': ObjectId(str(doc.get('userId')))}, {'email': 1}
                    )
                    if user:
                        user_email = user.get('email', 'Unknown')
                except Exception:
                    pass

                project_name = 'Unknown'
                try:
                    project = self.db.projects.find_one(
                        {'_id': ObjectId(str(doc.get('projectId')))}, {'name': 1}
                    )
                    if project:
                        project_name = project.get('name', 'Untitled')
                except Exception:
                    pass

                passes_done = doc.get('passesDone') or 0
                passes_total = doc.get('passesTotal') or 0

                pending.append({
                    'job_id': doc.get('jobId'),
                    'status': doc.get('status'),
                    'user_email': user_email,
                    'project_name': project_name,
                    'rubric_name': doc.get('rubricName', ''),
                    'created_at': self._convert_to_local_time(doc.get('createdAt')),
                    'passes_done': passes_done,
                    'passes_total': passes_total,
                    'percent': round(100 * passes_done / passes_total) if passes_total else None,
                    'current_requirement': doc.get('currentRequirement', ''),
                    'attempts': doc.get('attempts', 0),
                })

            return pending
        except Exception as e:
            logger.error(f"Failed to list pending reviews: {e}")
            return []

    def get_pending_review_count(self) -> int:
        """How many reviews are queued or running, for the dashboard card."""
        try:
            return self.db.llmComplianceJobs.count_documents(
                {'status': {'$in': ['queued', 'running']}}
            )
        except Exception as e:
            logger.error(f"Failed to count pending reviews: {e}")
            return 0
