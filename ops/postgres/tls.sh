#!/usr/bin/env bash
# A TLS certificate for PostgreSQL that Cloudflare trusts (Hyperdrive only connects with TLS, and the
# Workers VPC service checks the certificate against public CAs and Cloudflare's Origin CA). The private
# key is made here and never leaves the server; Cloudflare only sees the certificate request. As root:
#
#   sudo bash ops/postgres/tls.sh            # 1. makes the key and the request, prints the request
#      -> Cloudflare dashboard, chessmoments.com > SSL/TLS > Origin Server > Create Certificate:
#         "Use my private key and CSR", paste the request, only hostname pg.chessmoments.com, Create, PEM
#   sudo bash ops/postgres/tls.sh --install  # 2. paste the certificate it shows (then Enter, Ctrl-D)
#   sudo bash ops/postgres/tls.sh --conf     # (install.sh) point the cluster at the certificate, no reload
#
# Step 2 checks that the certificate belongs to the key, switches Postgres to it (conf.d/70-tls.conf)
# and reloads. The certificate is public; nothing secret is pasted anywhere. Origin CA certificates last
# up to 15 years (pick the longest), so there is no renewal to forget. Key and certificate live where Debian
# keeps them (/etc/ssl/private, root:ssl-cert 640, postgres being in ssl-cert; /etc/ssl/certs), not in a
# cluster's directory, so a new major version (pg_upgradecluster, then install.sh) presents the same one.
set -euo pipefail
NAME=${TLS_NAME:-pg.chessmoments.com}
CLUSTER=${CLUSTER:-main}
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root (sudo)"
PGVER=${PGVER:-${PGMAJOR:-18}}   # the version install.sh set up
CONF=/etc/postgresql/$PGVER/$CLUSTER
[ -d "$CONF" ] || die "no cluster at $CONF (run install.sh first)"
KEY=/etc/ssl/private/cm-origin.key CRT=/etc/ssl/certs/cm-origin.crt CSR=/etc/ssl/cm-origin.csr
getent group ssl-cert >/dev/null || die "no ssl-cert group (it comes with the ssl-cert package, which postgresql installs)"

# Files an earlier version of this script kept in a cluster's directory move to the places above.
for ext in key crt csr; do
  new=$KEY; [ "$ext" = crt ] && new=$CRT; [ "$ext" = csr ] && new=$CSR
  old=$(ls /etc/postgresql/*/"$CLUSTER"/cm-origin."$ext" 2>/dev/null | head -1 || true)
  [ -s "$new" ] || [ -z "$old" ] || cp -p "$old" "$new"
done
if [ -s "$KEY" ]; then chown root:ssl-cert "$KEY"; chmod 640 "$KEY"; fi
if [ -s "$CRT" ]; then chown root:root "$CRT"; chmod 644 "$CRT"; fi   # public

write_conf() {
  cat > "$CONF/conf.d/70-tls.conf" <<EOF
# written by ops/postgres/tls.sh: Cloudflare Origin CA certificate for $NAME (Hyperdrive via Workers VPC)
ssl = on
ssl_cert_file = '$CRT'
ssl_key_file = '$KEY'
ssl_min_protocol_version = 'TLSv1.2'
EOF
  chown postgres:postgres "$CONF/conf.d/70-tls.conf"
}

case ${1:-} in
  --conf)
    # For install.sh: once there is a certificate, this cluster uses it (install.sh reloads).
    if [ -s "$CRT" ] && [ -s "$KEY" ]; then write_conf; echo "TLS: $CRT"; fi
    exit 0 ;;
  --install) ;;
  '')
    if [ ! -s "$KEY" ]; then
      (umask 077; openssl req -new -newkey rsa:2048 -nodes -subj "/CN=$NAME" -addext "subjectAltName=DNS:$NAME" -keyout "$KEY" -out "$CSR" 2>/dev/null)
      chown root:ssl-cert "$KEY"; chmod 640 "$KEY"; chmod 644 "$CSR"
    fi
    echo "Certificate request for $NAME (public; paste it into the Cloudflare dashboard as described at the top of this script):"
    echo
    cat "$CSR"
    echo
    echo "Then run: sudo bash $0 --install"
    exit 0 ;;
  *) echo "usage: $0 [--install | --conf]" >&2; exit 2 ;;
esac

[ -s "$KEY" ] || die "no key yet: run this script without --install first"
echo "Paste the certificate (-----BEGIN CERTIFICATE----- ... -----END CERTIFICATE-----), then Enter and Ctrl-D:"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
cat > "$tmp"
openssl x509 -in "$tmp" -noout >/dev/null 2>&1 || die "that is not a PEM certificate"
[ "$(openssl x509 -in "$tmp" -noout -pubkey | openssl sha256)" = "$(openssl pkey -in "$KEY" -pubout | openssl sha256)" ] \
  || die "the certificate does not belong to this server's key (was it made from this request?)"
openssl x509 -in "$tmp" -noout -subject -issuer -enddate
install -m 644 -o root -g root "$tmp" "$CRT"
write_conf
if [ -d /run/systemd/system ]; then systemctl reload "postgresql@$PGVER-$CLUSTER"; else pg_ctlcluster "$PGVER" "$CLUSTER" reload; fi
sleep 1
[ "$(runuser -u postgres -- psql -X -At -p "$(pg_conftool -s "$PGVER" "$CLUSTER" show port)" -d postgres -c "SHOW ssl_cert_file")" = "$CRT" ] \
  || die "Postgres did not pick up the certificate: journalctl -u postgresql@$PGVER-$CLUSTER"
echo "PostgreSQL now presents the Origin CA certificate for $NAME."
