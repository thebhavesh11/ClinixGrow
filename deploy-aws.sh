#!/bin/bash
# =====================================================================
# FlowBot AI — AWS EC2 One-Click Production Deployment Script (Ubuntu)
# =====================================================================

set -e

echo ""
echo "=========================================================="
echo "  ⚡ FlowBot AI — AWS EC2 Production Setup"
echo "=========================================================="
echo ""

# 1. Update OS & Install Core Dependencies
echo "[1/6] Updating packages & installing system dependencies..."
sudo apt update -y
sudo apt install -y curl git ufw nginx certbot python3-certbot-nginx python3-pip python3-venv

# 2. Install Node.js (v20 LTS)
echo "[2/6] Verifying/Installing Node.js 20 LTS..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
fi
echo "Node version: $(node -v)"
echo "NPM version: $(npm -v)"

# Install PM2 Process Manager globally
sudo npm install -g pm2

# 3. Install Chromium/Puppeteer Linux Libraries
echo "[3/6] Installing Puppeteer Chromium dependencies..."
sudo apt install -y \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils

# 4. Install Project Dependencies & Build
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "[4/6] Setting up Backend virtual environment..."
cd "$SCRIPT_DIR/backend"
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt

echo "[5/6] Setting up WhatsApp Bridge..."
cd "$SCRIPT_DIR/whatsapp-bridge"
npm install

echo "[6/6] Building Next.js Frontend..."
cd "$SCRIPT_DIR/frontend"
npm install
npm run build

echo ""
echo "=========================================================="
echo "  ✅ All dependencies installed & frontend built!"
echo "=========================================================="
echo ""
echo "To start all services with PM2 (auto-restarts on server reboot):"
echo "  pm2 start \"$SCRIPT_DIR/backend/venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000\" --cwd \"$SCRIPT_DIR/backend\" --name flowbot-backend"
echo "  pm2 start \"node index.js\" --cwd \"$SCRIPT_DIR/whatsapp-bridge\" --name flowbot-bridge"
echo "  pm2 start \"npm start\" --cwd \"$SCRIPT_DIR/frontend\" --name flowbot-frontend"
echo "  pm2 save"
echo "  pm2 startup"
echo ""
echo "=========================================================="

