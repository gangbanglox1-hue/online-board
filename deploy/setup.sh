#!/bin/bash
# Sets up the board on a fresh Ubuntu server (run as root; safe to run again).
# Needs: SETUP_TOKEN (secret for the owner setup link and data import). Optional: DOMAIN
# (default: <server-ip>.sslip.io, which points at this server and gets a free HTTPS certificate).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
REPO=https://github.com/gangbanglox1-hue/online-board.git
APP=/opt/online-board
DATA=/var/lib/online-board
: "${SETUP_TOKEN:?SETUP_TOKEN is required}"

apt-get update -q
apt-get install -y -q git curl ca-certificates debian-keyring debian-archive-keyring apt-transport-https gnupg

# Node.js 22 (node:sqlite needs 22.13+)
if ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2>/dev/null; then
  if curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource.sh; then bash /tmp/nodesource.sh && apt-get install -y -q nodejs
  else
    V=v22.12.0; curl -fsSL "https://npmmirror.com/mirrors/node/$V/node-$V-linux-x64.tar.xz" | tar -xJ -C /usr/local --strip-components=1
  fi
fi

# Caddy: web server with automatic HTTPS certificates
if ! command -v caddy >/dev/null; then
  if curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
     && curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list; then
    apt-get update -q && apt-get install -y -q caddy
  else
    curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64" -o /usr/bin/caddy && chmod +x /usr/bin/caddy
  fi
fi

id -u board >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin board
mkdir -p "$DATA" && chown board:board "$DATA" && chmod 700 "$DATA"
[ -d "$APP/.git" ] || git clone -q "$REPO" "$APP"
git config --global --add safe.directory "$APP"
cd "$APP" && git fetch -q origin main && git reset -q --hard origin/main
npm ci --no-audit --no-fund --loglevel=error && node node/build.mjs

IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
DOMAIN=${DOMAIN:-$(echo "$IP" | tr . -).sslip.io}

umask 077
cat > /etc/online-board.env <<EOF
SETUP_TOKEN=$SETUP_TOKEN
DATA_DIR=$DATA
PORT=3000
HOST=127.0.0.1
TRUST_PROXY=1
NODE_OPTIONS=--no-warnings
EOF
umask 022

cat > /etc/systemd/system/online-board.service <<EOF
[Unit]
Description=Online board
After=network.target
[Service]
User=board
EnvironmentFile=/etc/online-board.env
WorkingDirectory=$APP
ExecStart=/usr/bin/env node node/server.mjs
Restart=always
RestartSec=2
LimitNOFILE=65536
[Install]
WantedBy=multi-user.target
EOF

# pick up new code from GitHub every 2 minutes
cat > /usr/local/bin/online-board-update <<'EOF'
#!/bin/bash
set -e
cd /opt/online-board
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0
git reset -q --hard origin/main
npm ci --no-audit --no-fund --loglevel=error
node node/build.mjs
systemctl restart online-board
EOF
chmod +x /usr/local/bin/online-board-update
cat > /etc/systemd/system/online-board-update.service <<EOF
[Unit]
Description=Update the online board from GitHub
[Service]
Type=oneshot
ExecStart=/usr/local/bin/online-board-update
EOF
cat > /etc/systemd/system/online-board-update.timer <<EOF
[Unit]
Description=Check GitHub for board updates
[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
EOF

mkdir -p /etc/caddy
if [ ! -f /lib/systemd/system/caddy.service ] && [ ! -f /etc/systemd/system/caddy.service ]; then
  id -u caddy >/dev/null 2>&1 || useradd --system --home /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
  cat > /etc/systemd/system/caddy.service <<EOF
[Unit]
Description=Caddy
After=network.target
[Service]
User=caddy
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always
[Install]
WantedBy=multi-user.target
EOF
fi
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
}
EOF

systemctl daemon-reload
systemctl enable --now online-board online-board-update.timer
systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy
command -v ufw >/dev/null && { ufw allow 22/tcp; ufw allow 80/tcp; ufw allow 443/tcp; } >/dev/null 2>&1 || true
echo "READY https://$DOMAIN" | tee /var/log/online-board-setup.log
