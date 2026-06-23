#!/usr/bin/env bash
# Setup ragstack log server on a fresh Ubuntu 22.04/24.04 VM.
#
# Usage:
#   sudo INVOKING_USER=$USER bash setup-log-server.sh
#
# Env vars:
#   INVOKING_USER  user to add to docker group (default: SUDO_USER or current logname)
#   RESET_DOCKER   set to 1 to nuke /var/lib/docker + /var/lib/containerd before reinstall
#                  (use when daemon failed after docker.io → docker-ce transition)
#
# What it does:
#   1. Install Docker CE + compose plugin (idempotent, handles Ubuntu 24.04 conflicts)
#   2. Recover from common docker.io ↔ docker-ce transition pitfalls (containerd state)
#   3. Configure UFW with proper source CIDR scoping for syslog ports
#   4. Add invoking user to docker group (so non-sudo docker compose works)
#   5. Print next steps + secret generation hints
set -euo pipefail

INVOKING_USER="${INVOKING_USER:-${SUDO_USER:-$(logname 2>/dev/null || echo root)}}"
RESET_DOCKER="${RESET_DOCKER:-0}"
LAN_CIDR="${LAN_CIDR:-192.168.122.0/24}"  # adjust if your lab/prod subnet differs

# ---------- [1/7] Install Docker + compose plugin ----------
echo "[1/7] Install Docker + compose plugin"
apt-get update -y
apt-get install -y ca-certificates curl gnupg ufw jq

# Idempotent: nếu Docker CE + compose plugin đã hoạt động, skip cài lại.
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 \
   && systemctl is-active --quiet docker; then
  echo "  Docker + compose plugin đã sẵn sàng — skip install."
  echo "  $(docker --version)"
  echo "  $(docker compose version)"
else
  # Ubuntu 24.04 ship sẵn 'docker-compose-v2' (universe repo) hoặc 'docker.io' (cũ).
  # Hai gói này conflict với 'docker-compose-plugin' + 'docker-ce' từ Docker official repo
  # (cùng path /usr/libexec/docker/cli-plugins/docker-compose). Gỡ trước khi cài.
  for pkg in docker-compose-v2 docker.io docker-doc docker-compose podman-docker containerd runc; do
    if dpkg -s "$pkg" >/dev/null 2>&1; then
      echo "  Removing conflicting package: $pkg"
      apt-get remove -y "$pkg" || true
    fi
  done

  # Stop services left over from old packages — tránh metadata.db state conflict
  systemctl stop docker.socket docker.service containerd 2>/dev/null || true

  # Nếu transition cũ làm hỏng containerd state, reset bằng RESET_DOCKER=1
  # (mất images/containers cũ — chỉ chạy nếu VM mới hoặc sẵn sàng pull lại).
  if [[ "$RESET_DOCKER" == "1" ]]; then
    echo "  RESET_DOCKER=1 → nuking /var/lib/docker và /var/lib/containerd"
    rm -rf /var/lib/docker /var/lib/containerd
    rm -f /etc/docker/daemon.json
  fi

  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

  # Start containerd TRƯỚC docker — docker init cần containerd metadata.db tồn tại
  systemctl daemon-reload
  systemctl enable --now containerd
  sleep 2
  systemctl enable --now docker
  sleep 2

  if ! systemctl is-active --quiet docker; then
    echo "  ⚠️  Docker daemon không start được. Check: journalctl -xeu docker"
    echo "      Nếu thấy 'metadata.db: no such file' → rerun với RESET_DOCKER=1"
    exit 1
  fi
fi

# ---------- [2/7] Add invoking user to docker group ----------
echo "[2/7] Add user '$INVOKING_USER' to docker group"
if [[ "$INVOKING_USER" != "root" ]] && id -u "$INVOKING_USER" >/dev/null 2>&1; then
  usermod -aG docker "$INVOKING_USER"
  echo "  ✓ '$INVOKING_USER' added to docker group."
  echo "    ⚠️  Re-login (or run 'newgrp docker') để áp group lên shell hiện tại."
fi

# ---------- [3/7] UFW (firewall) ----------
echo "[3/7] Firewall (UFW)"
ufw --force enable
ufw allow 22/tcp comment "ssh"
# Syslog ingest — scope to LAN_CIDR (override env nếu cần)
ufw allow from "$LAN_CIDR" to any port 514 proto udp comment "syslog udp"
ufw allow from "$LAN_CIDR" to any port 6514 proto tcp comment "syslog tcp"
ufw allow from "$LAN_CIDR" to any port 80 proto tcp comment "http caddy"
ufw allow from "$LAN_CIDR" to any port 443 proto tcp comment "https caddy"
ufw status verbose | head -20

# ---------- [4/7] System tuning (NTP + hostname) ----------
echo "[4/7] System tuning"
timedatectl set-ntp true || true
# Tránh sudo warning "unable to resolve host"
if ! grep -q "127.0.1.1.*$(hostname)" /etc/hosts; then
  echo "127.0.1.1 $(hostname)" >> /etc/hosts
fi

# ---------- [5/7] Secret generation hints ----------
echo "[5/7] Sinh secret cho .env (copy vào infra/.env, KHÔNG commit):"
echo "  QDRANT_API_KEY=$(openssl rand -hex 32)"
echo "  POSTGRES_PASSWORD=$(openssl rand -hex 24)"
echo "  REDIS_PASSWORD=$(openssl rand -hex 24)"

# ---------- [6/7] Next steps ----------
echo
echo "[6/7] Bring up stack (chạy với quyền user, không sudo, sau khi re-login):"
echo "  cd \$REPO_ROOT/infra"
echo "  cp .env.example .env  &&  nano .env   # paste 3 secret ở trên + API keys"
echo "  docker compose up -d"
echo "  docker compose ps     # all 5 services Up + healthy"

# ---------- [7/7] Verify ----------
echo
echo "[7/7] Smoke test (sau khi compose up):"
echo "  bash scripts/healthcheck.sh                        # tất cả OK"
echo "  logger -n 127.0.0.1 -P 514 -t smoke 'hello'        # ingest test"
echo "  curl 'http://localhost:9428/select/logsql/query?query=service:smoke&limit=5'"
echo
echo "Done. Next: cài rsyslog forwarder trên client với scripts/setup-rsyslog-client.sh"
