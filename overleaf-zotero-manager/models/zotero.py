"""Zotero proxy management module."""

import os
import yaml
import subprocess
from datetime import datetime
from typing import List, Dict, Any
import logging
import re
from pathlib import Path

logger = logging.getLogger(__name__)

class ZoteroProxyManager:
    """Manage Zotero proxy configurations and Docker containers."""
    
    def __init__(self, proxies_path: str, proxy_image: str):
        """Initialize the Zotero proxy manager."""
        self.proxies_path = Path(proxies_path)
        self.proxy_image = proxy_image
        self.docker_compose_file = self.proxies_path / 'docker-compose.yml'
        self.env_file = self.proxies_path / '.env'
        
    def check_docker(self) -> bool:
        """Check if Docker is running."""
        try:
            result = subprocess.run(
                ['docker', 'info'],
                capture_output=True,
                text=True,
                timeout=5
            )
            return result.returncode == 0
        except Exception as e:
            logger.error(f"Docker check failed: {e}")
            return False
    
    def list_proxies(self) -> List[Dict[str, Any]]:
        """List all configured Zotero proxies."""
        try:
            proxies = []
            
            # Read docker-compose.yml to get configured proxies
            if self.docker_compose_file.exists():
                with open(self.docker_compose_file, 'r') as f:
                    compose_config = yaml.safe_load(f)

                # Ensure compose_config is valid
                if compose_config is None:
                    compose_config = {}

                services = compose_config.get('services', {})
                # YAML may parse 'services:' with only comments as None
                if services is None:
                    services = {}

                # Read .env file for credentials
                env_vars = {}
                if self.env_file.exists():
                    with open(self.env_file, 'r') as f:
                        for line in f:
                            if '=' in line:
                                key, value = line.strip().split('=', 1)
                                env_vars[key] = value

                # Extract proxy information
                for service_name, service_config in services.items():
                    if service_name.startswith('zotero-'):
                        username = service_name.replace('zotero-', '')
                        
                        # Convert username to env var format (hyphens → underscore)
                        env_name = username.upper().replace('-', '_')
                        
                        # Get credentials from env vars
                        api_key = env_vars.get(f'{env_name}_API_KEY', '')
                        user_id = env_vars.get(f'{env_name}_USER_ID', '')
                        entity_type = env_vars.get(f'{env_name}_ENTITY_TYPE', 'user')

                        # Also detect entity_type from docker-compose environment
                        env_list = service_config.get('environment', [])
                        for env_entry in env_list:
                            if isinstance(env_entry, str) and env_entry.startswith('ZOTERO_GROUP='):
                                entity_type = 'group'
                                break

                        # Get container status
                        status = self._get_container_status(service_name)

                        proxies.append({
                            'username': username,
                            'container_name': service_name,
                            'api_key': api_key,
                            'user_id': user_id,
                            'entity_type': entity_type,
                            'internal_url': f'http://zotero-{username}:5000',
                            'status': status,
                            'port': self._extract_port(service_config)
                        })
            
            return proxies
            
        except Exception as e:
            logger.error(f"Failed to list proxies: {e}")
            return []
    
    def get_proxy_count(self) -> int:
        """Get the total number of configured proxies."""
        try:
            proxies = self.list_proxies()
            return len(proxies)
        except Exception:
            return 0
    
    def add_proxy(self, username: str, api_key: str, user_id: str, entity_type: str = 'user') -> Dict[str, Any]:
        """Add a new Zotero proxy.

        Args:
            entity_type: 'user' for personal libraries, 'group' for group libraries.
        """
        try:
            # Validate username
            username = username.lower().strip()
            if not re.match(r'^[a-z0-9-]+$', username):
                return {'success': False, 'error': 'Invalid username format'}

            # Validate entity_type
            if entity_type not in ('user', 'group'):
                return {'success': False, 'error': 'Invalid entity type. Must be "user" or "group".'}

            # Check if proxy already exists
            existing_proxies = self.list_proxies()
            if any(p['username'] == username for p in existing_proxies):
                return {'success': False, 'error': 'Proxy already exists'}

            # VALIDATE ZOTERO CREDENTIALS
            entity_label = 'Group' if entity_type == 'group' else 'User'
            logger.info(f"Validating Zotero credentials for {entity_label.lower()}: {username}")
            import requests

            try:
                headers = {'Zotero-API-Key': api_key}

                # Step 1: Verify the API key is valid
                key_url = 'https://api.zotero.org/keys/current'
                key_response = requests.get(key_url, headers=headers, timeout=10)

                if key_response.status_code == 403:
                    return {'success': False, 'error': 'Invalid API Key. Please check your Zotero API key and try again.'}
                elif key_response.status_code != 200:
                    return {'success': False, 'error': f'Unable to validate API Key (Error {key_response.status_code}).'}

                key_info = key_response.json()
                key_user_id = str(key_info.get('userID', ''))
                logger.info(f"API key is valid, belongs to user {key_user_id}")

                # Step 2: For personal libraries, auto-detect user_id from API key
                if entity_type != 'group':
                    # Auto-fill user_id from API key owner
                    if not user_id or user_id != key_user_id:
                        logger.info(f"Auto-detected User ID: {key_user_id}")
                        user_id = key_user_id

                # Step 3: Verify the library exists and is accessible
                if entity_type == 'group':
                    # Fetch group info to verify:
                    # 1. The group exists
                    # 2. The user (API key owner) is a member of the group
                    group_url = f'https://api.zotero.org/groups/{user_id}'
                    group_response = requests.get(group_url, headers=headers, timeout=10)

                    logger.info(f"Group check: {group_url} -> {group_response.status_code}")

                    if group_response.status_code == 404:
                        return {'success': False, 'error': f'Group ID {user_id} does not exist. Please check the Group ID.'}
                    elif group_response.status_code == 403:
                        return {'success': False, 'error': f'Access denied to Group ID {user_id}. Make sure you have read access to this group.'}
                    elif group_response.status_code != 200:
                        return {'success': False, 'error': f'Unable to verify Group ID {user_id} (Error {group_response.status_code}).'}

                    # Parse group info and verify membership
                    try:
                        group_data = group_response.json()
                        group_info = group_data.get('data', {})
                        group_name = group_info.get('name')

                        if not group_name:
                            return {'success': False, 'error': f'Invalid response for Group ID {user_id}.'}

                        # Check if user is owner, admin, or member of the group
                        owner_id = group_info.get('owner')
                        admins = group_info.get('admins', [])
                        members = group_info.get('members', [])

                        # Convert key_user_id to int for comparison
                        user_id_int = int(key_user_id)

                        is_member = (
                            owner_id == user_id_int or
                            user_id_int in admins or
                            user_id_int in members
                        )

                        logger.info(f"Group '{group_name}': owner={owner_id}, admins={admins}, members={members}")
                        logger.info(f"User {key_user_id} is_member: {is_member}")

                        if not is_member:
                            return {'success': False, 'error': f'You are not a member of group "{group_name}" (ID: {user_id}). You must be an owner, admin, or member of this group to add it.'}

                        logger.info(f"Group validated: '{group_name}' (ID: {user_id}) - user {key_user_id} is a member")
                    except ValueError as e:
                        logger.error(f"Failed to convert user ID: {e}")
                        return {'success': False, 'error': f'Invalid user ID format.'}
                    except Exception as e:
                        logger.error(f"Failed to parse group data: {e}")
                        return {'success': False, 'error': f'Invalid group data for Group ID {user_id}.'}
                else:
                    # For personal libraries, verify access
                    test_url = f'https://api.zotero.org/users/{user_id}/items?limit=1'
                    response = requests.get(test_url, headers=headers, timeout=10)

                    logger.info(f"Personal library check: {test_url} -> {response.status_code}")

                    if response.status_code == 403:
                        return {'success': False, 'error': f'Access denied. Your API key does not have permission to read your personal library.'}
                    elif response.status_code == 404:
                        return {'success': False, 'error': f'User ID {user_id} does not exist.'}
                    elif response.status_code != 200:
                        return {'success': False, 'error': f'Unable to access personal library (Error {response.status_code}).'}

                logger.info(f"Zotero credentials validated successfully for {entity_label.lower()}: {username}")
            except requests.exceptions.Timeout:
                return {'success': False, 'error': 'Connection timeout while validating credentials. Please try again in a moment.'}
            except requests.exceptions.RequestException as e:
                return {'success': False, 'error': f'Could not connect to Zotero. Please check your internet connection and try again.'}

            # Find next available port
            used_ports = [p['port'] for p in existing_proxies if p['port']]
            next_port = 8091
            while next_port in used_ports:
                next_port += 1

            # Update docker-compose.yml
            self._update_docker_compose_add(username, next_port, entity_type)

            # Update .env file
            self._update_env_file_add(username, api_key, user_id, entity_type)

            # Start the new container
            self._docker_compose_up(username)

            logger.info(f"Added proxy for {entity_label.lower()}: {username}")
            return {
                'success': True,
                'username': username,
                'entity_type': entity_type,
                'internal_url': f'http://zotero-{username}:5000',
                'port': next_port
            }
            
        except Exception as e:
            import traceback
            logger.error(f"Failed to add proxy for {username}: {e}")
            logger.error(f"Traceback: {traceback.format_exc()}")
            return {'success': False, 'error': str(e)}
    
    def remove_proxy(self, username: str) -> Dict[str, Any]:
        """Remove a Zotero proxy."""
        try:
            # Stop and remove container
            self._stop_container(f'zotero-{username}')
            
            # Update docker-compose.yml
            self._update_docker_compose_remove(username)

            # Update .env file
            self._update_env_file_remove(username)

            logger.info(f"Removed proxy for user: {username}")
            return {'success': True, 'message': f'Proxy for {username} removed'}
            
        except Exception as e:
            logger.error(f"Failed to remove proxy for {username}: {e}")
            return {'success': False, 'error': str(e)}
    
    def update_proxy(self, username: str, api_key: str, user_id: str, entity_type: str = None) -> Dict[str, Any]:
        """Update Zotero proxy credentials."""
        try:
            # If entity_type not provided, get from existing proxy
            if entity_type is None:
                existing = [p for p in self.list_proxies() if p['username'] == username]
                entity_type = existing[0]['entity_type'] if existing else 'user'

            # Update .env file
            self._update_env_file_update(username, api_key, user_id, entity_type)

            # Restart the container
            self._restart_container(f'zotero-{username}')

            logger.info(f"Updated proxy for user: {username}")
            return {'success': True, 'message': f'Proxy for {username} updated'}

        except Exception as e:
            logger.error(f"Failed to update proxy for {username}: {e}")
            return {'success': False, 'error': str(e)}

    # Private helper methods
    def _get_container_status(self, container_name: str) -> str:
        """Get the status of a Docker container."""
        try:
            result = subprocess.run(
                ['docker', 'inspect', container_name, '--format', '{{.State.Status}}'],
                capture_output=True,
                text=True,
                timeout=5
            )
            if result.returncode == 0:
                return result.stdout.strip()
            return 'not found'
        except Exception:
            return 'unknown'
    
    def _extract_port(self, service_config: dict) -> int:
        """Extract port from service configuration."""
        try:
            ports = service_config.get('ports', [])
            if ports:
                port_mapping = ports[0]
                if ':' in port_mapping:
                    return int(port_mapping.split(':')[0])
            return None
        except Exception:
            return None
    
    def _update_docker_compose_add(self, username: str, port: int, entity_type: str = 'user'):
        """Add service to docker-compose.yml."""
        with open(self.docker_compose_file, 'r') as f:
            config = yaml.safe_load(f)

        # Ensure config is valid
        if config is None:
            config = {}
        if 'services' not in config:
            config['services'] = {}
        # YAML may parse 'services:' with only comments as None
        if config['services'] is None:
            config['services'] = {}

        # Ensure networks section exists (external network for Overleaf)
        if 'networks' not in config:
            config['networks'] = {'overleaf_default': {'external': True}}

        # Convert username to env var format (hyphens → underscore)
        env_name = username.upper().replace('-', '_')

        # Use ZOTERO_GROUP for group libraries, ZOTERO_USER for personal libraries
        if entity_type == 'group':
            id_env_var = f'ZOTERO_GROUP=${{{env_name}_USER_ID}}'
        else:
            id_env_var = f'ZOTERO_USER=${{{env_name}_USER_ID}}'

        service_name = f'zotero-{username}'
        config['services'][service_name] = {
            'image': self.proxy_image,
            'container_name': service_name,
            'environment': [
                id_env_var,
                f'ZOTERO_KEY=${{{env_name}_API_KEY}}',
                'ZOTERO_INCLUSION_STRATEGY=all',
                'ZOTERO_FORMAT=bibtex'
            ],
            'ports': [f'{port}:5000'],
            'restart': 'unless-stopped',
            'networks': ['overleaf_default']
        }
        
        with open(self.docker_compose_file, 'w') as f:
            yaml.dump(config, f, default_flow_style=False, sort_keys=False)
    
    def _update_docker_compose_remove(self, username: str):
        """Remove service from docker-compose.yml."""
        with open(self.docker_compose_file, 'r') as f:
            config = yaml.safe_load(f)

        # Ensure config is valid
        if config is None or 'services' not in config:
            return

        service_name = f'zotero-{username}'
        if service_name in config['services']:
            del config['services'][service_name]
        
        with open(self.docker_compose_file, 'w') as f:
            yaml.dump(config, f, default_flow_style=False, sort_keys=False)

    def _update_env_file_add(self, username: str, api_key: str, user_id: str, entity_type: str = 'user'):
        """Add credentials to .env file."""
        # Convert username to env var format (hyphens → underscore)
        env_name = username.upper().replace('-', '_')

        with open(self.env_file, 'a') as f:
            f.write(f'\n{env_name}_API_KEY={api_key}\n')
            f.write(f'{env_name}_USER_ID={user_id}\n')
            f.write(f'{env_name}_ENTITY_TYPE={entity_type}\n')
    
    def _update_env_file_remove(self, username: str):
        """Remove credentials from .env file."""
        # Convert username to env var format (hyphens → underscore)
        env_name = username.upper().replace('-', '_')
        
        with open(self.env_file, 'r') as f:
            lines = f.readlines()
        
        new_lines = [
            line for line in lines
            if not line.startswith(f'{env_name}_API_KEY=')
            and not line.startswith(f'{env_name}_USER_ID=')
            and not line.startswith(f'{env_name}_ENTITY_TYPE=')
        ]
        
        with open(self.env_file, 'w') as f:
            f.writelines(new_lines)
    
    def _update_env_file_update(self, username: str, api_key: str, user_id: str, entity_type: str = 'user'):
        """Update credentials in .env file."""
        self._update_env_file_remove(username)
        self._update_env_file_add(username, api_key, user_id, entity_type)
    
    def _docker_compose_up(self, username: str):
        """Start a specific container."""
        # Try docker compose (v2) first, then docker-compose (v1)
        commands = [
            ['docker', 'compose', '-f', str(self.docker_compose_file), 'up', '-d', f'zotero-{username}'],
            ['docker-compose', '-f', str(self.docker_compose_file), 'up', '-d', f'zotero-{username}']
        ]

        for cmd in commands:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                cwd=str(self.proxies_path)
            )
            if result.returncode == 0:
                return
            # If command not found, try next
            if 'not found' not in result.stderr.lower() and 'unknown' not in result.stderr.lower():
                logger.error(f"Docker compose error: {result.stderr}")
                raise Exception(f"Docker compose failed: {result.stderr}")

        raise Exception("Docker Compose not available (tried docker compose and docker-compose)")
    
    def _stop_container(self, container_name: str):
        """Stop and remove a container."""
        subprocess.run(['docker', 'stop', container_name], capture_output=True)
        subprocess.run(['docker', 'rm', container_name], capture_output=True)
    
    def _restart_container(self, container_name: str):
        """Restart a container."""
        subprocess.run(['docker', 'restart', container_name], check=True)