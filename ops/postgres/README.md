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
- **Backups:** nightly full dump at 03:20 UTC (7 daily + 5 weekly kept) and every hour the tables that can't be
  rebuilt from TWIC (analyses, AI notes, uploads; a week kept), in `/var/backups/cm-db/` (root only: TWIC data
  may not be republished in bulk). Each dump is read back in full before it replaces an older one. A restore
  drill runs on the first Sunday of every month. Off-site copy: see step 10.
- **Health check** every 15 minutes (`cm-db-check`): Postgres up, backups fresh, disk below 85 % and 5 GB free,
  tunnel connected, last restore drill passed, no process killed for memory, no lasting memory pressure.
  Failures go to the journal, and to e-mail if `HC_URL` is set (step 10).

| File | What it is |
|---|---|
| `install.sh` | Installs and configures Postgres, roles, database, backups, checks and the drill (step 1) |
| `postgresql.conf`, `pg_hba.conf` | Settings (≈1 GB of memory), access rules |
| `postgresql.service.d.conf`, `postgresql-slice.conf` | systemd: OOM policy and restart; CPU priority, no swap |
| `migrate-from-neon.sh`, `compare.sh` | The move from Neon, verified table by table (steps 2–3) |
| `tls.sh` | Cloudflare Origin CA certificate for Postgres (step 4) |
| `tunnel.sh`, `systemd/cloudflared-cm-db.service` | The tunnel (step 5) |
| `backup.sh`, `check.sh`, `restore.sh`, `systemd/cm-db-*` | Backups, health check, restore and drill (installed as `cm-db-backup`, `cm-db-check`, `cm-db-restore`) |
| `../../scripts/db/grants.sql` | `cm_web`'s rights (also applied by the TWIC importer) |

## Moving from Neon (one time)

Everything below runs on hetz-stock as root unless it says "dashboard". A shell there goes through the Mac
mini; use `-t` twice whenever a step asks you to paste something:

```sh
ssh -t vidar@100.120.87.91 'ssh -t hetz-stock'
```

The site is in maintenance mode while the database routes are closed (`MAINTENANCE` "1" in `wrangler.jsonc`),
so nothing writes to Neon during the move. Keep it that way until step 8.

### 0. Copy the kit to the server, and get the box ready

From a machine with a checkout of the repository (the kit is on branch `claude/nice-darwin-fmxre9` until it is
merged; afterwards fetch `main`), through the Mac mini (on the Mac mini itself, leave out the outer `ssh`). The
old copy on the server is replaced only once the new one has arrived whole:

```sh
cd cm-frontend && git fetch origin claude/nice-darwin-fmxre9
git archive FETCH_HEAD ops/postgres scripts | ssh vidar@100.120.87.91 'ssh hetz-stock "rm -rf cm-db-kit.new && mkdir cm-db-kit.new && tar xf - -C cm-db-kit.new && test -f cm-db-kit.new/ops/postgres/install.sh && rm -rf cm-db-kit && mv cm-db-kit.new cm-db-kit && echo copied"'
```

Then on hetz-stock:

- `free -h`: about 4 GB should be free besides the page cache. `df -h /`: the database needs about 4 GB, backups
  about 8 GB. `findmnt -T /var/lib`: the database must be on the server's own disk, not a Hetzner Volume.
- **Swap:** if `swapon --show` prints nothing, add 2 GB, so a memory peak of the neighbours slows them down
  instead of killing a process (Postgres itself never swaps: `postgresql-slice.conf`):
  `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab`
- **The neighbours (before step 8):** at render-svc's current `MemoryMax=5G` the worst case is
  5 + 1.2 (engine) + 1.3 (Postgres) + 0.5 GB = 8 GB on a 7.6 GB box. Where those services are managed (their
  unit files or a drop-in), set render-svc `MemoryHigh=2750M`, `MemoryMax=3G`, `CPUWeight=20`,
  `OOMScoreAdjust=500` (check its real peak first: `systemctl show render-svc -p MemoryPeak`; it was 2.5 GB), and
  stockfish-svc `CPUWeight=50`, `OOMScoreAdjust=300`. Then the kernel picks a render over the database when
  memory runs out, and page requests win the CPU (Postgres's slice has `CPUWeight=500`).

### 1. Install Postgres

```sh
sudo bash ~/cm-db-kit/ops/postgres/install.sh
sudo ss -ltnp | grep 5432        # must show only 127.0.0.1:5432 and [::1]:5432
```

It ends with "done" and where the passwords are. (`sudo TAILSCALE_IP=100.77.91.56 bash …/install.sh` also lets
`cm_owner` in from the Mac mini over Tailscale; not needed, imports can run on the server. It is remembered for
later runs; `TAILSCALE_IP=off` removes it.)

### 2. The Neon connection string

Neon console → project → **Connect** → role `neondb_owner` (the owner, not `readonly`) → show the password →
copy the connection string. On the server (paste, Enter, Ctrl-D):

```sh
sudo sh -c 'umask 077; cat > /etc/cm-db/neon.env'
NEON_DATABASE_URL=postgresql://neondb_owner:...@ep-lively-tree-b1dbxley-pooler.c-5.eu-central-1.aws.neon.tech/neondb?sslmode=require
```

(The pooled or the direct host both work; the script uses the direct one, which `pg_dump` needs, and always
checks Neon's certificate.) While you are in the console, note whether the organisation has other projects
(the old Railway app "chessbiz" may have one), so step 11 deletes only this one.

### 3. Copy and verify

```sh
sudo bash ~/cm-db-kit/ops/postgres/migrate-from-neon.sh
```

About 15–30 minutes: dump (Neon's compute is awake for those minutes), restore, grants, VACUUM ANALYZE, then
every table compared with Neon (row counts and checksums of every row, sequence, tables and columns, indexes,
constraints, extensions, locale). It must end with **ALL OK**. If it doesn't, read the diff:

- a table's count or checksum differs: something wrote to Neon after the dump. Start over:
  `sudo -u postgres dropdb cm_games && sudo bash ~/cm-db-kit/ops/postgres/install.sh`, then this step again.
- any other line differs (tables, indexes, constraints, extensions, database): stop and give Claude the diff.
- the restore failed after a good dump: start over as above, adding `--reuse /var/lib/postgresql/migration/neon-<time>.dump`
  to skip the dump.

The dump stays in `/var/lib/postgresql/migration/` as the final copy of the Neon database.

### 4. TLS certificate

Hyperdrive only connects with TLS, and the VPC service checks the certificate. The key is made on the server and
never leaves it:

```sh
sudo bash ~/cm-db-kit/ops/postgres/tls.sh
```

Dashboard: **chessmoments.com → SSL/TLS → Origin Server → Create Certificate** → "Use my private key and CSR" →
paste the request it printed → hostnames: **remove the two it fills in** (`chessmoments.com`, `*.chessmoments.com`)
and enter only `pg.chessmoments.com` → PEM → longest validity → Create. Copy the certificate (it is public), then:

```sh
sudo bash ~/cm-db-kit/ops/postgres/tls.sh --install      # paste, Enter, Ctrl-D
```

### 5. Tunnel

Dashboard: **Workers & Pages → VPC → Tunnels → Create** → name `cm-db` → copy the token (the long `eyJ…` value in
the install command it shows; pasting the whole command works too; don't run that command). If the box already
runs a cloudflared for something else (`systemctl list-units 'cloudflared*'`, e.g. for the engine), leave it:
this tunnel is separate, with its own service `cloudflared-cm-db` and metrics port 20299. On the server:

```sh
sudo bash ~/cm-db-kit/ops/postgres/tunnel.sh             # paste the token, Enter, Ctrl-D
```

It waits up to a minute for the tunnel to connect and the dashboard then shows it **Healthy**. If it doesn't
connect, it prints the tunnel's log: "Unauthorized" means a wrong token (`tunnel.sh --new-token` asks again);
QUIC timeouts mean outbound UDP 7844 is blocked: allow it in the Hetzner Cloud firewall (Hetzner console →
server → Firewalls), if one is attached. Workers VPC needs QUIC.

### 6. VPC service

On a machine where wrangler is logged in (nothing secret), with the tunnel id from the dashboard:

```sh
npx wrangler vpc service create cm-db-postgres --type tcp --tcp-port 5432 --app-protocol postgresql \
  --tunnel-id <tunnel id> --ipv4 127.0.0.1 --cert-verification-mode verify_ca
```

Or in the dashboard: **Workers & Pages → VPC → Services → Create**: name `cm-db-postgres`, type TCP, tunnel
`cm-db`, host `127.0.0.1`, port `5432`, application protocol PostgreSQL, certificate verification **Verify CA**.
`verify_ca` because the certificate is checked against Cloudflare's Origin CA, and it is issued for a name, not
for 127.0.0.1. Create the service here, not from inside the Hyperdrive form in step 7: that would leave the
default `verify_full`, which fails. A service created that way can be fixed with
`npx wrangler vpc service update <service id> --cert-verification-mode verify_ca`.

### 7. Hyperdrive config

Dashboard: **Storage & Databases → Hyperdrive → Create configuration → Private database → Workers VPC** →
`cm-db-postgres`. Name `cm-games-hetz`, database `cm_games`, user `cm_web`, password: on the server
`sudo cat /etc/cm-db/cm_web.password`, copy it into the form. Caching on (defaults). Creating it connects once to
test; an error here is a TLS or tunnel problem (Troubleshooting below). Then in the new config's **Settings**:
origin connection limit **20**.

Copy the new config's **ID** (not a secret) and give it to Claude, or do step 8 yourself.

### 8. Switch the site

In `wrangler.jsonc`: the new id in both `hyperdrive` blocks (top level and `previews`), `MAINTENANCE` "0" in both
`vars` blocks (reopens the database routes), and `placement` `{ "region": "gcp:europe-north1" }` (Finland, next
to the database; it was `aws:eu-central-1`, Frankfurt, for Neon). Claude tests the previews block on the
branch's preview URL first, then you say "merge" and the push to `main` deploys it.

### 9. Check it works

- https://chessmoments.com/games/ , a game, a player, an event, `/sitemaps/index.xml`: 200, no errors.
- "Analyse with Stockfish" and "Write notes with AI" on a game.
- If `ADMIN_KEY` is set: upload a small test tournament at `/upload/`, approve it at `/upload/admin/`, check its
  event page, then reject it (this is the only path that writes to games, players and events).
- On the server, Hyperdrive's sessions come over the tunnel with TLS:

```sh
sudo -u postgres psql -d cm_games -c "SELECT a.usename, a.client_addr, s.ssl, s.version, count(*) FROM pg_stat_activity a JOIN pg_stat_ssl s USING (pid) WHERE a.usename = 'cm_web' GROUP BY 1, 2, 3, 4"
```

(expect `cm_web | 127.0.0.1 | t | TLSv1.3`). The edge cache starts empty (the deploy changes the cache key and
the routes were closed), so the first hours bring crawler traffic to the box: `top` now and then, and
`journalctl -u cm-db-check` the next day.

**Rollback** (while Neon still exists): the old id `ff39804dfb964a2ca13a9e1d7ec27cbe` back in both `hyperdrive`
blocks and `placement` back to `aws:eu-central-1`, then deploy. Whatever was written on hetz-stock in between
(analyses, AI notes, uploads) would be missing on Neon, so approve no uploads until step 11.

### 10. Backups off the box, and an alarm

The timers are already running (`systemctl list-timers 'cm-db-*'`; dumps in `/var/backups/cm-db/`). The first
nightly dump appears after 03:20 UTC. For a copy that survives losing the server, pick one:

- **Pull to the Mac mini** (nothing new to sign up for): put `BACKUP_GROUP=<the login user on hetz-stock>` in
  `/etc/cm-db/backup.env` so that user can read the dumps (from the next backup on), then on the Mac mini run
  nightly (launchd or cron), keeping 40 days:
  `rsync -a --exclude '*.part' --exclude 'last-*' hetz-stock:/var/backups/cm-db/ ~/Backups/cm-db/ && find ~/Backups/cm-db -name '*.dump' -mtime +40 -delete`
  (no `--delete`: a server that lost its dumps must not take the Mac mini's copies with it).
- **Cloudflare R2** (10 GB free; needs a payment method on the account): create a bucket `cm-db-backups` with
  location **jurisdiction EU** (the dumps hold organisers' e-mail addresses; this can't be changed later), and
  in its settings **bucket lock rules** `daily/` 7 days, `small/` 7 days, `weekly/` 35 days, so even a
  compromised server can't delete recent copies. An R2 API token with Object Read & Write for that bucket only,
  `apt install rclone`, `/etc/cm-db/rclone.conf` (root only) with an `[r2]` remote of type s3, provider
  Cloudflare, endpoint `https://<account id>.eu.r2.cloudflarestorage.com`, and `RCLONE_REMOTE=r2:cm-db-backups` in
  `/etc/cm-db/backup.env`. The bucket keeps what the server keeps (about 8 GB) and is pruned only after a new
  dump is up.

Alarm: a free check at https://healthchecks.io (period 15 min, grace 1 h) and its ping URL as `HC_URL=` in
`/etc/cm-db/backup.env`: you get an e-mail when Postgres, the backups, the disk, memory, the drill or the tunnel
have a problem.

### 11. Retire Neon (after a week or two)

When the site has run on hetz-stock for a week, there are good nightly dumps and `sudo cm-db-restore --test`
passed: delete the Neon project (only this one), then **Billing → change plan → Free** (deleting projects alone
doesn't stop the monthly plan), delete the old Hyperdrive config `cm-games` and the Neon credentials on the
server: `sudo rm /etc/cm-db/neon.env /etc/cm-db/pg_service.conf`. Until then, keep Neon's compute set to scale to
zero, so the waiting week costs nothing.

## Running it

- **TWIC import** (new issues; `scripts/twic/README.md`, which also says what a `--reset` needs), on the server
  with the SQLite build copied there, not between 03:20 and about 03:40 UTC (the nightly backup):
  `sudo DATABASE_URL='postgresql://cm_owner@/cm_games?host=/var/run/postgresql' python3 ~/cm-db-kit/scripts/twic/import_pg.py --db twic.sqlite`
  (needs `psql`, which the server has). Then purge the edge cache tag `games-db`.
- **Restore** (`cm-db-restore`, root):
  - `sudo cm-db-restore [file.dump]` restores a full backup (the newest by default) into a separate
    `cm_games_restore`, shows row counts next to the live ones and prints the commands that swap the two.
  - `sudo cm-db-restore --table game_annotation [file.dump]` puts back rows of one of the site's own tables
    (`game_analysis`, `game_annotation`, `uploads`, `upload_rounds`) from the newest hourly backup: it only adds
    rows the live table lacks and deletes nothing. (Analyses and notes from before a TWIC `--reset` belong to other
    game ids; the script skips rows of games that no longer exist, not ones that were renumbered.)
    `sudo ls -t /var/backups/cm-db/small/ | head` lists the hourly backups.
  - `sudo cm-db-restore --site-tables [file.dump]` replaces those four tables with an hourly backup's rows (in one
    transaction). After a full restore, which is older, run this with the newest hourly backup, then with the
    database routes open "Republish all approved" on `/upload/admin/`: it publishes every approved tournament
    again and takes down the ones rejected since the full backup.
  - `sudo cm-db-restore --test` is the drill the monthly timer runs (`journalctl -u cm-db-restore-test`); it fails
    when the restored copy is much smaller than the live database.
- **Updates**: unattended-upgrades restarts Postgres for security releases (a few seconds; Hyperdrive and the
  edge cache cover it) and updates cloudflared, which then restarts (about 5 seconds). A new major version (19 or
  later) is a deliberate `pg_upgradecluster`, not automatic.
- **Losing the box**: on the new server, steps 0 and 1, then copy the newest full and hourly dumps back (from R2:
  `rclone copy r2:cm-db-backups/daily/<file> /var/backups/cm-db/daily/`, and `small/`; or from the Mac mini with
  `scp`), `sudo cm-db-restore`, the swap it prints, `sudo cm-db-restore --site-tables`. The secrets are new, so
  steps 4–7 again: a new certificate (`tls.sh`), the tunnel token (the same tunnel: its token is in the
  dashboard), and the new `cm_web` password in the Hyperdrive config (dashboard → Hyperdrive → `cm-games-hetz` →
  Settings), or a new config and step 8. Then, with the routes open, "Republish all approved". Only without any
  dumps: TWIC rebuilt from source (`scripts/twic/README.md`) into the empty database, with the site's tables
  created from `scripts/analysis.pg.sql`, `annotation.pg.sql` and `uploads.pg.sql`.
- **Settings**: edit the files here and run `install.sh` again: it reloads, restarts Postgres only when a setting
  needs it (and says so), never changes passwords and keeps the Tailscale access. `ALTER SYSTEM` is off. Role
  settings (cm_web's timeouts) apply to new sessions only, and Hyperdrive keeps its sessions open: afterwards end
  them with `sudo -u postgres psql -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'cm_web'"`.

## Troubleshooting

- **The Neon connection fails in step 3** with a certificate or channel-binding error: run it as
  `sudo NEON_SSLMODE=require bash ~/cm-db-kit/ops/postgres/migrate-from-neon.sh` (still encrypted, without checking
  the certificate's issuer).
- **Hyperdrive config can't be created**: error 2012 or a certificate error means TLS: `sudo -u postgres psql -c 'SHOW ssl_cert_file'`
  must name `cm-origin.crt` (step 4) and the VPC service must use `verify_ca` (step 6). If Workers VPC still rejects
  the Origin CA certificate, `--cert-verification-mode disabled` on the VPC service works too (the connection is
  still encrypted, and only this tunnel, authenticated by its token, reaches the port); tell Claude, so the next
  step can be a publicly trusted certificate instead. A timeout means the tunnel (step 5).
- **Database pages answer 503 "not answering"** (the site's own page when a query fails): `journalctl -u postgresql@18-main -n 50`
  and `/var/log/postgresql/postgresql-18-main.log`; "too many connections for role cm_web": lower Hyperdrive's
  origin connection limit (dashboard) or raise the limit in `install.sh` and rerun it.
- **cm-db-check fails**: `journalctl -u cm-db-check -n 20` says what (backup age, disk, tunnel, memory, drill, Postgres).
- **If Workers VPC doesn't work at all** (it is in open beta): the same tunnel can carry Hyperdrive's older route,
  a published hostname plus a Cloudflare Access service token. Dashboard → Workers & Pages → VPC → Tunnels → `cm-db`
  → **Published application routes** → `pg.chessmoments.com`, service TCP `localhost:5432` (this also creates the
  proxied DNS record); then Hyperdrive → Create → Private database → tunnel `cm-db`, hostname `pg.chessmoments.com`
  → service token and Access application "Create new (automatic)".
