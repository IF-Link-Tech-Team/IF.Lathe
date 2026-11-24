#!/usr/bin/env bash
# Installs the runner side of IF.Lathe on a Linux host with KVM: a sandboxed
# runner account, its own Node, the runner, the Linux job VM image (and the
# Windows one when its ISO is in place), the Maven Central and Docker Hub
# caches the VMs use, the loopback firewall, and N runner units. The control
# plane (bin/lathe.mjs serve, or a host that embeds Lathe) runs separately.
#
#   sudo RUNNER_ENV=/etc/lathe/runner.env ./deploy/install-runner-host.sh
#
# RUNNER_ENV     env file with IFLINK_CI_TOKEN (lathe runner add …); required.
# CONTROL_HOST   loopback address the control plane listens on for runners
#                (127.0.0.2); the sandbox reaches it and no other loopback service.
# CONTROL_PORT   its port (4311).  CONTROL_UNIT  its systemd unit (lathe.service).
# KEYS_HOME      home whose ~/.ssh/iflink-ci/key_<repo> deploy keys the runner
#                gets, with a gh-<repo> SSH alias each (the sudo user's).
# RUNNERS        runner processes (3).  NODE_BIN  node to copy the version of.
# Idempotent: re-running upgrades everything and restarts the units.
set -euo pipefail
export PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin"

LATHE=${LATHE:-$(cd "$(dirname "$0")/.." && pwd)}
RUNNER_ENV=${RUNNER_ENV:?RUNNER_ENV: 需要含 IFLINK_CI_TOKEN 的 runner 环境文件}
CONTROL_HOST=${CONTROL_HOST:-127.0.0.2}
CONTROL_PORT=${CONTROL_PORT:-4311}
CONTROL_UNIT=${CONTROL_UNIT:-lathe.service}
NODE_BIN=${NODE_BIN:-$(command -v node || true)}
[ -n "$NODE_BIN" ] || { echo "找不到 node" >&2; exit 1; }
KEYS_HOME=${KEYS_HOME:-$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)}
RUNNERS=${RUNNERS:-${IFLINK_CI_RUNNERS:-3}}
RUNNER_USER=${IFLINK_CI_RUNNER_USER:-iflinkci}
RUNNER_HOME=/var/lib/iflink-ci
RUNNER_OPT=/opt/iflink-ci
UNIT_DIR=/etc/systemd/system
# github.com's published ed25519 host key (api.github.com/meta), pinned so the
# runner never trusts a first-seen key.
GITHUB_ED25519="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"

# Sets KEY=VALUE in an env file, replacing an existing line for KEY.
set_env_key() {
  local file=$1 key=$2 value=$3
  if grep -q "^$key=" "$file"; then
    sed -i "s|^$key=.*|$key=$value|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

[ -f "$RUNNER_ENV" ] && grep -q '^IFLINK_CI_TOKEN=.' "$RUNNER_ENV" || { echo "$RUNNER_ENV 里没有 IFLINK_CI_TOKEN" >&2; exit 1; }
chmod 600 "$RUNNER_ENV"

# EnvironmentFile= wins over Environment=, so the sandbox paths live here.
set_env_key "$RUNNER_ENV" IFLINK_CI_URL "http://$CONTROL_HOST:$CONTROL_PORT"
set_env_key "$RUNNER_ENV" IFLINK_CI_WORK "$RUNNER_HOME/work"
set_env_key "$RUNNER_ENV" IFLINK_CI_NODE_DIR "$RUNNER_OPT/node/bin"
# Job VMs (pipelines with `vm`): the image build-vm-image.sh installs, and
# each VM's size unless its pipeline asks for another.
VM_IMAGES=/var/lib/iflink-ci-vm/images
set_env_key "$RUNNER_ENV" IFLINK_CI_VM_IMAGE "$VM_IMAGES/current"
grep -q '^IFLINK_CI_VM_CPUS=' "$RUNNER_ENV" || set_env_key "$RUNNER_ENV" IFLINK_CI_VM_CPUS 8
grep -q '^IFLINK_CI_VM_MEMORY_MB=' "$RUNNER_ENV" || set_env_key "$RUNNER_ENV" IFLINK_CI_VM_MEMORY_MB 12288

# Runner account, its own node (the owner's may sit in a home directory the
# sandbox hides), and the runner script outside the app tree.
id -u "$RUNNER_USER" >/dev/null 2>&1 || useradd --system --home-dir "$RUNNER_HOME" --shell /usr/sbin/nologin "$RUNNER_USER"
install -d -m 700 -o "$RUNNER_USER" -g "$RUNNER_USER" "$RUNNER_HOME" "$RUNNER_HOME/work"
NODE_VERSION=$("$NODE_BIN" -v)
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64) NODE_ARCH=arm64 ;;
  *) echo "不支持的架构 $(uname -m)" >&2; exit 1 ;;
esac
NODE_DIST="node-$NODE_VERSION-linux-$NODE_ARCH"
if [ ! -x "$RUNNER_OPT/$NODE_DIST/bin/node" ]; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/node.tar.xz" "https://nodejs.org/dist/$NODE_VERSION/$NODE_DIST.tar.xz"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
  expected=$(awk -v f="$NODE_DIST.tar.xz" '$2 == f {print $1}' "$tmp/SHASUMS256.txt")
  [ -n "$expected" ] || { echo "SHASUMS256.txt 中没有 $NODE_DIST.tar.xz" >&2; exit 1; }
  echo "$expected  $tmp/node.tar.xz" | sha256sum -c --quiet -
  install -d -m 755 "$RUNNER_OPT/$NODE_DIST"
  tar -xJf "$tmp/node.tar.xz" -C "$RUNNER_OPT/$NODE_DIST" --strip-components=1 --no-same-owner
  rm -rf "$tmp"
fi
ln -sfn "$RUNNER_OPT/$NODE_DIST" "$RUNNER_OPT/node"
install -d -m 755 "$RUNNER_OPT/runner"
install -m 644 "$LATHE/runner/runner.mjs" "$LATHE/runner/vm.mjs" "$LATHE/runner/redact.mjs" "$LATHE/caches/maven-cache.mjs" "$RUNNER_OPT/runner/"

# The job VM image, and what booting it needs on this host.
for bin in qemu-system-x86_64 qemu-img ssh ssh-keygen; do
  command -v "$bin" >/dev/null || { echo "找不到 $bin（job VM 需要 qemu-system-x86 / qemu-utils / openssh-client）" >&2; exit 1; }
done
[ -e /dev/kvm ] || { echo "这台主机没有 /dev/kvm，不能运行 job VM" >&2; exit 1; }
IFLINK_CI_VM_IMAGES="$VM_IMAGES" "$LATHE/deploy/build-vm-image.sh" "$LATHE"

# Windows job VMs (vm.os windows), once the evaluation ISO is in place; the
# runners then also claim vm-windows jobs.
WINDOWS_ROOT=/var/lib/iflink-ci-vm/windows
if [ -f "$WINDOWS_ROOT/ws2025-eval.iso" ]; then
  command -v genisoimage >/dev/null || { echo "找不到 genisoimage（Windows job VM 需要）" >&2; exit 1; }
  IFLINK_CI_WINDOWS_ROOT="$WINDOWS_ROOT" "$LATHE/deploy/build-windows-image.sh" "$LATHE"
  set_env_key "$RUNNER_ENV" IFLINK_CI_WINDOWS_IMAGE "$WINDOWS_ROOT/images/current"
  labels=$(awk -F= '$1 == "IFLINK_CI_LABELS" {print $2}' "$RUNNER_ENV")
  case ",$labels," in
    *,vm-windows,*) ;;
    *) set_env_key "$RUNNER_ENV" IFLINK_CI_LABELS "${labels:+$labels,}vm-windows" ;;
  esac
fi

# Read-only GitHub deploy keys: each repository has one, registered under the
# owner's ~/.ssh/iflink-ci/key_<repo>; the runner gets a copy and an alias
# gh-<repo> per key (the watcher keeps using the owner's).
install -d -m 700 -o "$RUNNER_USER" -g "$RUNNER_USER" "$RUNNER_HOME/.ssh" "$RUNNER_HOME/.ssh/iflink-ci"
printf 'github.com %s\n' "$GITHUB_ED25519" > "$RUNNER_HOME/.ssh/known_hosts"
{
  printf 'Host *\n  StrictHostKeyChecking yes\n  UserKnownHostsFile %s\n\n' "$RUNNER_HOME/.ssh/known_hosts"
  for key in "$KEYS_HOME"/.ssh/iflink-ci/key_*; do
    [ -f "$key" ] || continue
    case "$key" in *.pub) continue ;; esac
    repo=${key##*/key_}
    install -m 600 -o "$RUNNER_USER" -g "$RUNNER_USER" "$key" "$RUNNER_HOME/.ssh/iflink-ci/key_$repo"
    printf 'Host gh-%s\n  HostName github.com\n  User git\n  IdentityFile %s\n  IdentitiesOnly yes\n\n' "$repo" "$RUNNER_HOME/.ssh/iflink-ci/key_$repo"
  done
} > "$RUNNER_HOME/.ssh/config"
chown "$RUNNER_USER:$RUNNER_USER" "$RUNNER_HOME/.ssh/config" "$RUNNER_HOME/.ssh/known_hosts"
chmod 600 "$RUNNER_HOME/.ssh/config" "$RUNNER_HOME/.ssh/known_hosts"

# Maven Central cache (caches/maven-cache.mjs in IF.Lathe) the job VMs reach at QEMU's host
# address, which is this host's loopback: its own account and sandbox, the
# internet only, and one more loopback port allowed for the runner below.
MAVEN_CACHE_USER=iflinkci-cache
MAVEN_CACHE_PORT=4380
id -u "$MAVEN_CACHE_USER" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$MAVEN_CACHE_USER"
cat > "$UNIT_DIR/iflink-ci-maven-cache.service" <<EOF
[Unit]
Description=IF ecosystem CI Maven Central cache for job VMs
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$MAVEN_CACHE_USER
Group=$MAVEN_CACHE_USER
Environment=IFLINK_CI_MAVEN_CACHE_DIR=/var/cache/iflink-ci-maven
Environment=IFLINK_CI_MAVEN_CACHE_LISTEN=127.0.0.1:$MAVEN_CACHE_PORT
CacheDirectory=iflink-ci-maven
CacheDirectoryMode=0750
ExecStart=$RUNNER_OPT/node/bin/node $RUNNER_OPT/runner/maven-cache.mjs
Restart=always
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectProc=invisible
TemporaryFileSystem=/srv:ro /opt:ro
BindReadOnlyPaths=$RUNNER_OPT
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
IPAddressDeny=link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7
MemoryMax=1G

[Install]
WantedBy=multi-user.target
EOF

# Docker Hub pull-through cache (caches/registry-cache.yml in IF.Lathe): distribution's
# registry, pinned and checksummed, as its own sandboxed account on
# 127.0.0.1:4381, the second extra loopback port the runner may use.
REGISTRY_VERSION=3.1.2
REGISTRY_SHA256=40df2224d410f72ae425c3371873b078bbdbda3b8b612be9571f0e6751f3acc8
REGISTRY_CACHE_USER=iflinkci-registry
REGISTRY_CACHE_PORT=4381
if [ "$(cat "$RUNNER_OPT/registry/VERSION" 2>/dev/null)" != "$REGISTRY_VERSION" ]; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/registry.tar.gz" "https://github.com/distribution/distribution/releases/download/v$REGISTRY_VERSION/registry_${REGISTRY_VERSION}_linux_amd64.tar.gz"
  echo "$REGISTRY_SHA256  $tmp/registry.tar.gz" | sha256sum -c --quiet -
  tar -xzf "$tmp/registry.tar.gz" -C "$tmp" registry
  install -d -m 755 "$RUNNER_OPT/registry"
  install -m 755 "$tmp/registry" "$RUNNER_OPT/registry/registry"
  echo "$REGISTRY_VERSION" > "$RUNNER_OPT/registry/VERSION"
  rm -rf "$tmp"
fi
install -m 644 "$LATHE/caches/registry-cache.yml" "$RUNNER_OPT/registry/config.yml"
id -u "$REGISTRY_CACHE_USER" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$REGISTRY_CACHE_USER"
cat > "$UNIT_DIR/iflink-ci-registry-cache.service" <<EOF
[Unit]
Description=IF ecosystem CI Docker Hub cache for job VMs
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$REGISTRY_CACHE_USER
Group=$REGISTRY_CACHE_USER
CacheDirectory=iflink-ci-registry
CacheDirectoryMode=0750
ExecStart=$RUNNER_OPT/registry/registry serve $RUNNER_OPT/registry/config.yml
Restart=always
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectProc=invisible
TemporaryFileSystem=/srv:ro /opt:ro
BindReadOnlyPaths=$RUNNER_OPT
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
IPAddressDeny=link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7
MemoryMax=1G

[Install]
WantedBy=multi-user.target
EOF

# This host's own addresses: a job must not come back in through them.
HOST_ADDRS=$(ip -o addr show scope global | awk '{split($4, a, "/"); print a[1] ($3 == "inet6" ? "/128" : "/32")}' | sort -u | tr '\n' ' ')

# Jobs start their own servers on 127.0.0.1 (tests), so loopback cannot be
# denied outright. The unit allows it by address; this table, matched on the
# runner's uid, then limits it to the ports a job's own servers use (the
# ephemeral range and the runtime-host range), the API's runner address and
# the DNS stub. Services other accounts bind on loopback stay unreachable.
# A job VM's traffic leaves from its QEMU process, as this uid, so the same
# rules and the unit's IP lists cover the guest too.
NFT_BIN=$(command -v nft) || { echo "找不到 nft（nftables）" >&2; exit 1; }
install -d -m 755 /etc/iflink-ci
cat > /etc/iflink-ci/runner.nft <<EOF
table inet iflink_ci
delete table inet iflink_ci
table inet iflink_ci {
  chain output {
    type filter hook output priority filter; policy accept;
    meta skuid != "$RUNNER_USER" accept
    ip daddr $CONTROL_HOST tcp dport $CONTROL_PORT accept
    ip daddr 127.0.0.1 tcp dport { $MAVEN_CACHE_PORT, $REGISTRY_CACHE_PORT } accept
    ip daddr { 127.0.0.53, 127.0.0.54 } meta l4proto { tcp, udp } th dport 53 accept
    ip daddr 127.0.0.0/8 meta l4proto { tcp, udp } th dport { 10000-10999, 32768-65535 } accept
    ip6 daddr ::1 meta l4proto { tcp, udp } th dport { 10000-10999, 32768-65535 } accept
    ip daddr 127.0.0.0/8 meta l4proto tcp reject with tcp reset
    ip6 daddr ::1 meta l4proto tcp reject with tcp reset
    ip daddr 127.0.0.0/8 reject
    ip6 daddr ::1 reject
  }
}
EOF
nft -c -f /etc/iflink-ci/runner.nft
# Superseded by the table above.
rm -f "$UNIT_DIR/iflink-ci-runner.service.d/interim-loopback.conf"
rmdir "$UNIT_DIR/iflink-ci-runner.service.d" 2>/dev/null || true

# Several runner processes share one token and claim jobs independently, so a
# deploy is not stuck behind a long check. Each has its own work directory
# (a runner empties its own when it starts).
cat > "$UNIT_DIR/iflink-ci-runner@.service" <<EOF
[Unit]
Description=IF ecosystem CI runner %i (unprivileged, sandboxed)
After=$CONTROL_UNIT
Wants=$CONTROL_UNIT

[Service]
Type=simple
User=$RUNNER_USER
Group=$RUNNER_USER
EnvironmentFile=$RUNNER_ENV
Environment=HOME=$RUNNER_HOME
Environment=PATH=$RUNNER_OPT/node/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=$RUNNER_HOME
StateDirectory=iflink-ci
StateDirectoryMode=0700
# As root (+): the loopback port filter. If it cannot load, the runner does
# not start.
ExecStartPre=+$NFT_BIN -f /etc/iflink-ci/runner.nft
ExecStart=/usr/bin/env IFLINK_CI_WORK=$RUNNER_HOME/work/%i $RUNNER_OPT/node/bin/node $RUNNER_OPT/runner/runner.mjs
Restart=always
RestartSec=5

# Filesystem: the rest of /srv and /opt, home directories, other users'
# processes and the tailscaled/sshd sockets are out of sight. The one device
# beyond the standard pseudo devices is /dev/kvm, for job VMs.
NoNewPrivileges=yes
PrivateTmp=yes
SupplementaryGroups=kvm
DevicePolicy=closed
DeviceAllow=/dev/kvm rw
ProtectSystem=strict
ProtectHome=yes
ProtectProc=invisible
TemporaryFileSystem=/srv:ro /opt:ro
BindReadOnlyPaths=$RUNNER_OPT
InaccessiblePaths=-/run/tailscale -/run/ssh-unix-local -/var/lib/cloud
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK

# Network: the internet (GitHub, registries) and loopback (ports limited by
# /etc/iflink-ci/runner.nft); not the tailnet, the private networks behind
# this host (docker bridges, VMs) or this host's own public addresses.
IPAddressDeny=localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7 $HOST_ADDRS
IPAddressAllow=127.0.0.1/32 ::1/128 $CONTROL_HOST/32 127.0.0.53/32 127.0.0.54/32

# A runaway build must not starve the services sharing this host.
MemoryMax=16G
CPUQuota=1600%
TasksMax=4096

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
# The single runner unit of earlier installs.
if [ -f "$UNIT_DIR/iflink-ci-runner.service" ]; then
  systemctl disable --now iflink-ci-runner.service || true
  rm -f "$UNIT_DIR/iflink-ci-runner.service"
  systemctl daemon-reload
fi
for i in $(seq 1 "$RUNNERS"); do
  systemctl enable --now "iflink-ci-runner@$i.service"
  systemctl restart "iflink-ci-runner@$i.service"
done
systemctl enable --now iflink-ci-maven-cache.service iflink-ci-registry-cache.service
systemctl restart iflink-ci-maven-cache.service iflink-ci-registry-cache.service
sleep 2
systemctl --no-pager --lines=5 status "iflink-ci-runner@1.service" || true
