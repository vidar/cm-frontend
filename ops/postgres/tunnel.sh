#!/usr/bin/env bash
# Cloudflare Tunnel from hetz-stock to Cloudflare, so Hyperdrive reaches the local PostgreSQL without any
# open port (Workers VPC route: no public hostname, no DNS record). As root, after creating the tunnel in
# the dashboard (Workers & Pages > VPC > Tunnels > Create, name "cm-db") and copying its token:
#
#   sudo bash ops/postgres/tunnel.sh     # installs cloudflared, asks for the token once, starts the service
#
# The token is pasted into this script on the server (TTY: ssh -t ... 'ssh -t hetz-stock'), stored in
# /etc/cloudflared/cm-db.token (root only) and handed to the service with systemd LoadCredential, so it never
# shows in `ps` or in a unit file. Safe to run again (updates the unit; keeps the token).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TOKEN=/etc/cloudflared/cm-db.token
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root (sudo)"

# 1. cloudflared from Cloudflare's apt repository ("any" suite: all Debian-based releases), kept up to
#    date by unattended-upgrades (Cloudflare supports releases from the last year).
if ! command -v cloudflared >/dev/null; then
  install -d -m 755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q cloudflared
fi
echo 'Unattended-Upgrade::Origins-Pattern { "origin=cloudflared,codename=any"; };' > /etc/apt/apt.conf.d/52cloudflared-unattended
ver=$(cloudflared --version | grep -oE '[0-9]{4}\.[0-9]+\.[0-9]+' | head -1)
[ "$(printf '%s\n2025.7.0\n' "$ver" | sort -V | head -1)" = 2025.7.0 ] || die "cloudflared $ver is too old (Workers VPC needs 2025.7.0 or later)"
echo "cloudflared $ver"

# 2. The token (once).
install -d -m 700 /etc/cloudflared
if [ ! -s "$TOKEN" ]; then
  [ -t 0 ] || die "no token yet and no terminal to paste it into: run with ssh -t (see README.md)"
  echo "Paste the tunnel token (the long eyJ... value only), then Enter and Ctrl-D:"
  (umask 077; tr -d ' \r\n' > "$TOKEN")
  [ -s "$TOKEN" ] || { rm -f "$TOKEN"; die "empty token"; }
fi
chmod 600 "$TOKEN"

# 3. The service.
install -m 644 "$HERE/systemd/cloudflared-cm-db.service" /etc/systemd/system/cloudflared-cm-db.service
systemctl daemon-reload
systemctl enable -q cloudflared-cm-db.service
systemctl restart cloudflared-cm-db.service
sleep 5
systemctl is-active -q cloudflared-cm-db.service || die "the tunnel did not start: journalctl -u cloudflared-cm-db -n 50"
if ps -o args= -C cloudflared | grep -q 'eyJ'; then die "the token is visible in ps: check the unit file"; fi
journalctl -u cloudflared-cm-db -n 20 --no-pager | grep -iE 'registered tunnel connection|error' || true
echo "Tunnel running. The dashboard (VPC > Tunnels > cm-db) should show it Healthy; connections should say protocol=quic."
