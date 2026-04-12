FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    nginx \
    docker.io \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*


# Installa docker-compose
RUN curl -L "https://github.com/docker/compose/releases/download/v2.24.0/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose \
    && chmod +x /usr/local/bin/docker-compose


# Copy requirements first for better caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY . .

# Create necessary directories
RUN mkdir -p logs

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV FLASK_APP=app.py

# Default port (can be overridden via FLASK_PORT env variable)
ENV FLASK_PORT=5000
EXPOSE ${FLASK_PORT}

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${FLASK_PORT}/api/system/status || exit 1

# Run the application
CMD sh -c "gunicorn -w 4 -b 0.0.0.0:${FLASK_PORT} --access-logfile logs/access.log --error-logfile logs/error.log app:app"
