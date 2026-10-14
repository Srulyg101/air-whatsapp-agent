#!/usr/bin/env bash
# Air Agent one-command installer for a fresh Ubuntu/Debian VPS (e.g. Hostinger).
# Usage (as root, inside the repo folder):  bash install.sh
set -euo pipefail
cd "$(dirname "$0")"
say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo bash install.sh)"; exit 1; }

say "Freeing disk space"
df -h / | tail -1
apt-get clean -y >/dev/null 2>&1 || true
apt-get autoremove -y >/dev/null 2>&1 || true
journalctl --vacuum-size=100M >/dev/null 2>&1 || true
rm -rf /tmp/* /var/tmp/* 2>/dev/null || true
command -v docker >/dev/null && docker system prune -f >/dev/null 2>&1 || true
df -h / | tail -1

say "Installing Docker (if missing)"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || apt-get install -y docker-compose-plugin

RAM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
say "Server RAM: ${RAM_MB} MB"

# Swap keeps small VPSes from crashing while the model loads
if [ "$(swapon --show | wc -l)" -eq 0 ] && [ "$RAM_MB" -lt 16000 ]; then
  say "Adding 4G swap"
  fallocate -l 4G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=4096
  chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if [ ! -f .env ]; then
  cp .env.example .env
  if   [ "$RAM_MB" -lt 6000 ];  then MODEL=qwen2.5:1.5b
  elif [ "$RAM_MB" -lt 14000 ]; then MODEL=qwen2.5:3b
  else MODEL=qwen2.5:7b; fi
  sed -i "s/^MODEL=.*/MODEL=${MODEL}/" .env
  say "Picked model ${MODEL} for this server (edit .env to change)"
fi



if command -v ufw >/dev/null && ufw status | grep -q active; then
  ufw allow 8080/tcp >/dev/null
fi

say "Building and starting (first run downloads the AI model — a few minutes)"
docker compose up -d

IP=$(curl -fsS -4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
say "Done!"
echo "  Dashboard:        http://${IP}:8080"
echo "  Uptime monitor:   ssh -L 3001:localhost:3001 root@${IP}  then open http://localhost:3001"
echo "  Model download:   docker compose logs -f ollama-pull"
echo "  App logs:         docker compose logs -f app"
echo
echo "  1) Open the dashboard and create the first account (it becomes admin)."
echo "  2) Admin page: create accounts for other people (public sign-ups are off by default)."
echo "  3) Each person scans their own number on the Home page. The AI only answers its owner until they change Reply rules."
