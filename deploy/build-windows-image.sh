#!/usr/bin/env bash
# Builds the Windows CI job image (images/windows): an unattended install of
# the Windows Server 2025 evaluation ISO in a KVM guest, provisioned by
# setup.ps1, installed as $IMAGES/<hash>-<date>/root.qcow2 with current
# pointing at it. The hash covers the recipe, the ISO and the pinned
# installers, so an unchanged definition is not rebuilt; older images are
# removed (each is about 7 GB, and a running VM keeps its open file).
# The evaluation licence runs 180 days from the build: an image older than
# IFLINK_CI_WINDOWS_MAX_AGE_DAYS (150) is rebuilt, which starts it again
# (iflink-ci-windows-image.timer runs this weekly).
#
#   sudo ./deploy/build-windows-image.sh [IF.Lathe dir]
#
# Expects the ISO from Microsoft's Evaluation Center at $ISO.
set -euo pipefail

LATHE=${1:-$(cd "$(dirname "$0")/.." && pwd)}
SRC="$LATHE/images/windows"
ROOT=${IFLINK_CI_WINDOWS_ROOT:-/var/lib/iflink-ci-vm/windows}
ISO=${IFLINK_CI_WINDOWS_ISO:-$ROOT/ws2025-eval.iso}
IMAGES="$ROOT/images"
BUILD_MINUTES=${IFLINK_CI_WINDOWS_BUILD_MINUTES:-120}
MAX_AGE_DAYS=${IFLINK_CI_WINDOWS_MAX_AGE_DAYS:-150}

# name|url|sha256
DOWNLOADS="
PowerShell-win-x64.zip|https://github.com/PowerShell/PowerShell/releases/download/v7.7.0/PowerShell-7.7.0-win-x64.zip|7c74e03b20a75b59715847439d046a6214b1863ee79b187872980f139bb4a05f
uv-x86_64-pc-windows-msvc.zip|https://github.com/astral-sh/uv/releases/download/0.13.9/uv-x86_64-pc-windows-msvc.zip|edd61f7f5728a56cc62455386661860bdfc7bab65872f39b0c25bdcc1d8e1beb
Git-64-bit.exe|https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/Git-2.56.1-64-bit.exe|c330c72e10b408cc39994bfefdb63542b0d93d21699325c3e0bd874af8a5a559
node-win-x64.zip|https://nodejs.org/dist/v24.22.0/node-v24.22.0-win-x64.zip|f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3
"

[ -f "$ISO" ] || { echo "缺少 Windows ISO：$ISO" >&2; exit 1; }
iso_sum=$(cat "$ISO.sha256" 2>/dev/null || sha256sum "$ISO" | cut -c1-64 | tee "$ISO.sha256")
hash=$({ cd "$SRC" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum; echo "$iso_sum"; echo "$DOWNLOADS"; } | sha256sum | cut -c1-16)
install -d -m 755 "$ROOT" "$IMAGES"

# The newest image of this recipe still inside its licence window, if any
# (images of earlier installs are named by the hash alone).
existing=$(find "$IMAGES" -mindepth 2 -maxdepth 2 -name root.qcow2 -path "$IMAGES/$hash*" ! -path '*.part/*' -mtime -"$MAX_AGE_DAYS" -printf '%T@ %h\n' | sort -rn | head -1 | cut -d' ' -f2)
if [ -n "$existing" ]; then
  tag=$(basename "$existing")
else
  tag="$hash-$(date -u +%Y%m%d)"
fi

if [ ! -f "$IMAGES/$tag/root.qcow2" ]; then
  echo "building Windows CI image $tag"
  work="$ROOT/build-$tag"
  rm -rf "$work"
  install -d -m 700 "$work" "$work/cd"
  trap '[ -n "${qemu_pid:-}" ] && kill "$qemu_pid" 2>/dev/null; rm -rf "$work"' EXIT

  echo "$DOWNLOADS" | while IFS='|' read -r name url sum; do
    [ -n "$name" ] || continue
    curl -fsSL -o "$work/cd/$name" "$url"
    echo "$sum  $work/cd/$name" | sha256sum -c --quiet -
  done
  # A password for this build's one automatic logon; setup.ps1 turns the
  # logon off and nothing ever logs in with it again.
  password=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | cut -c1-20)Aa1!
  sed "s|@ADMIN_PASSWORD@|$password|g" "$SRC/autounattend.xml" > "$work/cd/autounattend.xml"
  cp "$SRC/setup.ps1" "$SRC/keys.ps1" "$work/cd/"
  genisoimage -quiet -V CIBUILD -J -r -o "$work/build.iso" "$work/cd"
  qemu-img create -q -f qcow2 "$work/disk.qcow2" 64G

  # Setup reboots several times; the VM powers off when setup.ps1 is done and
  # reports on COM1 whether it got there.
  qemu-system-x86_64 \
    -name iflink-ci-windows-build -machine q35,accel=kvm \
    -cpu host,hv_relaxed,hv_spinlocks=0x1fff,hv_vapic,hv_time -smp 8 -m 8192 \
    -nodefaults -no-user-config -vga std -display none -monitor none \
    -qmp "unix:$work/qmp.sock,server=on,wait=off" \
    -serial "file:$work/serial.log" \
    -device ahci,id=ahci \
    -drive "file=$work/disk.qcow2,if=none,id=root,format=qcow2,cache=unsafe,discard=unmap" -device ide-hd,drive=root,bus=ahci.0 \
    -drive "file=$ISO,if=none,id=setup,media=cdrom,readonly=on" -device ide-cd,drive=setup,bus=ahci.1 \
    -drive "file=$work/build.iso,if=none,id=build,media=cdrom,readonly=on" -device ide-cd,drive=build,bus=ahci.2 \
    -netdev user,id=net0 -device e1000e,netdev=net0 \
    -boot once=d &
  qemu_pid=$!
  deadline=$((SECONDS + BUILD_MINUTES * 60))
  while kill -0 "$qemu_pid" 2>/dev/null; do
    if [ "$SECONDS" -gt "$deadline" ]; then
      echo "Windows 镜像 $BUILD_MINUTES 分钟内没有装完；QMP: $work/qmp.sock" >&2
      trap - EXIT
      exit 1
    fi
    sleep 10
  done
  qemu_pid=""
  grep -q IFLINK-CI-IMAGE-READY "$work/serial.log" || {
    echo "setup.ps1 没有报告完成：" >&2
    tail -n 40 "$work/serial.log" >&2 || true
    exit 1
  }
  install -d -m 755 "$IMAGES/$tag.part"
  qemu-img convert -O qcow2 "$work/disk.qcow2" "$IMAGES/$tag.part/root.qcow2"
  chmod 644 "$IMAGES/$tag.part/root.qcow2"
  mv "$IMAGES/$tag.part" "$IMAGES/$tag"
fi
ln -sfn "$tag" "$IMAGES/current.part"
mv -T "$IMAGES/current.part" "$IMAGES/current"
find "$IMAGES" -mindepth 1 -maxdepth 1 -type d ! -name "$tag" ! -name '*.part' -printf '%T@ %f\n' \
  | sort -rn | cut -d' ' -f2 | while read -r old; do rm -rf "${IMAGES:?}/$old"; done
echo "Windows CI image: $(readlink "$IMAGES/current")"
