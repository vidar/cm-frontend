#!/usr/bin/env bash
# Cloudflare Tunnel from hetz-stock to Cloudflare, so Hyperdrive reaches the local PostgreSQL without any
# open port (Workers VPC route: no public hostname, no DNS record). As root, after creating the tunnel in
# the dashboard (Workers & Pages > VPC > Tunnels > Create, name "cm-db") and copying its token:
#
#   sudo bash ops/postgres/tunnel.sh               # installs cloudflared, asks for the token once, starts it
#   sudo bash ops/postgres/tunnel.sh --new-token   # replace the stored token (a wrong paste, a new tunnel)
#
# The token is pasted into this script on the server (TTY: ssh -t ... 'ssh -t hetz-stock'), stored in
# /etc/cloudflared/cm-db.token (root only) and handed to the service with systemd LoadCredential, so it never
# shows in `ps` or in a unit file. Safe to run again (updates the unit; keeps the token).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TOKEN=/etc/cloudflared/cm-db.token
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root (sudo)"
NEW=0
case ${1:-} in --new-token) NEW=1 ;; '') ;; *) echo "usage: $0 [--new-token]" >&2; exit 2 ;; esac
# A tunnel token is base64 of JSON with the account (a), tunnel (t) and secret (s). Read from the file,
# never from a command line.
valid_token() {
  python3 -I - "$1" <<'PY'
import base64, json, sys
t = open(sys.argv[1]).read().strip()
try:
    ok = {'a', 't', 's'} <= json.loads(base64.urlsafe_b64decode(t.replace('+', '-').replace('/', '_') + '=' * (-len(t) % 4))).keys()
except Exception:
    ok = False
sys.exit(0 if ok else 1)
PY
}

# 1. cloudflared from Cloudflare's apt repository ("any" suite: all Debian-based releases), kept up to
#    date by unattended-upgrades (Cloudflare supports releases from the last year).
if ! command -v cloudflared >/dev/null; then
  install -d -m 755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q cloudflared
fi
ver=$(cloudflared --version | grep -oE '[0-9]{4}\.[0-9]+\.[0-9]+' | head -1)
[ "$(printf '%s\n2025.7.0\n' "$ver" | sort -V | head -1)" = 2025.7.0 ] || die "cloudflared $ver is too old (Workers VPC needs 2025.7.0 or later)"
echo "cloudflared $ver"

# 2. The token (once).
install -d -m 700 /etc/cloudflared
if [ -s "$TOKEN" ] && ! valid_token "$TOKEN"; then echo "the stored token is not a tunnel token: paste it again"; NEW=1; fi
if [ "$NEW" = 1 ] || [ ! -s "$TOKEN" ]; then
  [ -t 0 ] || die "no terminal to paste the token into: run with ssh -t (see README.md)"
  echo "Paste the tunnel token (the long eyJ... value; the whole install command works too), then Enter and Ctrl-D:"
  # Keep only the eyJ... word, wherever it is in what was pasted.
  (umask 077; tr -s '[:space:]' '\n' | grep -m1 -E '^eyJ[A-Za-z0-9+/=_-]+$' > "$TOKEN.new" || true)
  if ! valid_token "$TOKEN.new"; then rm -f "$TOKEN.new"; die "that is not a tunnel token (the eyJ... value in the dashboard's install command); run this again"; fi
  mv "$TOKEN.new" "$TOKEN"
fi
chmod 600 "$TOKEN"

# 3. Updates: apt replaces the binary but doesn't restart the service, so the old one would keep running.
#    After every dpkg run, restart the tunnel if (and only if) its binary was replaced.
cat > /usr/local/sbin/cm-db-tunnel-refresh <<'SH'
#!/bin/sh
# Installed by ops/postgres/tunnel.sh; run by apt (/etc/apt/apt.conf.d/52cloudflared-unattended).
pid=$(systemctl show -p MainPID --value cloudflared-cm-db.service 2>/dev/null)
[ -n "$pid" ] && [ "$pid" != 0 ] || exit 0
case $(readlink "/proc/$pid/exe") in *"(deleted)") systemctl try-restart cloudflared-cm-db.service ;; esac
exit 0
SH
chmod 755 /usr/local/sbin/cm-db-tunnel-refresh
cat > /etc/apt/apt.conf.d/52cloudflared-unattended <<'APT'
// Written by ops/postgres/tunnel.sh: unattended-upgrades updates cloudflared; restart the tunnel after it.
Unattended-Upgrade::Origins-Pattern { "origin=cloudflared,codename=any"; };
DPkg::Post-Invoke { "/usr/local/sbin/cm-db-tunnel-refresh || true"; };
APT

# 4. The service. It counts as started once it has a connection; don't wait for that (if QUIC is blocked
#    it would wait for ever): poll the readiness endpoint instead.
install -m 644 "$HERE/systemd/cloudflared-cm-db.service" /etc/systemd/system/cloudflared-cm-db.service
systemctl daemon-reload
systemctl enable -q cloudflared-cm-db.service
systemctl restart --no-block cloudflared-cm-db.service
echo "waiting for the tunnel to connect (up to 60 s)..."
for _ in $(seq 1 60); do curl -fs -m 2 -o /dev/null http://127.0.0.1:20299/ready && break; sleep 1; done
if ! curl -fs -m 2 -o /dev/null http://127.0.0.1:20299/ready; then
  journalctl -u cloudflared-cm-db -n 30 --no-pager || true
  die "the tunnel has no connection yet (its log is above; it keeps trying in the background).
  'Unauthorized' or 'invalid token': run this again with --new-token.
  QUIC or 'timeout' errors: allow outbound UDP 7844 (README.md step 5)."
fi
# This tunnel's process only (another cloudflared on the box, e.g. for the engine, is not ours to judge).
pid=$(systemctl show -p MainPID --value cloudflared-cm-db.service)
if ps -o args= -p "$pid" | grep -q 'eyJ'; then die "the token is visible in ps: check the unit file"; fi
journalctl -u cloudflared-cm-db -n 20 --no-pager | grep -iE 'registered tunnel connection' || true
echo "Tunnel connected. The dashboard (VPC > Tunnels > cm-db) should show it Healthy; connections should say protocol=quic."
