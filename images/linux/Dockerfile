# The CI job VM (runner/vm.mjs): Debian 13 with systemd, sshd, Docker and the
# toolchains the IF repositories build with. deploy/build-vm-image.sh turns
# this image's filesystem into vmlinuz, initrd.img and an ext4 root.img; every
# job boots a throwaway overlay of that disk.
FROM debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad

ARG NODE_VERSION=24.22.0
ARG NODE_SHA256=cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008
ARG NODE22_VERSION=22.23.5
ARG NODE22_SHA256=cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8
ARG GO_VERSION=1.27.4
ARG GO_SHA256=7226736c2339719cda28fbf3a54d71aa63bcefe376e98cef00034268dab24840
ARG BUN_VERSION=1.4.0
ARG BUN_SHA256=2d03fb5fb83ac8b567aca0a281b2ce1a1a19d488f56c2968d88c3f25e92fe452
ARG UV_VERSION=0.13.9
ARG UV_SHA256=a7fbaff2b9a271d85c1bdb540941090fd1ce011797b4abeb48e4dcd39c2471d5
# Docker's release signing key (docs.docker.com/engine/install/debian). Docker
# comes from its own repository, not Debian's: GitHub's runners carry a current
# Engine, and workflows use what Debian's 26.x lacks (e.g. `image save --platform`).
ARG DOCKER_KEY_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    linux-image-cloud-amd64 initramfs-tools systemd systemd-sysv udev dbus e2fsprogs sudo openssh-server \
    ca-certificates curl wget git jq unzip zip xz-utils zstd file procps less rsync iproute2 iputils-ping netcat-openbsd gnupg \
    build-essential pkg-config python3 python3-pip python3-venv python-is-python3 \
    postgresql-client default-mysql-client openjdk-21-jdk-headless \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /tmp/docker.asc \
 && test "$(gpg --show-keys --with-colons /tmp/docker.asc | awk -F: '$1 == "fpr" {print $10; exit}')" = "$DOCKER_KEY_FINGERPRINT" \
 && install -d -m 0755 /etc/apt/keyrings \
 && gpg --dearmor < /tmp/docker.asc > /etc/apt/keyrings/docker.gpg \
 && rm -rf /tmp/docker.asc /root/.gnupg \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian trixie stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/* \
 && docker --version && docker compose version && docker buildx version

RUN set -eu; cd /tmp; \
    fetch() { curl -fsSLo "$1" "$2"; echo "$3  $1" | sha256sum -c -; }; \
    fetch node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" "$NODE_SHA256"; \
    tar -xJf node.tar.xz -C /usr/local --strip-components=1 --no-same-owner; \
    corepack enable; \
    fetch node22.tar.xz "https://nodejs.org/dist/v${NODE22_VERSION}/node-v${NODE22_VERSION}-linux-x64.tar.xz" "$NODE22_SHA256"; \
    install -d /opt/node22; tar -xJf node22.tar.xz -C /opt/node22 --strip-components=1 --no-same-owner; \
    fetch go.tar.gz "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" "$GO_SHA256"; \
    tar -xzf go.tar.gz -C /usr/local --no-same-owner; \
    fetch bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" "$BUN_SHA256"; \
    unzip -q bun.zip; install -m 0755 bun-linux-x64/bun /usr/local/bin/bun; ln -s bun /usr/local/bin/bunx; \
    fetch uv.tar.gz "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz" "$UV_SHA256"; \
    tar -xzf uv.tar.gz; install -m 0755 uv-x86_64-unknown-linux-gnu/uv uv-x86_64-unknown-linux-gnu/uvx /usr/local/bin/; \
    rm -rf /tmp/*; \
    node --version; /opt/node22/bin/node --version; /usr/local/go/bin/go version; bun --version; uv --version

COPY guest/ /tmp/guest/
RUN cd /tmp/guest \
 && useradd --create-home --uid 1000 --user-group --groups docker,sudo --shell /bin/bash ci \
 && install -d -m 0755 /usr/local/libexec /usr/local/lib/iflink-ci /etc/systemd/network /etc/modules-load.d /etc/ssh/sshd_config.d \
 && install -m 0755 iflink-ci-guest-setup /usr/local/libexec/iflink-ci-guest-setup \
 && install -m 0644 gha.sh /usr/local/lib/iflink-ci/gha.sh \
 && install -m 0644 iflink-ci-guest-setup.service /etc/systemd/system/ \
 && install -m 0644 10-ci.network /etc/systemd/network/ \
 && install -m 0644 sshd.conf /etc/ssh/sshd_config.d/iflink-ci.conf \
 && install -m 0440 sudoers /etc/sudoers.d/ci \
 # Docker Hub through the build host's pull-through cache (caches/registry-cache.yml).
 && install -d -m 0755 /etc/docker && install -m 0644 docker-daemon.json /etc/docker/daemon.json \
 # Gradle reads init scripts from the user's init.d: Maven Central via the host cache.
 && install -d -m 0755 -o ci -g ci /home/ci/.gradle /home/ci/.gradle/init.d \
 && install -m 0644 -o ci -g ci iflink-maven.gradle /home/ci/.gradle/init.d/iflink-maven.gradle \
 && echo qemu_fw_cfg > /etc/modules-load.d/iflink-ci.conf \
 # Host keys come from the runner on each boot; none may be shared by all VMs.
 && rm -f /etc/ssh/ssh_host_* \
 && : > /etc/machine-id \
 && systemctl enable systemd-networkd iflink-ci-guest-setup ssh docker containerd \
 && systemctl mask getty@tty1 serial-getty@ttyS0 systemd-resolved systemd-timesyncd apt-daily.timer apt-daily-upgrade.timer e2scrub_reap ssh.socket \
 && rm -rf /tmp/guest \
 && echo RESUME=none > /etc/initramfs-tools/conf.d/resume \
 && update-initramfs -u -k all
