# The games database on hetz-stock

The site's PostgreSQL database (TWIC games, players and events, engine analyses, AI notes, organisers'
uploads) runs on the Hetzner server **hetz-stock**, next to stockfish-svc and render-svc. It replaced Neon,
whose awake-time billing didn't fit a site that crawlers keep awake. This folder is the whole setup, as
scripts that can be run again safely.

```
Worker (chessmoments.com)
  └─ Hyperdrive config "cm-games-hetz" (connection pool + 60 s query cache)
       └─ Workers VPC service "cm-db-postgres" (TCP 127.0.0.1:5432, checks the TLS certificate)
            └─ Cloudflare Tunnel "cm-db": cloudflared on hetz-stock, outbound only (no open port, no DNS record)
                 └─ PostgreSQL 18, cluster 18/main, database cm_games, listening on localhost only
```

- **Roles:** `cm_owner` owns the database and every table (imports, maintenance; root becomes it over the
  local socket without a password); `cm_web` is what Hyperdrive logs in as, with exactly the rights in
  [`scripts/db/grants.sql`](../../scripts/db/grants.sql), TLS required, 40 connections at most, 30 s per
  statement; `postgres` (superuser) only over the local socket.
- **Secrets stay on the server** (`/etc/cm-db/`, root only): `cm_owner.password`, `cm_web.password`, during
  the move `neon.env`; the tunnel token in `/etc/cloudflared/cm-db.token`. They are never pasted into a chat:
  you paste them into a terminal on the server or a Cloudflare form.
- **Backups:** nightly full dump at 03:20 UTC (7 daily + 5 weekly kept) and every 6 hours the tables that can't
  be rebuilt from TWIC (analyses, AI notes, uploads), in `/var/backups/cm-db/` (root only: TWIC data may not be
  republished in bulk). Each dump is checked before it replaces an older one. Off-site copy: see step 10.
- **Health check** every 15 minutes (`cm-db-check`): Postgres up, backups fresh, disk below 85 %, tunnel up.
  Failures go to the journal, and to e-mail if `HC_URL` is set (step 10).

| File | What it is |
|---|---|
| `install.sh` | Installs and configures Postgres, roles, database, backups and checks (step 1) |
| `postgresql.conf`, `pg_hba.conf`, `postgresql.service.d.conf` | Settings (≈1 GB of memory), access rules, systemd drop-in |
| `migrate-from-neon.sh`, `compare.sh` | The move from Neon, verified table by table (steps 2–3) |
| `tls.sh` | Cloudflare Origin CA certificate for Postgres (step 4) |
| `tunnel.sh`, `systemd/cloudflared-cm-db.service` | The tunnel (step 5) |
| `backup.sh`, `check.sh`, `restore.sh`, `systemd/cm-db-*` | Backups, health check, restore |
| `../../scripts/db/grants.sql` | `cm_web`'s rights (also applied by the TWIC importer) |

## Moving from Neon (one time)

Everything below runs on hetz-stock as root unless it says "dashboard". A shell there goes through the Mac
mini; use `-t` twice whenever a step asks you to paste something:

```sh
ssh -t vidar@100.120.87.91 'ssh -t hetz-stock'
```

The site is in maintenance mode while the database routes are closed (`MAINTENANCE` "1" in `wrangler.jsonc`),
so nothing writes to Neon during the move. Keep it that way until step 8.

### 0. Copy the kit to the server

From a machine with a checkout of the repository (branch `claude/nice-darwin-fmxre9` until it is merged):

```sh
cd cm-frontend && git pull
tar czf - ops/postgres scripts/db scripts/twic scripts/*.pg.sql \
  | ssh vidar@100.120.87.91 'ssh hetz-stock "rm -rf cm-db-kit && mkdir cm-db-kit && tar xzf - -C cm-db-kit"'
```

Check the box first: `free -h` (about 4 GB should be free besides the page cache), `df -h /` (the database needs
about 4 GB, backups about 8 GB), `swapon --show`.

### 1. Install Postgres

```sh
sudo bash ~/cm-db-kit/ops/postgres/install.sh
sudo ss -ltnp | grep 5432        # must show only 127.0.0.1:5432 and [::1]:5432
```

It ends with "done" and where the passwords are. (`TAILSCALE_IP=100.77.91.56` in front also lets `cm_owner` in
from the Mac mini over Tailscale; not needed, imports can run on the server.)

### 2. The Neon connection string

Neon console → project → **Connect** → role `neondb_owner` (the owner, not `readonly`) → show the password →
copy the connection string. On the server (paste, Enter, Ctrl-D):

```sh
sudo sh -c 'umask 077; cat > /etc/cm-db/neon.env'
NEON_DATABASE_URL=postgresql://neondb_owner:...@ep-lively-tree-b1dbxley-pooler.c-5.eu-central-1.aws.neon.tech/neondb?sslmode=require
```

(The pooled or the direct host both work; the script uses the direct one, which `pg_dump` needs.) While you
are in the console, note whether the organisation has other projects (the old Railway app "chessbiz" may have
one), so step 11 deletes only this one.

### 3. Copy and verify

```sh
sudo bash ~/cm-db-kit/ops/postgres/migrate-from-neon.sh
```

About 15–30 minutes: dump (Neon's compute is awake for those minutes), restore, grants, VACUUM ANALYZE, then
every table compared with Neon (row counts and checksums of every row, sequence, indexes, constraints, locale).
It must end with **ALL OK**. A mismatch means Neon changed after the dump: run it again with `--verify`; if a
restore failed after a good dump, `--reuse /var/lib/postgresql/migration/neon-<time>.dump` skips the dump.
The dump stays in `/var/lib/postgresql/migration/` as the final copy of the Neon database.

### 4. TLS certificate

Hyperdrive only connects with TLS, and the VPC service checks the certificate. The key is made on the server and
never leaves it:

```sh
sudo bash ~/cm-db-kit/ops/postgres/tls.sh
```

Dashboard: **chessmoments.com → SSL/TLS → Origin Server → Create Certificate** → "Use my private key and CSR" →
paste the request it printed → hostname `pg.chessmoments.com` → PEM → longest validity → Create. Copy the
certificate (it is public), then:

```sh
sudo bash ~/cm-db-kit/ops/postgres/tls.sh --install      # paste, Enter, Ctrl-D
```

### 5. Tunnel

Dashboard: **Workers & Pages → VPC → Tunnels → Create** → name `cm-db` → copy only the token (the long `eyJ…`
value in the install command it shows; ignore the command). On the server:

```sh
sudo bash ~/cm-db-kit/ops/postgres/tunnel.sh             # paste the token, Enter, Ctrl-D
```

The dashboard should show the tunnel **Healthy**. Workers VPC needs QUIC: if it stays down and the journal
(`journalctl -u cloudflared-cm-db -n 50`) shows QUIC timeouts, allow outbound UDP 7844 in the Hetzner Cloud
firewall (Hetzner console → server → Firewalls), if one is attached.

### 6. VPC service

Dashboard: **Workers & Pages → VPC → Services → Create**: name `cm-db-postgres`, type TCP, tunnel `cm-db`, host
`127.0.0.1`, port `5432`, application protocol PostgreSQL, certificate verification **Verify CA** (`verify_ca`:
the certificate is checked against Cloudflare's Origin CA; it is issued for a name, not for 127.0.0.1). Or on a
machine where wrangler is logged in (nothing secret):

```sh
npx wrangler vpc service create cm-db-postgres --type tcp --tcp-port 5432 --app-protocol postgresql \
  --tunnel-id <tunnel id> --ipv4 127.0.0.1 --cert-verification-mode verify_ca
```

### 7. Hyperdrive config

Dashboard: **Storage & Databases → Hyperdrive → Create configuration → Private database → Workers VPC** →
`cm-db-postgres`. Name `cm-games-hetz`, database `cm_games`, user `cm_web`, password: on the server
`sudo cat /etc/cm-db/cm_web.password`, copy it into the form. Caching on (defaults), **origin connection limit
20**. Creating it connects once to test; an error here is a TLS or tunnel problem (Troubleshooting below).

Copy the new config's **ID** (not a secret) and give it to Claude, or do step 8 yourself.

### 8. Switch the site

In `wrangler.jsonc`: the new id in both `hyperdrive` blocks (top level and `previews`), `MAINTENANCE` "0" in both
`vars` blocks (reopens the database routes), and `placement` `{ "region": "gcp:europe-north1" }` (Finland, next
to the database; it was Frankfurt for Neon). Claude tests the previews block on the branch's preview URL first,
then you say "merge" and the push to `main` deploys it.

### 9. Check it works

- https://chessmoments.com/games/ , a game, a player, an event, `/sitemaps/index.xml`: 200, no errors.
- "Analyse with Stockfish" and "Write notes with AI" on a game.
- On the server, Hyperdrive's sessions come over the tunnel with TLS:

```sh
sudo -u postgres psql -d cm_games -c "SELECT a.usename, a.client_addr, s.ssl, s.version, count(*) FROM pg_stat_activity a JOIN pg_stat_ssl s USING (pid) WHERE a.usename = 'cm_web' GROUP BY 1, 2, 3, 4"
```

(expect `cm_web | 127.0.0.1 | t | TLSv1.3`). Then purge the edge cache tag `games-db` only if pages look wrong:
the data is identical, so cached pages stay valid.

**Rollback** (while Neon still exists): put the old id `ff39804dfb964a2ca13a9e1d7ec27cbe` back in `wrangler.jsonc`
and deploy. Analyses and AI notes written on hetz-stock in between would be missing on Neon.

### 10. Backups off the box, and an alarm

The timers are already running (`systemctl list-timers 'cm-db-*'`; dumps in `/var/backups/cm-db/`). The first
nightly dump appears after 03:20 UTC. For a copy that survives losing the server, pick one:

- **Pull to the Mac mini** (nothing new to sign up for): put `BACKUP_GROUP=<the login user on hetz-stock>` in
  `/etc/cm-db/backup.env` so that user can read the dumps, then on the Mac mini run nightly (launchd or cron):
  `rsync -a --delete hetz-stock:/var/backups/cm-db/ ~/Backups/cm-db/`.
- **Cloudflare R2** (10 GB free; needs a payment method on the account): create a bucket `cm-db-backups` and an R2
  API token for that bucket only, `apt install rclone`, write `/etc/cm-db/rclone.conf` (an `[r2]` remote of type
  s3, provider Cloudflare), and set `RCLONE_REMOTE=r2:cm-db-backups` in `/etc/cm-db/backup.env`.

Alarm: a free check at https://healthchecks.io (period 15 min, grace 1 h) and its ping URL as `HC_URL=` in
`/etc/cm-db/backup.env`: you get an e-mail when Postgres, the backups, the disk or the tunnel have a problem.

### 11. Retire Neon (after a week or two)

When the site has run on hetz-stock for a week, there are good nightly dumps and `sudo bash restore.sh --test`
passed: delete the Neon project (only this one), the old Hyperdrive config `cm-games`, and the Neon credentials
on the server: `sudo rm /etc/cm-db/neon.env /etc/cm-db/pg_service.conf`.

## Running it

- **TWIC import** (new issues; scripts/twic/README.md), on the server with the SQLite build copied there:
  `sudo DATABASE_URL='postgresql://cm_owner@/cm_games?host=/var/run/postgresql' python3 scripts/twic/import_pg.py --db twic.sqlite`
  (needs `psql`, which the server has). Then purge the edge cache tag `games-db`.
- **Restore**: `sudo bash restore.sh [file.dump]` restores into a separate `cm_games_restore`, shows row counts
  next to the live ones and prints the two commands that swap them; `--test` is the monthly drill (restore the
  newest dump, count, drop). A single table from a 6-hourly dump, e.g. the AI notes (empty it, then reload it):

  ```sh
  sudo -u postgres psql -d cm_games -c 'SET ROLE cm_owner' -c 'TRUNCATE game_annotation'
  sudo -u postgres pg_restore -d cm_games --role=cm_owner --no-owner --data-only -t game_annotation < /var/backups/cm-db/small/<file>.dump
  ```
- **Updates**: unattended-upgrades restarts Postgres for security releases (a few seconds; Hyperdrive and the
  edge cache cover it). A new major version (19 or later) is a deliberate `pg_upgradecluster`, not automatic.
- **Settings**: edit the files here and run `install.sh` again; it never changes passwords. `ALTER SYSTEM` is off.
- **Neighbours on the box** (optional, set where those services are managed): render-svc `MemoryMax=3G` instead
  of 5G (it peaked at 2.5 GB) leaves room for the database's page cache; stockfish-svc `CPUWeight=50` lets page
  requests win over engine jobs (Postgres already has `CPUWeight=400`).

## Troubleshooting

- **Hyperdrive config can't be created**: error 2012 or a certificate error means TLS: `sudo -u postgres psql -c 'SHOW ssl_cert_file'`
  must name `cm-origin.crt` (step 4) and the VPC service must use `verify_ca`. A timeout means the tunnel (step 5).
- **Pages 500 after the switch**: `journalctl -u postgresql@18-main -n 50` and `/var/log/postgresql/postgresql-18-main.log`;
  "too many connections for role cm_web": lower Hyperdrive's origin connection limit (dashboard) or raise the
  limit in `install.sh` and rerun it.
- **cm-db-check fails**: `journalctl -u cm-db-check -n 20` says what (backup age, disk, tunnel, Postgres).
- **If Workers VPC doesn't work at all** (it is in open beta): the same tunnel can carry Hyperdrive's older route,
  a published hostname plus a Cloudflare Access service token. It needs a DNS record `pg.chessmoments.com`
  (proxied CNAME to the tunnel) and an Access application: Dashboard → Hyperdrive → Create → Private database →
  tunnel `cm-db`, hostname `pg.chessmoments.com` → service token and Access application "Create new (automatic)".
