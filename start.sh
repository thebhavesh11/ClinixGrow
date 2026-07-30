#!/bin/bash
# FlowBot AI — Start All Services (Linux / Codespaces)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo ""
echo "  ============================================"
echo "    FlowBot AI - Starting All Services"
echo "  ============================================"
echo ""

# Kill any existing processes on ports 8000, 3000, 3001
echo "[1/4] Cleaning up old processes..."
kill $(lsof -t -i:8000) 2>/dev/null || true
kill $(lsof -t -i:3000) 2>/dev/null || true
kill $(lsof -t -i:3001) 2>/dev/null || true
sleep 1

# Check if dependencies are installed, if not install them
if [ ! -d "$SCRIPT_DIR/frontend/node_modules" ]; then
    echo "[*] Frontend dependencies not found, installing..."
    cd "$SCRIPT_DIR/frontend" && npm install
fi
if [ ! -d "$SCRIPT_DIR/whatsapp-bridge/node_modules" ]; then
    echo "[*] WhatsApp bridge dependencies not found, installing..."
    cd "$SCRIPT_DIR/whatsapp-bridge" && npm install
fi
if [ ! -d "$SCRIPT_DIR/backend/venv" ]; then
    echo "[*] Backend virtual environment not found, creating and installing dependencies..."
    cd "$SCRIPT_DIR/backend"
    python3 -m venv venv
    ./venv/bin/pip install -r requirements.txt
fi

# Start Backend (FastAPI)
echo "[2/4] Starting Backend (port 8000)..."
cd "$SCRIPT_DIR/backend"
./venv/bin/python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload &
BACKEND_PID=$!
sleep 3

# Start WhatsApp Bridge
echo "[3/4] Starting WhatsApp Bridge (port 3001)..."
cd "$SCRIPT_DIR/whatsapp-bridge"
node index.js &
BRIDGE_PID=$!
sleep 2

# Start Frontend (Next.js)
echo "[4/4] Starting Frontend (port 3000)..."
cd "$SCRIPT_DIR/frontend"
if [ ! -d ".next" ]; then
    echo "Building Next.js frontend for production (this takes a minute)..."
    npm run build
fi
npx next start -p 3000 &
FRONTEND_PID=$!
sleep 3

echo ""
echo "  ============================================"
echo "    All Services Started!"
echo "  ============================================"
echo ""
echo "    Backend:    http://localhost:8000"
echo "    Frontend:   http://localhost:3000"
echo "    WhatsApp:   http://localhost:3001"
echo ""
echo "    Open http://localhost:3000 in your browser"
echo "  ============================================"
echo ""
echo "  PIDs: Backend=$BACKEND_PID  Bridge=$BRIDGE_PID  Frontend=$FRONTEND_PID"
echo "  Press Ctrl+C to stop all services"
echo ""

# Wait for all background processes
trap "kill $BACKEND_PID $BRIDGE_PID $FRONTEND_PID 2>/dev/null; exit" SIGINT SIGTERM
wait
