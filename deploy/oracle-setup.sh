#!/usr/bin/env bash
# First-boot of kapi on an Oracle Always Free Ampere A1 VM (2 OCPU / 12 GB).
# Run as a sudoer on Ubuntu after you can SSH in.
set -euo pipefail

if [[ ${EUID} -eq 0 ]]; then
  echo "run this as a normal user with sudo, not as root"
  exit 1
fi

sudo apt-get update
sudo apt-get install -y ca-certificates curl git

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  echo "docker installed. log out and back in, then re-run this script."
  exit 0
fi

if [[ ! -f .env ]]; then
  echo "copy .env.example to .env and fill GEMINI_API_KEY, DATABASE_URL, GITHUB_TOKEN, KAPI_HOST"
  exit 1
fi

# shellcheck disable=SC1091
set -a
source .env
set +a

: "${DATABASE_URL:?set DATABASE_URL to the Neon pooled connection string}"
: "${GEMINI_API_KEY:?set GEMINI_API_KEY}"
: "${KAPI_HOST:?set KAPI_HOST to the DNS name pointing at this VM}"

export KAPI_PUBLIC_URL="https://${KAPI_HOST}"
export SANDBOX_PROVIDER="${SANDBOX_PROVIDER:-docker}"
export KAPI_AUTH_MODE="${KAPI_AUTH_MODE:-none}"

docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
echo
echo "dashboard: https://${KAPI_HOST}"
echo "health:    https://${KAPI_HOST}/api/health"
