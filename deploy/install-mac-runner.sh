#!/usr/bin/env bash
# Installs the macOS CI runner on a Mac: tart, the runner and an SSH tunnel to
# the control plane, as LaunchAgents of the logged-in account. Jobs run in
# throwaway tart VMs (runner/vm.mjs: an APFS clone of IMAGE per job, deleted
# afterwards), never in this account.
#
#   LATHE_CONTROL=tunnel@ci.example.org ./deploy/install-mac-runner.sh
#
# LATHE_CONTROL       the tunnel account and host (required).
# LATHE_CONTROL_ADDR  where the control plane listens for runners there (127.0.0.2:4311).
# LATHE_LAUNCHD_LABEL prefix of the two LaunchAgents (org.iflink.lathe).
#
# Expects in $ROOT/secrets (mode 700):
#   tunnel_ed25519  key of a tunnel-only account on the control plane host,
#                   whose authorized_keys line is restrict,port-forwarding,
#                   permitopen="127.0.0.2:4311",command="/usr/sbin/nologin"
#   known_hosts     that host's pinned host key
#   runner.env      IFLINK_CI_TOKEN=cir_… of a runner registered for vm-macos
# Idempotent: re-running upgrades the runner files and restarts both agents.
set -euo pipefail

ROOT=${IFLINK_CI_MAC_ROOT:-/Users/Shared/iflink-ci}
CONTROL=${LATHE_CONTROL:-}
[ -n "$CONTROL" ] || { echo "LATHE_CONTROL 未设置（tunnel 账号@控制面主机）" >&2; exit 1; }
CONTROL_ADDR=${LATHE_CONTROL_ADDR:-127.0.0.2:4311}
PORT=${IFLINK_CI_TUNNEL_PORT:-14311}
TART_VERSION=2.42.0
IMAGE=${IFLINK_CI_TART_IMAGE:-ghcr.io/cirruslabs/macos-tahoe-xcode:27.2}
NODE_BIN=${NODE_BIN:-$(command -v node)}
SRC=$(cd "$(dirname "$0")/.." && pwd)
TART="$ROOT/bin/tart.app/Contents/MacOS/tart"
AGENTS="$HOME/Library/LaunchAgents"
LABEL=${LATHE_LAUNCHD_LABEL:-org.iflink.lathe}

[ "$(uname -s)" = Darwin ] || { echo "只能在 macOS 上安装" >&2; exit 1; }
[ -n "$NODE_BIN" ] || { echo "找不到 node" >&2; exit 1; }
for f in tunnel_ed25519 known_hosts runner.env; do
  [ -f "$ROOT/secrets/$f" ] || { echo "缺少 $ROOT/secrets/$f" >&2; exit 1; }
done
chmod 700 "$ROOT/secrets"
chmod 600 "$ROOT/secrets/tunnel_ed25519" "$ROOT/secrets/runner.env"
install -d -m 755 "$ROOT/bin" "$ROOT/runner" "$ROOT/tart" "$ROOT/logs"
install -d -m 700 "$ROOT/work"

# tart, from its release, checked against the published checksum.
if [ "$("$TART" --version 2>/dev/null || true)" != "$TART_VERSION" ]; then
  tmp=$(mktemp -d)
  base="https://github.com/cirruslabs/tart/releases/download/$TART_VERSION"
  curl -fsSL -o "$tmp/tart.tar.gz" "$base/tart.tar.gz"
  curl -fsSL -o "$tmp/sums.txt" "$base/tart_${TART_VERSION}_checksums.txt"
  expected=$(awk '$2 == "tart.tar.gz" {print $1}' "$tmp/sums.txt")
  [ -n "$expected" ] && [ "$(shasum -a 256 "$tmp/tart.tar.gz" | cut -d' ' -f1)" = "$expected" ] \
    || { echo "tart.tar.gz 校验失败" >&2; exit 1; }
  rm -rf "$ROOT/bin/tart.app"
  tar -xzf "$tmp/tart.tar.gz" -C "$ROOT/bin" tart.app
  rm -rf "$tmp"
fi
codesign --verify --deep --strict "$ROOT/bin/tart.app"

# The job image (tens of GB on first pull).
export TART_HOME="$ROOT/tart"
"$TART" list --format json | grep -q "\"$IMAGE\"" || "$TART" pull "$IMAGE"

install -m 644 "$SRC/runner/runner.mjs" "$SRC/runner/vm.mjs" "$SRC/runner/redact.mjs" "$ROOT/runner/"
cat > "$ROOT/runner/run.sh" <<EOF
#!/bin/sh
# The token stays in a 0600 file, out of the LaunchAgent plist.
set -a
. "$ROOT/secrets/runner.env"
set +a
exec "$NODE_BIN" "$ROOT/runner/runner.mjs"
EOF
chmod 755 "$ROOT/runner/run.sh"

install -d -m 755 "$AGENTS"
cat > "$AGENTS/$LABEL-tunnel.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL-tunnel</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/ssh</string><string>-N</string>
    <string>-i</string><string>$ROOT/secrets/tunnel_ed25519</string>
    <string>-o</string><string>IdentitiesOnly=yes</string>
    <string>-o</string><string>BatchMode=yes</string>
    <string>-o</string><string>StrictHostKeyChecking=yes</string>
    <string>-o</string><string>UserKnownHostsFile=$ROOT/secrets/known_hosts</string>
    <string>-o</string><string>ExitOnForwardFailure=yes</string>
    <string>-o</string><string>ServerAliveInterval=30</string>
    <string>-o</string><string>ServerAliveCountMax=3</string>
    <string>-L</string><string>127.0.0.1:$PORT:$CONTROL_ADDR</string>
    <string>$CONTROL</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardErrorPath</key><string>$ROOT/logs/tunnel.log</string>
</dict>
</plist>
EOF

cat > "$AGENTS/$LABEL-runner.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL-runner</string>
  <key>ProgramArguments</key><array><string>$ROOT/runner/run.sh</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>IFLINK_CI_URL</key><string>http://127.0.0.1:$PORT</string>
    <key>IFLINK_CI_LABELS</key><string>vm-macos</string>
    <key>IFLINK_CI_WORK</key><string>$ROOT/work</string>
    <key>IFLINK_CI_TART</key><string>$TART</string>
    <key>IFLINK_CI_TART_IMAGE</key><string>$IMAGE</string>
    <key>TART_HOME</key><string>$ROOT/tart</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$ROOT/logs/runner.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/runner.log</string>
</dict>
</plist>
EOF

for agent in tunnel runner; do
  launchctl bootout "gui/$(id -u)/$LABEL-$agent" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$LABEL-$agent.plist"
done
sleep 3
launchctl print "gui/$(id -u)/$LABEL-runner" | grep -E 'state|pid' | head -3
tail -n 3 "$ROOT/logs/runner.log" || true
