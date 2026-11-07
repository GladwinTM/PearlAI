#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu 24.04 VM (Oracle Cloud Ampere A1 or any Linux box), then (re)deploy.
# Usage on the VM:   bash deploy/oracle/setup.sh
# Re-run it any time to deploy the latest code (it pulls and rebuilds).
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"

if ! command -v docker >/dev/null 2>&1; then
  echo "→ Installing Docker"
  sudo apt-get update -y
  sudo apt-get install -y docker.io docker-compose-v2 iptables-persistent
  sudo usermod -aG docker "$USER"
fi

# Oracle's Ubuntu images reject inbound traffic in iptables besides SSH; open HTTP/HTTPS (idempotent).
for port in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
    echo "→ Opening TCP $port"
    # Insert before the image's catch-all REJECT rule (if any), otherwise append.
    reject_at="$(sudo iptables -L INPUT --line-numbers | awk '/REJECT/ {print $1; exit}')"
    if [ -n "$reject_at" ]; then
      sudo iptables -I INPUT "$reject_at" -p tcp --dport "$port" -m state --state NEW -j ACCEPT
    else
      sudo iptables -A INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT
    fi
  fi
done
sudo netfilter-persistent save >/dev/null 2>&1 || true

if [ ! -f "$ROOT/.env" ]; then
  echo "✗ Missing $ROOT/.env (the server's secrets). Create it, then re-run. See docs/DEPLOY.md." >&2
  exit 1
fi
if [ ! -f .env ]; then
  ip="$(curl -fsS https://ifconfig.me)"
  echo "AGENT_DOMAIN=${ip//./-}.sslip.io" > .env
  echo "→ AGENT_DOMAIN set to ${ip//./-}.sslip.io (edit deploy/oracle/.env to use your own domain)"
fi

echo "→ Updating code"
git -C "$ROOT" pull --ff-only || true

echo "→ Building and starting (first build takes ~10 minutes)"
sudo docker compose up -d --build
sudo docker image prune -f >/dev/null

domain="$(grep AGENT_DOMAIN .env | cut -d= -f2)"
echo "→ Waiting for https://$domain/api/health"
for _ in $(seq 1 60); do
  if curl -fsS "https://$domain/api/health" >/dev/null 2>&1; then
    curl -fsS "https://$domain/api/health" | head -c 300; echo
    echo "✓ Agent is live at https://$domain"
    exit 0
  fi
  sleep 5
done
echo "✗ Not reachable yet. Check: sudo docker compose logs --tail 50" >&2
exit 1
