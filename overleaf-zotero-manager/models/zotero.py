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
                        
                        # Get container status
                        status = self._get_container_status(service_name)
                        
                        proxies.append({
                            'username': username,
                            'container_name': service_name,
                            'api_key': api_key,
                            'user_id': user_id,
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
    
    def add_proxy(self, username: str, api_key: str, user_id: str) -> Dict[str, Any]:
        """Add a new Zotero proxy."""
        try:
            # Validate username
            username = username.lower().strip()
            if not re.match(r'^[a-z0-9-]+$', username):
                return {'success': False, 'error': 'Invalid username format'}
            
            # Check if proxy already exists
            existing_proxies = self.list_proxies()
            if any(p['username'] == username for p in existing_proxies):
                return {'success': False, 'error': 'Proxy already exists'}
            
            # VALIDATE ZOTERO CREDENTIALS
            logger.info(f"Validating Zotero credentials for user: {username}")
            import requests
            test_url = f'https://api.zotero.org/users/{user_id}/items?limit=1'
            headers = {'Zotero-API-Key': api_key}
            
            try:
                response = requests.get(test_url, headers=headers, timeout=10)
                if response.status_code == 403:
                    return {'success': False, 'error': 'Invalid API Key or User ID. Please check your Zotero credentials and try again.'}
                elif response.status_code == 404:
                    return {'success': False, 'error': 'Invalid User ID. Please verify your Zotero User ID from https://www.zotero.org/settings/keys'}
                elif response.status_code != 200:
                    return {'success': False, 'error': f'Unable to validate Zotero credentials (Error {response.status_code}). Please check your API Key and User ID.'}
                logger.info(f"Zotero credentials validated successfully for user: {username}")
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
            self._update_docker_compose_add(username, next_port)
            
            # Update .env file
            self._update_env_file_add(username, api_key, user_id)
            
            # Start the new container
            self._docker_compose_up(username)

            logger.info(f"Added proxy for user: {username}")
            return {
                'success': True,
                'username': username,
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
    
    def update_proxy(self, username: str, api_key: str, user_id: str) -> Dict[str, Any]:
        """Update Zotero proxy credentials."""
        try:
            # Update .env file
            self._update_env_file_update(username, api_key, user_id)

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
    
    def _update_docker_compose_add(self, username: str, port: int):
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

        # Convert username to env var format (hyphens → underscore)
        env_name = username.upper().replace('-', '_')

        service_name = f'zotero-{username}'
        config['services'][service_name] = {
            'image': self.proxy_image,
            'container_name': service_name,
            'environment': [
                f'ZOTERO_USER=${{{env_name}_USER_ID}}',
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

    def _update_env_file_add(self, username: str, api_key: str, user_id: str):
        """Add credentials to .env file."""
        # Convert username to env var format (hyphens → underscore)
        env_name = username.upper().replace('-', '_')
        
        with open(self.env_file, 'a') as f:
            f.write(f'\n{env_name}_API_KEY={api_key}\n')
            f.write(f'{env_name}_USER_ID={user_id}\n')
    
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
        ]
        
        with open(self.env_file, 'w') as f:
            f.writelines(new_lines)
    
    def _update_env_file_update(self, username: str, api_key: str, user_id: str):
        """Update credentials in .env file."""
        self._update_env_file_remove(username)
        self._update_env_file_add(username, api_key, user_id)
    
    def _docker_compose_up(self, username: str):
        """Start a specific container."""
        result = subprocess.run(
            ['docker-compose', '-f', str(self.docker_compose_file), 'up', '-d', f'zotero-{username}'],
            capture_output=True,
            text=True
        )
        if result.returncode != 0:
            logger.error(f"Docker compose error: {result.stderr}")
            raise Exception(f"Docker compose failed: {result.stderr}")
    
    def _stop_container(self, container_name: str):
        """Stop and remove a container."""
        subprocess.run(['docker', 'stop', container_name], capture_output=True)
        subprocess.run(['docker', 'rm', container_name], capture_output=True)
    
    def _restart_container(self, container_name: str):
        """Restart a container."""
        subprocess.run(['docker', 'restart', container_name], check=True)