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
- **Health check** every 15 minutes (`cm-db-check`): Postgres up and `cm_web` able to log in the way Hyperdrive
  does, the site's own way to the database (`SITE_CHECK_URL`, step 10), backups and their off-site copy fresh,
  disk below 85 % and 5 GB free, tunnel connected, last restore drill passed, no process killed for memory, no
  lasting memory pressure. Failures go to the journal, and to e-mail if `HC_URL` is set (step 10).

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

Everything below runs on hetz-stock unless it says "dashboard", as your login user with `sudo` (don't switch to
root: the kit is in your home, and `~` would then be root's). A shell there goes through the Mac mini; use `-t`
twice whenever a step asks you to paste something:

```sh
ssh -t vidar@100.120.87.91 'ssh -t hetz-stock'
```

The long steps (3, and any restore) are best run inside `tmux` (`tmux new -s db`; after a dropped connection,
`tmux attach -t db`), so a broken ssh session doesn't stop them halfway.

The site is in maintenance mode while the database routes are closed (`MAINTENANCE` "1" in `wrangler.jsonc`),
so nothing writes to Neon during the move. Keep it that way until step 8.

### 0. Copy the kit to the server, and get the box ready

From a machine with a full checkout of the repository (in a `--filter` clone `git archive` fetches file by file
and can seem to hang), through the Mac mini (on the Mac mini itself, leave out the outer `ssh`). `BRANCH` is
`main`, or, for a kit update, the branch with the change before it is merged. The old copy on the server is
replaced only once the new one has arrived whole:

```sh
BRANCH=main
cd cm-frontend && git fetch origin "$BRANCH"
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
constraints, extensions, locale), then the first full and hourly backups. It must end with **ALL OK** (before
the backups). If it doesn't, read the diff:

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
and enter only `pg.chessmoments.com` → longest validity → Create → key format PEM. Copy the certificate (it is
public), then:

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
default `verify_full`, which fails. A service created that way can be fixed in the dashboard (VPC → Services →
`cm-db-postgres` → edit → certificate verification), or with wrangler, which replaces the whole service, so every
field is given again (`npx wrangler vpc service get <service id>` shows them):

```sh
npx wrangler vpc service update <service id> --name cm-db-postgres --type tcp --tcp-port 5432 --app-protocol postgresql \
  --tunnel-id <tunnel id> --ipv4 127.0.0.1 --cert-verification-mode verify_ca
```

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
(analyses, AI notes, uploads) would be missing on Neon, so approve no uploads until step 11. To move forward
again after a rollback: maintenance first (`MAINTENANCE` "1" in both `vars` blocks, deployed), so nothing writes to
Neon; then `sudo -u postgres dropdb --force cm_games && sudo bash ~/cm-db-kit/ops/postgres/install.sh`, step 3, and
steps 8–9 again. Don't merge hetz-stock's rows into Neon or back with `cm-db-restore --table`: ids given out on
each side can clash.

### 10. Backups off the box, and an alarm

The timers are already running (`systemctl list-timers 'cm-db-*'`; dumps in `/var/backups/cm-db/`; step 3 made
the first ones). Settings go in `/etc/cm-db/backup.env` (`sudo nano /etc/cm-db/backup.env`). For a copy that
survives losing the server, pick one (and keep the R2 token or the Mac mini's access somewhere off the server,
e.g. a password manager: a rebuilt box needs it):

- **Pull to the Mac mini** (nothing new to sign up for): `BACKUP_GROUP=<the login user on hetz-stock>` in
  `backup.env`, then `sudo cm-db-backup small` once so that user can read the dumps, then on the Mac mini run
  nightly (launchd or cron), keeping 40 days, with a second healthchecks.io check of its own (period 1 day) so a
  pull that stops working sends an e-mail too:
  `rsync -a --exclude '*.part' --exclude 'last-*' hetz-stock:/var/backups/cm-db/ ~/Backups/cm-db/ && find ~/Backups/cm-db -name '*.dump' -mtime +40 -delete && curl -fsS -m 10 -o /dev/null <its ping URL>`
  (no `--delete`: a server that lost its dumps must not take the Mac mini's copies with it).
- **Cloudflare R2** (10 GB free; needs a payment method on the account): create a bucket `cm-db-backups` with
  location **jurisdiction EU** (the dumps hold organisers' e-mail addresses; this can't be changed later), and
  in its settings **bucket lock rules** `daily/` 7 days, `small/` 7 days, `weekly/` 35 days, so even a
  compromised server can't delete recent copies. An R2 API token with Object Read & Write for that bucket only,
  `sudo apt install rclone`, then `/etc/cm-db/rclone.conf` (root only: `sudo sh -c 'umask 077; cat > /etc/cm-db/rclone.conf'`)
  with an `[r2]` remote: `type = s3`, `provider = Cloudflare`, `access_key_id`, `secret_access_key`,
  `endpoint = https://<account id>.eu.r2.cloudflarestorage.com`. Then `RCLONE_REMOTE=r2:cm-db-backups` in
  `backup.env`, and `sudo cm-db-backup full && sudo cm-db-backup small` once, so the first copies are up (the
  health check watches them from then on). The bucket keeps what the server keeps (about 8 GB) and is pruned only
  after a new dump is up.

Alarm: a free check at https://healthchecks.io (period 15 min, grace 1 h) and its ping URL as `HC_URL=`, and
`SITE_CHECK_URL=https://chessmoments.com/health/db` (the site's own way to the database; while the site is in
maintenance on purpose it only notes that), both in `backup.env`.
`sudo cm-db-check` shows at once what it would report. You get an e-mail when Postgres, the site's way to it, the
backups and their off-site copy, the disk, memory, the drill or the tunnel have a problem.

### 11. Retire Neon (after a week or two)

When the site has run on hetz-stock for a week, there are good nightly dumps, `sudo cm-db-restore --test`
passed, and the off-box copy is proven. Fetch last night's full dump back into a new, empty directory (never into
`/var/backups/cm-db`, where a file of the same name already is: rclone would skip it and the test would read the
local copy) and test that:

```sh
sudo install -d -m 700 /var/tmp/cm-offsite
sudo rclone -v --config /etc/cm-db/rclone.conf copy r2:cm-db-backups/daily/<last night's file> /var/tmp/cm-offsite/   # must say "Copied (new)"
sudo cm-db-restore --test /var/tmp/cm-offsite/<that file>; sudo rm -r /var/tmp/cm-offsite
```

(From the Mac mini instead: `scp` the file to your home directory on the server and test it there.) Then delete
the Neon project (only
this one), then **Billing → change plan → Free** (deleting projects alone
doesn't stop the monthly plan), delete the old Hyperdrive config `cm-games` and the Neon credentials on the
server: `sudo rm /etc/cm-db/neon.env /etc/cm-db/pg_service.conf`. Until then, keep Neon's compute set to scale to
zero, so the waiting week costs nothing.

## Running it

- **TWIC import** (new issues; `scripts/twic/README.md`, which also says what a `--reset` needs), on the server
  with the SQLite build copied there, not between 03:20 and about 03:40 UTC (the nightly backup):
  `sudo DATABASE_URL='postgresql://cm_owner@/cm_games?host=/var/run/postgresql' python3 ~/cm-db-kit/scripts/twic/import_pg.py --db twic.sqlite`
  (needs `psql`, which the server has). Then purge the edge cache tag `games-db`.
- **Restore** (`cm-db-restore`, with sudo; whatever comes out of a dump runs as `cm_owner`, never as a superuser):
  - `sudo cm-db-restore [file.dump]` restores a full backup (the newest by default) into a separate
    `cm_games_restore`, brings its schema up to date, shows row counts next to the live ones and prints the steps
    that make it live: maintenance, a fresh hourly backup of the live database while it still answers, pause the
    backups, swap, the site's own tables from that backup, a TWIC re-import if issues came after the full backup,
    backups on again, reopen and "Republish all approved".
  - `sudo cm-db-restore --table game_annotation [file.dump]` puts back rows of one of the site's own tables
    (`game_analysis`, `game_annotation`, `uploads`, `upload_rounds`) from the newest hourly backup: it only adds
    rows the live table lacks and deletes nothing. (Analyses and notes from before a TWIC `--reset` belong to other
    game ids; the script skips rows of games that no longer exist, not ones that were renumbered.)
    `sudo ls -t /var/backups/cm-db/small/ | head` lists the hourly backups.
  - `sudo cm-db-restore --site-tables <file.dump>` replaces those four tables (and the counter of uploaded ids)
    with an hourly backup's, in one transaction, and drops analyses and notes of uploaded games the database
    doesn't have. The counter only ever moves forward. Name the file: after a restore the newest hourly backup may
    already be one of the restored, older data. After a full restore it refuses an hourly backup made before that
    full one (its rows would be older than the full backup's; skip the step then, or add `--force`). Then, with the database routes open, "Republish all approved" on `/upload/admin/`: it publishes again only
    the rounds of uploaded tournaments whose files changed since the full backup (everything else keeps its game
    ids, analyses and notes) and takes down tournaments rejected since.
  - `sudo cm-db-restore --test [file.dump]` is the drill the monthly timer runs (`journalctl -u cm-db-restore-test`);
    it fails when the restored copy is much smaller than the live database. After a failed drill is fixed,
    `sudo systemctl start cm-db-restore-test` runs it again and clears the alarm.
- **Updates**: unattended-upgrades restarts Postgres for security releases (a few seconds; Hyperdrive and the
  edge cache cover it) and updates cloudflared, which then restarts (about 5 seconds). A new major version (19 or
  later) is deliberate, in maintenance: install it (`sudo apt install postgresql-19`; on Ubuntu 26.04 from the
  PostgreSQL apt repository, apt.postgresql.org), remove the empty cluster the package creates
  (`sudo pg_dropcluster --stop 19 main`), `sudo pg_upgradecluster --no-start 18 main`, then
  `sudo PGMAJOR=19 bash ~/cm-db-kit/ops/postgres/install.sh` (it starts 19 with the settings and the same
  certificate, which lives outside the cluster), `sudo -u postgres psql -c 'SHOW ssl_cert_file'` (must name
  `cm-origin.crt`), the site checks, then `sudo pg_dropcluster 18 main`; and `postgresql@18-main` in this README
  becomes `19-main`.
- **Kit updates** (a new version of these scripts, or a branch that changes the site's tables in
  `scripts/*.pg.sql` or `scripts/db/grants.sql`, before it is merged): copy the kit again (step 0's command with
  `BRANCH` set to that branch) and rerun `sudo bash ~/cm-db-kit/ops/postgres/install.sh`. It applies the schema
  scripts (only what is new) and the grants, and installs the backup, check and restore commands; if a table is
  busy (the nightly backup from 03:20 UTC, an import) it stops after 10 seconds instead of holding up the site's
  queries: run it again a few minutes later. If `tunnel.sh` or `systemd/cloudflared-cm-db.service` changed, also
  run `sudo bash ~/cm-db-kit/ops/postgres/tunnel.sh` (it keeps the token).
- **Losing the box** (the site in maintenance meanwhile: `MAINTENANCE` "1"):
  1. Cut the old box off, in case it still runs or comes back: power it off or delete it in the Hetzner console
     if you can. Tailscale admin console → Machines → `hetz-stock` → **Remove** (frees the name and its access to
     the Mac mini). SSL/TLS → Origin Server → **revoke** the old certificate; R2 → API tokens → delete the old
     token (if R2 is used). The tunnel: create a new one (Tunnels → Create, `cm-db-2`) for step 5 and, once the new
     box is connected, delete `cm-db`; a token rotation alone would leave connections the old box still holds.
  2. The new server: the login user with sudo; join the tailnet as `hetz-stock` (`sudo tailscale up --hostname
     hetz-stock`; give it the old address 100.77.91.56 in the admin console if you use the Tailscale access). On
     the Mac mini, `ssh-keygen -R hetz-stock` (and the old IP), then `ssh hetz-stock` once to accept the new host
     key (step 0's command can't ask). Then steps 0 and 1, and pause the backups so none of them saves the empty
     database as the newest: `sudo systemctl stop cm-db-backup.timer cm-db-backup-small.timer`.
  3. Get the newest full and hourly dumps back. From R2: a new R2 token, `sudo apt install rclone`,
     `/etc/cm-db/rclone.conf` as in step 10, then
     `sudo rclone --config /etc/cm-db/rclone.conf copy r2:cm-db-backups/daily/<file> /var/backups/cm-db/daily/`
     (and `small/<file>` into `/var/backups/cm-db/small/`). From the Mac mini: `scp` both files to the server's
     home directory; the restore reads them from there.
  4. `sudo cm-db-restore <full dump>`, then the swap it prints, then `sudo cm-db-restore --site-tables <hourly dump>`
     if the hourly dump was made after the full one (a later time in its name; otherwise skip it: the full dump
     holds the newest rows), a TWIC re-import if issues came after the full dump, then
     `sudo systemctl start cm-db-backup.timer cm-db-backup-small.timer`.
  5. Steps 4–7 with new secrets: a new certificate (`tls.sh`), the new tunnel `cm-db-2`
     (`sudo bash ~/cm-db-kit/ops/postgres/tunnel.sh --new-token`, then the VPC service pointed at it: dashboard VPC →
     Services → `cm-db-postgres` → edit, or the full `wrangler vpc service update` of step 6 with its tunnel id), and
     the new `cm_web` password in the Hyperdrive config (dashboard → Hyperdrive → `cm-games-hetz` → Settings). The
     dashboard must list only the new box's connector. Then step 10 again (`backup.env`: off-site copy, `HC_URL`,
     `SITE_CHECK_URL`).
  6. `MAINTENANCE` "0", "Republish all approved", purge the `games-db` cache tag.
  Only without any dumps: TWIC rebuilt from source (`scripts/twic/README.md`) into the empty database, with the
  site's tables created from `scripts/analysis.pg.sql`, `annotation.pg.sql` and `uploads.pg.sql`.
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
  the Origin CA certificate, certificate verification **Disabled** on the VPC service works too (dashboard, or the
  full `wrangler vpc service update` command of step 6 with `--cert-verification-mode disabled`; the connection is
  still encrypted, and only this tunnel, authenticated by its token, reaches the port); tell Claude, so the next
  step can be a publicly trusted certificate instead. A timeout means the tunnel (step 5).
- **Database pages answer 503 "not answering"** (the site's own page when a query fails): `journalctl -u postgresql@18-main -n 50`
  and `/var/log/postgresql/postgresql-18-main.log`; "too many connections for role cm_web": lower Hyperdrive's
  origin connection limit (dashboard) or raise the limit in `install.sh` and rerun it.
- **cm-db-check fails**: `sudo cm-db-check` (or `journalctl -u cm-db-check -n 20`) says what (Postgres, the site's
  way to it, backup age, disk, tunnel, memory, drill).
- **If Workers VPC doesn't work at all** (it is in open beta): the same tunnel can carry Hyperdrive's older route,
  a published hostname behind a Cloudflare Access service token. Here Hyperdrive checks the certificate itself and
  the Origin CA isn't publicly trusted, so the config is made with wrangler, which can name a CA (the dashboard
  can't):
  1. Zero Trust → Access controls → Service credentials → **Service tokens** → create `cm-db-hyperdrive` (copy
     its Client ID and Secret); Access → Applications → add a self-hosted application for `pg.chessmoments.com`
     with a Service Auth policy that includes that token.
  2. Tunnels → `cm-db` → **Published application routes** → `pg.chessmoments.com`, service TCP `localhost:5432`
     (this also creates the proxied DNS record).
  3. On your own machine with wrangler logged in, in a terminal whose history you clear afterwards (the cm_web
     password and the token secret are on these command lines): `npx wrangler cert upload certificate-authority
     --ca-cert origin_ca_rsa_root.pem --name cf-origin-ca` (the root file from Cloudflare's Origin CA docs), then
     `npx wrangler hyperdrive create cm-games-hetz-access --host pg.chessmoments.com --database cm_games --user cm_web
     --password <…> --access-client-id <…> --access-client-secret <…> --ca-certificate-id <its id> --sslmode verify-full
     --origin-connection-limit 20` (20 as in step 7: `cm_web` may open at most 40). Its id goes into step 8.
