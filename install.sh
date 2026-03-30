#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Elastos Node Monitor — One-Click Installer
# ============================================================================

MONITOR_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="elastos-monitor"
DEFAULT_PORT=9999

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
info() { echo -e "${CYAN}[i]${NC} $1"; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
    SUDO="sudo"
fi

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║       Elastos Supernode Monitor — Installer      ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# ============================================================================
# Step 1: Check/install Node.js
# ============================================================================

NODE_OK=false
NPM_OK=false

if command -v node &>/dev/null; then
    NODE_VERSION=$(node -v | sed 's/v//')
    NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
    if [ "$NODE_MAJOR" -ge 18 ]; then
        log "Node.js v${NODE_VERSION} found"
        NODE_OK=true
    else
        warn "Node.js v${NODE_VERSION} is too old (need >= 18)"
    fi
fi

if command -v npm &>/dev/null; then
    log "npm v$(npm -v) found"
    NPM_OK=true
fi

if [ "$NODE_OK" = true ] && [ "$NPM_OK" = false ]; then
    info "Node.js is installed but npm is missing. Installing npm..."
    $SUDO apt-get update -y
    $SUDO apt-get install -y npm
    log "npm v$(npm -v) installed"
elif [ "$NODE_OK" = false ]; then
    info "Installing Node.js 20.x with npm from NodeSource..."
    if ! command -v curl &>/dev/null; then
        $SUDO apt-get update -y && $SUDO apt-get install -y curl
    fi
    curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
    $SUDO apt-get install -y nodejs
    log "Node.js $(node -v) + npm $(npm -v) installed"
fi

command -v node &>/dev/null || err "Node.js installation failed. Install manually: https://nodejs.org"
command -v npm &>/dev/null || err "npm installation failed. Try: apt install npm"

# ============================================================================
# Step 2: Install npm dependencies
# ============================================================================

info "Installing dependencies (express + dotenv)..."
cd "$MONITOR_DIR"
npm install --omit=dev
log "Dependencies installed"

# ============================================================================
# Step 3: Auto-detect server specs
# ============================================================================

CPU_CORES=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 0)
RAM_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}' || echo 0)
RAM_GB=$(echo "scale=1; $RAM_KB / 1048576" | bc 2>/dev/null || echo 0)

DISK_MOUNT="/"
if df /data &>/dev/null && [ "$(df /data --output=source 2>/dev/null | tail -1)" != "$(df / --output=source 2>/dev/null | tail -1)" ]; then
    DISK_MOUNT="/data"
fi

DISK_GB=$(df -BG "$DISK_MOUNT" --output=size 2>/dev/null | tail -1 | tr -d ' G' || echo 0)

log "Detected: ${CPU_CORES} CPU cores, ${RAM_GB} GB RAM, ${DISK_GB} GB disk (${DISK_MOUNT})"

# ============================================================================
# Step 4: Auto-discover Elastos node directory
# ============================================================================

ELASTOS_DIR=""
SEARCH_PATHS=(
    "$HOME/node"
    "$HOME/elastos"
    "$HOME/elastos-node"
    "/data/node"
    "/data/elastos"
    "/opt/elastos"
    "/opt/node"
)

for p in "${SEARCH_PATHS[@]}"; do
    if [ -f "$p/node.sh" ] || [ -f "$p/ela/ela" ] || [ -d "$p/ela" ]; then
        ELASTOS_DIR="$p"
        break
    fi
done

if [ -n "$ELASTOS_DIR" ]; then
    log "Found Elastos node at: ${ELASTOS_DIR}"
else
    warn "Could not auto-detect Elastos node directory."
    read -rp "    Enter path to your Elastos node directory (or press Enter to skip): " ELASTOS_DIR
    if [ -n "$ELASTOS_DIR" ] && [ -d "$ELASTOS_DIR" ]; then
        log "Using: ${ELASTOS_DIR}"
    else
        ELASTOS_DIR=""
        warn "No Elastos directory set. Process discovery will use ps only."
    fi
fi

# ============================================================================
# Step 5: Generate auth token + write .env
# ============================================================================

if [ -f "$MONITOR_DIR/.env" ]; then
    EXISTING_TOKEN=$(grep -oP '^AUTH_TOKEN=\K.*' "$MONITOR_DIR/.env" 2>/dev/null || echo "")
    if [ -n "$EXISTING_TOKEN" ]; then
        AUTH_TOKEN="$EXISTING_TOKEN"
        log "Existing .env found — keeping your current auth token"

        # Update non-secret values in case specs changed
        sed -i "s|^ELASTOS_NODE_DIR=.*|ELASTOS_NODE_DIR=${ELASTOS_DIR}|" "$MONITOR_DIR/.env"
        sed -i "s|^DISK_MOUNT=.*|DISK_MOUNT=${DISK_MOUNT}|" "$MONITOR_DIR/.env"
        log "Updated node directory and disk mount in .env"
    else
        AUTH_TOKEN=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
        cat > "$MONITOR_DIR/.env" <<EOF
PORT=${DEFAULT_PORT}
AUTH_TOKEN=${AUTH_TOKEN}
ELASTOS_NODE_DIR=${ELASTOS_DIR}
DISK_MOUNT=${DISK_MOUNT}
EOF
        log "Auth token generated and .env written"
    fi
else
    AUTH_TOKEN=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
    cat > "$MONITOR_DIR/.env" <<EOF
PORT=${DEFAULT_PORT}
AUTH_TOKEN=${AUTH_TOKEN}
ELASTOS_NODE_DIR=${ELASTOS_DIR}
DISK_MOUNT=${DISK_MOUNT}
EOF
    log "Auth token generated and .env written"
fi

# ============================================================================
# Step 7: Create systemd service
# ============================================================================

NODE_BIN=$(which node)

$SUDO tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null <<EOF
[Unit]
Description=Elastos Supernode Monitor
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=${MONITOR_DIR}
ExecStart=${NODE_BIN} ${MONITOR_DIR}/server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable ${SERVICE_NAME} >/dev/null 2>&1
$SUDO systemctl restart ${SERVICE_NAME}
log "Systemd service created and started"

# Wait for startup
sleep 2

if systemctl is-active --quiet ${SERVICE_NAME}; then
    log "Service is running"
else
    err "Service failed to start. Run: sudo journalctl -u ${SERVICE_NAME} -n 50"
fi

# ============================================================================
# Step 8: Get server IP
# ============================================================================

SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "YOUR_SERVER_IP")

# ============================================================================
# Done!
# ============================================================================

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║              Installation Complete!              ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Dashboard URL:${NC}"
echo -e "  ${CYAN}http://${SERVER_IP}:${DEFAULT_PORT}?token=${AUTH_TOKEN}${NC}"
echo ""
echo -e "  ${BOLD}Bookmark that URL${NC} — it contains your access token."
echo ""
echo -e "  ${BOLD}Useful commands:${NC}"
echo -e "    Status:   ${CYAN}sudo systemctl status ${SERVICE_NAME}${NC}"
echo -e "    Logs:     ${CYAN}sudo journalctl -u ${SERVICE_NAME} -f${NC}"
echo -e "    Stop:     ${CYAN}sudo systemctl stop ${SERVICE_NAME}${NC}"
echo -e "    Restart:  ${CYAN}sudo systemctl restart ${SERVICE_NAME}${NC}"
echo -e "    Uninstall: ${CYAN}sudo systemctl disable --now ${SERVICE_NAME} && sudo rm /etc/systemd/system/${SERVICE_NAME}.service${NC}"
echo ""
echo -e "  Data is stored in: ${MONITOR_DIR}/data/"
echo -e "  First chart data will appear after ~2 minutes."
echo ""
