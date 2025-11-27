# Makefile for Overleaf-Zotero Manager

.PHONY: help install dev run test clean backup docker-build docker-run docker-stop

# Variables
PYTHON := python3
PIP := pip3
VENV := venv
APP := app.py
PORT := 5000

# Colors for output
RED := \033[0;31m
GREEN := \033[0;32m
YELLOW := \033[1;33m
NC := \033[0m # No Color

help: ## Show this help message
	@echo "$(GREEN)Overleaf-Zotero Manager - Available Commands$(NC)"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(YELLOW)%-15s$(NC) %s\n", $$1, $$2}'
	@echo ""

install: ## Install production dependencies
	@echo "$(GREEN)Installing dependencies...$(NC)"
	$(PYTHON) -m venv $(VENV)
	./$(VENV)/bin/pip install --upgrade pip
	./$(VENV)/bin/pip install -r requirements.txt
	@echo "$(GREEN)Creating necessary directories...$(NC)"
	mkdir -p backups logs static/css static/js templates models
	@echo "$(GREEN)Installation complete!$(NC)"
	@echo "$(YELLOW)Don't forget to copy .env.example to .env and configure it!$(NC)"

dev: ## Install development dependencies
	@echo "$(GREEN)Installing development dependencies...$(NC)"
	$(PYTHON) -m venv $(VENV)
	./$(VENV)/bin/pip install --upgrade pip
	./$(VENV)/bin/pip install -r requirements.txt
	./$(VENV)/bin/pip install pytest pytest-cov black flake8
	@echo "$(GREEN)Development environment ready!$(NC)"

run: ## Run the application in development mode
	@echo "$(GREEN)Starting Overleaf-Zotero Manager...$(NC)"
	@if [ ! -f .env ]; then \
		echo "$(RED)Error: .env file not found!$(NC)"; \
		echo "$(YELLOW)Please copy .env.example to .env and configure it.$(NC)"; \
		exit 1; \
	fi
	./$(VENV)/bin/python $(APP)

run-prod: ## Run the application in production mode with gunicorn
	@echo "$(GREEN)Starting Overleaf-Zotero Manager (Production)...$(NC)"
	@if [ ! -f .env ]; then \
		echo "$(RED)Error: .env file not found!$(NC)"; \
		exit 1; \
	fi
	./$(VENV)/bin/gunicorn -w 4 -b 0.0.0.0:$(PORT) --access-logfile logs/access.log --error-logfile logs/error.log app:app

test: ## Run tests
	@echo "$(GREEN)Running tests...$(NC)"
	./$(VENV)/bin/pytest tests/ -v --cov=.

lint: ## Run code linting
	@echo "$(GREEN)Running linting...$(NC)"
	./$(VENV)/bin/flake8 . --exclude=$(VENV),__pycache__
	./$(VENV)/bin/black --check .

format: ## Format code with black
	@echo "$(GREEN)Formatting code...$(NC)"
	./$(VENV)/bin/black .

clean: ## Clean temporary files
	@echo "$(GREEN)Cleaning temporary files...$(NC)"
	find . -type f -name '*.pyc' -delete
	find . -type d -name '__pycache__' -delete
	find . -type f -name '*.log' -delete
	rm -rf .pytest_cache
	rm -rf htmlcov
	rm -rf .coverage
	@echo "$(GREEN)Cleanup complete!$(NC)"

backup: ## Create a backup of configurations
	@echo "$(GREEN)Creating backup...$(NC)"
	timestamp=$$(date +%Y%m%d_%H%M%S); \
	mkdir -p backups; \
	tar -czf backups/config_backup_$$timestamp.tar.gz .env *.py models/ templates/ static/ requirements.txt
	@echo "$(GREEN)Backup created in backups/ directory$(NC)"

docker-build: ## Build Docker image
	@echo "$(GREEN)Building Docker image...$(NC)"
	docker build -t overleaf-zotero-manager .
	@echo "$(GREEN)Docker image built successfully!$(NC)"

docker-run: ## Run application in Docker
	@echo "$(GREEN)Starting Docker container...$(NC)"
	docker-compose up -d
	@echo "$(GREEN)Container started! Access at http://localhost:$(PORT)$(NC)"

docker-stop: ## Stop Docker container
	@echo "$(YELLOW)Stopping Docker container...$(NC)"
	docker-compose down
	@echo "$(GREEN)Container stopped!$(NC)"

docker-logs: ## Show Docker container logs
	docker-compose logs -f

setup-systemd: ## Setup systemd service (requires sudo)
	@echo "$(GREEN)Setting up systemd service...$(NC)"
	@echo "[Unit]" | sudo tee /etc/systemd/system/overleaf-zotero-manager.service
	@echo "Description=Overleaf-Zotero Manager" | sudo tee -a /etc/systemd/system/overleaf-zotero-manager.service
	@echo "After=network.target" | sudo tee -a /etc/systemd/system/overleaf-zotero-manager.service
	@echo "" | sudo tee -a /etc/systemd/system/overleaf-zotero-manager.service
	@echo "[Service]" | sudo tee -a /etc/systemd/system/overleaf-zotero-manager.service
	@echo "Type=simple" | sudo tee -a /etc/systemd/system/overleaf-zotero-manager.service
	@echo "User=$$USER" | sudo tee -a /etc/systemd/system/overleaf-zotero-manager.service
	@echo "WorkingDirectory=$$(pwd)" | sudo tee -a /etc/systemd/system/overleaf-zotero-manager.service
	@echo "ExecStart=$$(pwd)/$(VENV)/bin/gunicorn -w 4 -b 0.0.0.0:$(PORT) app:app" | sudo tee -a /etc/systemd/system/overleaf-zotero-manager.service
	@echo "Restart=always" | sudo tee -a /etc/systemd/system/overleaf-zotero-manager.service
	@echo "" | sudo tee -a /etc/systemd/system/overleaf-zotero-manager.service
	@echo "[Install]" | sudo tee -a /etc/systemd/system/overleaf-zotero-manager.service
	@echo "WantedBy=multi-user.target" | sudo tee -a /etc/systemd/system/overleaf-zotero-manager.service
	sudo systemctl daemon-reload
	@echo "$(GREEN)Systemd service created!$(NC)"
	@echo "$(YELLOW)To enable: sudo systemctl enable overleaf-zotero-manager$(NC)"
	@echo "$(YELLOW)To start: sudo systemctl start overleaf-zotero-manager$(NC)"

check-env: ## Check if environment is properly configured
	@echo "$(GREEN)Checking environment configuration...$(NC)"
	@if [ -f .env ]; then \
		echo "✓ .env file exists"; \
	else \
		echo "✗ .env file missing"; \
	fi
	@if [ -d $(VENV) ]; then \
		echo "✓ Virtual environment exists"; \
	else \
		echo "✗ Virtual environment missing (run 'make install')"; \
	fi
	@if [ -d logs ]; then \
		echo "✓ Logs directory exists"; \
	else \
		echo "✗ Logs directory missing"; \
	fi
	@if [ -d backups ]; then \
		echo "✓ Backups directory exists"; \
	else \
		echo "✗ Backups directory missing"; \
	fi
