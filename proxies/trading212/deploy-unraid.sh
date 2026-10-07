#!/bin/bash
# One-liner deployment script for Unraid NAS
# Usage: bash deploy-unraid.sh <unraid-ip> [port]

set -e

UNRAID_IP="${1:-localhost}"
PORT="${2:-8000}"
APPDATA_PATH="/mnt/user/appdata/trading212-proxy"
REPO_URL="https://github.com/dpremoli/Wealthfolio-Trading212-Add-On.git"

echo "🚀 Trading 212 Proxy Deployment for Unraid"
echo "=========================================="
echo "Unraid IP: $UNRAID_IP"
echo "Proxy Port: $PORT"
echo "Target Path: $APPDATA_PATH"
echo ""

# Check if running on Unraid
if [ ! -f "/etc/unraid-version" ] && [ "$UNRAID_IP" != "localhost" ]; then
  echo "⚠️  Not running on Unraid. Running on remote machine."
  echo "Connect via SSH first: ssh root@$UNRAID_IP"
  exit 1
fi

# Step 1: Clone or update repo
if [ -d "$APPDATA_PATH" ]; then
  echo "📁 Updating existing repo..."
  cd "$APPDATA_PATH"
  git pull origin main 2>/dev/null || echo "⚠️  Git pull failed; continuing with local files"
else
  echo "📥 Cloning repository..."
  mkdir -p /mnt/user/appdata
  git clone "$REPO_URL" "$APPDATA_PATH"
  cd "$APPDATA_PATH"
fi

# Step 2: Stop existing container
if docker ps | grep -q "trading212-proxy"; then
  echo "🛑 Stopping existing container..."
  docker stop trading212-proxy
fi

if docker ps -a | grep -q "trading212-proxy"; then
  echo "🗑️  Removing old container..."
  docker rm trading212-proxy
fi

# Step 3: Pull latest Python image
echo "⏳ Pulling python:3.11-slim..."
docker pull python:3.11-slim

# Step 4: Start new container
echo "🚀 Starting trading212-proxy container..."
docker run -d \
  --name trading212-proxy \
  --restart unless-stopped \
  -p "$PORT:8000" \
  -v "$APPDATA_PATH:/app" \
  -w /app \
  python:3.11-slim \
  bash -c "pip install -r requirements.txt && uvicorn main:app --host 0.0.0.0 --port 8000"

# Step 5: Wait for health check
echo "⏳ Waiting for container to start (this may take 30-60 seconds on first run)..."
sleep 5

for i in {1..30}; do
  if docker logs trading212-proxy 2>/dev/null | grep -q "Uvicorn running"; then
    echo "✅ Container started successfully"
    break
  fi
  echo -n "."
  sleep 2
done

# Step 6: Verify health
echo ""
if curl -s http://localhost:$PORT/health | grep -q "ok"; then
  echo "✅ Proxy is healthy!"
  echo ""
  echo "📋 Configuration Summary"
  echo "======================="
  echo "Proxy URL: http://$UNRAID_IP:$PORT"
  echo "Health check: curl http://$UNRAID_IP:$PORT/health"
  echo "Logs: docker logs -f trading212-proxy"
  echo ""
  echo "🎉 Ready to use in Wealthfolio!"
else
  echo "⚠️  Health check pending. Check logs:"
  echo "docker logs trading212-proxy"
fi
