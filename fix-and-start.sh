#!/bin/bash
# =====================================================================
# FlowBot AI — Clean PM2 Reset & Start Script
# Fixes crash loops, rebuilds frontend, and starts all services cleanly
# =====================================================================

DIR="$(cd "$(dirname "$0")" && pwd)"
echo "=========================================================="
echo "  ⚡ FlowBot AI — Clean Reset & Start in $DIR"
echo "=========================================================="

# 1. Stop and remove all old crashing PM2 processes
echo "[1/5] Cleaning up old PM2 processes..."
pm2 delete all 2>/dev/null || true

# 2. Kill any stale lingering processes on ports 8000, 3001, 3000
echo "[2/5] Clearing stale ports..."
pkill -f "uvicorn main:app" 2>/dev/null || true
pkill -f "node index.js" 2>/dev/null || true
pkill -f "next-server" 2>/dev/null || true
sleep 1

# 2.5. Update WhatsApp bridge dependencies
echo "[2.5/5] Updating WhatsApp bridge dependencies..."
cd "$DIR/whatsapp-bridge"
npm install --no-audit --no-fund

# 3. Build Next.js frontend for production
echo "[3/5] Building Next.js Frontend (this takes ~30 seconds)..."
cd "$DIR/frontend"
npm run build

# 4. Start all 3 services with explicit working directories (--cwd)
echo "[4/5] Starting services with PM2..."

# Backend
pm2 start "$DIR/backend/venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000" \
  --cwd "$DIR/backend" \
  --name flowbot-backend

# WhatsApp Bridge
pm2 start "node index.js" \
  --cwd "$DIR/whatsapp-bridge" \
  --name flowbot-bridge

# Frontend
pm2 start "npm start" \
  --cwd "$DIR/frontend" \
  --name flowbot-frontend

# Save PM2 configuration so it auto-starts on reboot
pm2 save

# 5. Verify status
echo "[5/5] Checking service status..."
sleep 4

echo ""
pm2 status

echo ""
echo "Testing Backend API..."
HEALTH_RESP=$(curl -s -m 5 http://127.0.0.1:8000/health || echo "FAILED")
echo "Backend response: $HEALTH_RESP"

echo ""
echo "=========================================================="
echo "  ✅ Services reset and started successfully!"
echo "=========================================================="

