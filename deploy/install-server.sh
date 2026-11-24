#!/usr/bin/env bash
# Installs a standalone IF.Lathe on one Linux host with KVM: the control plane
# (bin/lathe.mjs serve, as its own account) and the runner side
# (deploy/install-runner-host.sh) next to it.
#
#   sudo ./deploy/install-server.sh
#
# LATHE_ROOT   state directory (/srv/lathe): lathe.env, runner.env, data/.
# LATHE_USER   account the control plane runs as (lathe).
# Then, as that account (sudo -u lathe env $(cat /srv/lathe/lathe.env) …):
#   node bin/lathe.mjs github-app set --app-id N --installation N --key app.pem
#   node bin/lathe.mjs pipelines apply pipelines/
# Idempotent: re-running upgrades the units and keeps the database and keys.
set -euo pipefail
export PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin"

LATHE=$(cd "$(dirname "$0")/.." && pwd)
ROOT=${LATHE_ROOT:-/srv/lathe}
SERVICE_USER=${LATHE_USER:-lathe}
NODE_BIN=${NODE_BIN:-$(command -v node || true)}
[ -n "$NODE_BIN" ] || { echo "找不到 node（需要 Node 24+）" >&2; exit 1; }
major=$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 24 ] || { echo "需要 Node 24+，当前 $("$NODE_BIN" -v)" >&2; exit 1; }
LISTEN_HOST=127.0.0.2
LISTEN_PORT=${LATHE_PORT:-4311}
UNIT_DIR=/etc/systemd/system

id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home-dir "$ROOT" --shell /usr/sbin/nologin "$SERVICE_USER"
install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$ROOT"
install -d -m 700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$ROOT/data"

# The vault key and the read-API token, made once: everything sealed with the
# vault key is unreadable without it.
ENV="$ROOT/lathe.env"
if [ ! -f "$ENV" ]; then
  (umask 077; cat > "$ENV") <<EOF
LATHE_DB=$ROOT/data/lathe.db
LATHE_DATA=$ROOT/data/artifacts
LATHE_LISTEN=$LISTEN_HOST:$LISTEN_PORT
LATHE_SECRET_KEY=$(head -c 32 /dev/urandom | base64 | tr -d '\n=+/')
LATHE_ADMIN_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '\n=+/')
EOF
fi
chown "$SERVICE_USER:$SERVICE_USER" "$ENV"
chmod 600 "$ENV"

lathe() {
  (set -a; . "$ENV"; set +a; cd "$LATHE"; sudo -u "$SERVICE_USER" --preserve-env=LATHE_DB,LATHE_SECRET_KEY,IFLINK_CI_TOKEN,IFLINK_CI_LABELS "$NODE_BIN" bin/lathe.mjs "$@")
}

# This host's runners: one token, registered once.
RUNNER_ENV="$ROOT/runner.env"
if [ ! -f "$RUNNER_ENV" ]; then
  token=$(lathe runner add "$(hostname -s)" --labels linux,x64,vm,vm-only)
  (umask 077; printf '%s\nIFLINK_CI_LABELS=linux,x64,vm,vm-only\n' "$token" > "$RUNNER_ENV")
fi

cat > "$UNIT_DIR/lathe.service" <<EOF
[Unit]
Description=IF.Lathe CI control plane
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$LATHE
EnvironmentFile=$ENV
ExecStart=$NODE_BIN bin/lathe.mjs serve
Restart=always
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$ROOT

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now lathe.service
systemctl restart lathe.service

RUNNER_ENV="$RUNNER_ENV" CONTROL_HOST="$LISTEN_HOST" CONTROL_PORT="$LISTEN_PORT" CONTROL_UNIT=lathe.service NODE_BIN="$NODE_BIN" \
  bash "$LATHE/deploy/install-runner-host.sh"

# The runner side may add labels (vm-windows); scheduling goes by the
# registered ones.
(set -a; . "$RUNNER_ENV"; set +a; lathe runner labels)
systemctl --no-pager --lines=5 status lathe.service || true
