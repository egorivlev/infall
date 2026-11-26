# Running an Infall Team server

A Team server holds one Team Workspace, which several Members share: each signs in from a browser or from the desktop app. One person trying Infall on their own does not need a server: the desktop app makes a Local Workspace on that computer by itself ([desktop/README.md](../desktop/README.md)).

There are two ways to run one:

- **The container** (this section): Docker runs the server, Caddy in front of it for HTTPS, and a daily backup job. About fifteen minutes on a host that already has Docker.
- **systemd on a VPS** ([below](#the-systemd-route)): the same server installed by hand, with encrypted backups. About an hour.

Words used here: an **Admin** is a Member who also invites and removes people and looks after the server. A **Guest** is an outsider with time-limited read access.

## The container route

### What you need

- A Linux host (a VPS or your own machine) with **Docker Engine and the Compose plugin**. Check with `docker compose version`; if that fails, install Docker from [docs.docker.com/engine/install](https://docs.docker.com/engine/install/). 1 GB of memory is enough.
- **A domain name** whose DNS record (`A`, and `AAAA` if the host has IPv6) points at the host. Check with `dig +short infall.example.org`: it must print the host's address.
- **Ports 80 and 443** open to the internet on the host and in any provider firewall. Caddy needs both to get the certificate; nothing else on the host may use them.
- The image of the version you want, from your registry (`INFALL_IMAGE` below; "[Build the image yourself](#build-the-image-yourself)" if you have none).

Before the server holds anything, do the host checklist in [harden.md](harden.md) (firewall, key-only SSH, automatic updates). Docker publishes ports past `ufw`, so the only ports this setup publishes are 80 and 443.

### Steps

1. **Copy this folder onto the host.** You need `compose.yaml`, `.env.example`, `container/Caddyfile` and `update.sh`, with the same layout. With git: `git clone YOUR_REPOSITORY_URL infall && cd infall/deploy`; a git checkout is what lets `update.sh` bring in newer deploy files later. Run every command below from inside this folder. If the image is in a private registry, log Docker in to it once first (for GitHub's: `docker login ghcr.io -u YOUR_GITHUB_NAME`, with a classic token that has `read:packages` as the password).

2. **Write the settings.**

   ```sh
   cp .env.example .env
   nano .env
   ```

   Set `INFALL_DOMAIN` to your domain (no `https://`) and `INFALL_IMAGE` to the image's name. `INFALL_VERSION=latest` follows the newest release; put a number (`0.9.0`) there instead to stay on one version until you change it. Leave the rest as it is. `.env` is read by `docker compose` only; it holds no password.

3. **Start it.**

   ```sh
   docker compose pull
   docker compose up -d
   docker compose ps
   ```

   After half a minute `docker compose ps` shows `server` and `backup` as `(healthy)` and `caddy` as `Up`. Caddy fetches the certificate in the first minute: `docker compose logs caddy` shows `certificate obtained successfully`.

4. **Create the first Admin.**

   ```sh
   docker compose run --rm server create-admin --email you@example.org --name "Your Name"
   ```

   It asks for a password (at least 12 characters) twice and does not show what you type. It prints `Created Admin Your Name <you@example.org>.` The password is deliberately not a command-line option: arguments end up in shell history and in `ps`. Use a password manager's generated password.

5. **Check it.**

   ```sh
   curl -fsS https://infall.example.org/api/health      # prints {"ok":true}
   ```

   Then open `https://infall.example.org` in a browser and sign in with the Admin's email and password.

6. **Invite the others.** As Admin, create an invite for each person: their email, and role Member, or Guest with an end date. Infall shows the invite link once; send it over a channel you trust. It works one time and expires after 7 days. There is no open sign-up.

#### Try it on your own computer first

Set `INFALL_DOMAIN=localhost` in `.env` and follow the same steps. Caddy then uses a certificate of its own instead of a public one: browsers warn about it once, and `curl` needs `-k` (`curl -kfsS https://localhost/api/health`). If ports 80 or 443 are taken on that computer, set `INFALL_HTTP_PORT`, `INFALL_HTTPS_PORT` and `INFALL_PUBLIC_ORIGIN` as `.env.example` explains.

### What runs, and where the data is

| Service | What it does |
|---|---|
| `server` | the Infall server, as an unprivileged user (uid 10001) with a read-only system; reachable only from Caddy |
| `caddy` | HTTPS on ports 80 and 443, certificates, the request size limits |
| `backup` | a Workspace file every day at `INFALL_BACKUP_TIME` (UTC), and one when it starts if none is younger than a day ([Back up and restore](#back-up-and-restore)) |

Docker keeps the data in named volumes: `infall_data` (the database `infall.db`, the secret key `secret-key`, and the copies made before upgrades in `pre-upgrade/`), `infall_backups` (the daily Workspace files, and the database copies made with `backup-database`), and `infall_caddy-data` (certificates). `docker compose down` keeps them; only `docker compose down -v` or `docker volume rm` deletes them.

#### The secret key

The server seals Members' OpenRouter keys (for the AI sidebar in a browser) with a secret key. On first start it makes one in the data volume. Backups leave it out on purpose, so that a backup alone does not open the sealed keys (a Workspace file holds no AI keys at all; a database copy holds them sealed). Keep a copy of it in your password manager:

```sh
docker compose run --rm --no-deps --entrypoint cat server /data/secret-key
```

Without it, a restored Workspace works fully, and each Member types their OpenRouter key again. To keep the key outside the volume instead, put it in `.env` as `INFALL_SECRET_KEY=`.

### Back up and restore

There are two kinds of backup. They answer different questions, so know which one you hold before you need it.

| | **Workspace file** (`infall-<time>.infall.gz`) | **Database copy** (`infall-<time>.db.gz`, and the copies in `pre-upgrade/`) |
|---|---|---|
| Made | every day by the `backup` service, automatically | by hand (`backup-database`); before every upgrade, automatically; daily too if `INFALL_BACKUP_DATABASE=yes` |
| Holds | every Branch, the history, Checkpoints, To-dos, Suggestions and Comments, and each Member and Admin **as a name** | everything on this server, exactly as it was |
| Does not hold | emails, passwords, sign-ins, invites, access tokens, AI keys and settings, Guests | the secret key (keep that separately, [above](#the-secret-key)) |
| Put back with | `import-workspace` (or the page's **Bring in a Workspace file…**) onto an **empty** server, of this version or any newer one | `restore`, over this server's database, with this version or a newer one |
| Afterwards | the importing Admin owns the work of whoever was Admin; every other person is "not signed in yet" until you **Invite** them again from Members and they take their name back (other Admins come back as Members) | everyone signs in as before |
| Use it for | the work itself: a new host, a new server, a damaged database, opening the Workspace in the desktop app | putting **this** server back as it was: a failed upgrade, a mistake an hour ago, a disaster where re-inviting everyone is not wanted |

The daily Workspace file is the one to rely on: it is made by the server's own export (`infall-server export-workspace`), from a consistent snapshot, safe while the server runs; checked with `PRAGMA integrity_check`, compressed, and the newest `INFALL_BACKUP_KEEP` (14) are kept. One is made when the service starts if none is younger than a day. It is also what an Admin's **Settings → Workspace → Export Workspace file…** gives (compressed), so it opens in the desktop app too after `gunzip`.

```sh
docker compose run --rm backup backup            # a Workspace file now
docker compose run --rm backup backup-database   # a database copy now (sign-ins and all)
docker compose run --rm backup list-backups      # both kinds, newest first, each labelled
docker compose cp backup:/backups/infall-20260101T033000Z.infall.gz .   # copy one out of Docker
```

To have a database copy every day as well, set `INFALL_BACKUP_DATABASE=yes` in `.env` and run `docker compose up -d`. It keeps its own newest `INFALL_BACKUP_KEEP`.

Copies in a volume on the same host do not survive losing the host. Copy them off the host regularly (the `cp` line above, then `scp` or your provider's object storage). These files are not encrypted; the systemd route's `backup.sh` shows how to encrypt with `age` if they leave machines you control. A database copy also holds sign-in data (password hashes, session hashes, sealed AI keys): guard it like the server itself.

#### Restore from a Workspace file (the usual way)

Onto an empty server: a fresh setup on a new host, or this one with its data volume emptied. Everything made after that file is lost.

1. If you are reusing this host: `docker compose down`, then `docker volume rm infall_data` (this deletes the database; the backups volume stays). On a new host: steps 1–3 of [Steps](#steps).
2. `docker compose up -d`, then create the first Admin (step 4). Use your own email: you take over the work of whoever was Admin in the file.
3. Bring the file in, from the backups volume or from outside Docker:

   ```sh
   docker compose run --rm --no-deps backup import-workspace infall-20260101T033000Z.infall.gz --admin-email you@example.org
   # or, a file on this machine:
   docker compose run --rm -T --no-deps backup import-workspace - --admin-email you@example.org < infall-20260101T033000Z.infall.gz
   docker compose restart server
   ```

   It prints whose work is now yours and the names not signed in yet. Restart the server afterwards, as the command says: until then the running server refuses to write. (Instead of the command line, the Admin's first screen in the browser offers **Bring in a Workspace file…**; that needs no restart, but takes the file uncompressed: `gunzip` it first.)
4. Open **Members**. Each other person is listed as "<name> — not signed in yet": **Invite** them with their email; when they accept, their Changes, To-dos and Comments are theirs again. Members re-enter their OpenRouter keys if they used the AI sidebar in the browser.

#### Restore a database copy (this server, as it was)

Puts back everything, sign-ins included. Everything made after that copy is lost.

```sh
docker compose stop server
docker compose run --rm --no-deps backup restore infall-20260101T033000Z.db.gz
docker compose up -d
```

`restore` refuses while the server is running, and refuses a Workspace file (that would leave nobody able to sign in). It keeps the database it replaces as `infall.db.before-restore-<time>` in the data volume; delete it once you are sure. To restore a file from outside Docker, give `-` and send it on standard input:

```sh
docker compose run --rm -T --no-deps backup restore - < infall-20260101T033000Z.db.gz
```

The sealed OpenRouter keys in a database copy open only with the same secret key: on a new host set `INFALL_SECRET_KEY` to the old one, or Members type their keys again.

Do a test restore of both kinds once now, on your own computer with `INFALL_DOMAIN=localhost`, and then every few months. A backup you have never restored is a hope.

### Upgrade

With `INFALL_VERSION=latest`, one command, from this folder:

```sh
./update.sh
```

It brings in newer deploy files (`git pull --ff-only`, when this folder is a git checkout; it stops on your own edits to tracked files and never touches `.env`), makes a Workspace file with the version still running, pulls the image, recreates only what changed, and waits until the server is healthy. It prints the version now running at the end. If the server does not come up healthy, it shows the log and stops; go back as below. Without git (a copy of the folder), `./update.sh --no-pull` does the rest.

With a version number in `.env`, set `INFALL_VERSION` to the new number first, then run `./update.sh`.

Run it when a release is announced, while you can look at the result. It is deliberately not on a timer: a new version may migrate the database, and a failed start then needs someone to put it back.

By hand, the same thing is: `docker compose run --rm backup backup`, then `docker compose pull`, `docker compose up -d` and `docker compose logs server | tail`.

Before a different server opens the database, the image makes a database copy into `pre-upgrade/` in the data volume and says so in the log (`copying the database to /data/pre-upgrade/… first`). It keeps the last 3 such copies (`INFALL_UPGRADE_KEEP`). If that copy fails, the server does not start, and nothing has changed.

This one is a database copy on purpose, not a Workspace file: a newer server may migrate the database in place, an older one cannot be relied on to open a migrated file, and an older server also refuses a Workspace file made by a newer one. Only the copy from before the upgrade takes you back. **To go back**, set the old version's number as `INFALL_VERSION` (with `latest`, the copy's name says which version it came from: `…-from-0.9.0-…`) and restore it:

```sh
docker compose stop server
docker compose run --rm --no-deps --entrypoint ls server /data/pre-upgrade
docker compose run --rm --no-deps backup restore /data/pre-upgrade/infall-<time>-from-<version>-schema<n>.db
docker compose up -d
```

### Move the data elsewhere

To another host, or from this one to a fresh setup. Two ways, as for backups:

- **Everything, sign-ins included (a database copy).**
  1. On the old host: `docker compose stop server`, then `docker compose run --rm --no-deps backup backup-database` (`--no-deps` keeps the server stopped), then copy that file out (`docker compose cp …`, above) along with the secret key.
  2. On the new host: steps 1 and 2 of [Steps](#steps), with `INFALL_SECRET_KEY` set in `.env` to the old key. Skip creating an Admin: the Admins come with the data.
  3. On the new host, before the first start:

     ```sh
     docker compose run --rm -T --no-deps backup restore - < infall-<time>.db.gz
     docker compose up -d
     ```

  The new host must run the same version or a newer one.
- **The work only (a Workspace file).** The newest daily one, or an Admin's **Export Workspace file…**; then [Restore from a Workspace file](#restore-from-a-workspace-file-the-usual-way) on the new host. Everyone except you is invited again. This also works between different versions and from a Team server to the desktop app.

Then point the domain's DNS at the new host. If the domain changes, change `INFALL_DOMAIN`: invite links already sent still name the old one.

From the systemd route, the database copy way works with the database file itself: copy `/var/lib/infall/infall.db` with `sqlite3 /var/lib/infall/infall.db ".backup /tmp/infall.db"` and restore that file with `restore -` (a plain database file is taken as it is).

**A Local Workspace onto this server** comes as a Workspace file, onto an empty server only. The desktop app's **Move to a Team server…** does it in one press after you sign in; from a browser, the Admin's first screen offers **Bring in a Workspace file…**; on the command line:

```sh
docker compose run --rm -T --no-deps backup import-workspace - --admin-email you@example.org < project.infall
docker compose restart server
```

The Admin named there must exist (step 4); the Workspace file's own Member becomes that Admin. The command refuses, and changes nothing, when the server already has work in it.

### Forgot a password

```sh
docker compose run --rm server reset-password --email you@example.org
```

It asks for the new password like `create-admin`, and signs that person out everywhere.

### Build the image yourself

From the repository's root folder, on a machine with Docker and about 4 GB of free disk:

```sh
docker build -t infall:local .
```

Then set `INFALL_IMAGE=infall` and `INFALL_VERSION=local` in `.env`. The image is built for the machine's own processor (amd64 or arm64); the CI workflow `.github/workflows/image.yml` builds both and pushes them to a registry on every `v*` tag. A first build takes a few minutes; later ones reuse Docker's build cache.

### Troubleshooting

- **`server` is not `(healthy)`:** `docker compose logs server`. A line starting `infall:` says what the image did or refused (for example a data folder it cannot write). A line `infall-server: …` is the server's own reason.
- **The browser cannot connect, or warns about the certificate on a real domain:** `docker compose logs caddy`. Nearly always DNS not pointing at the host yet, or port 80 or 443 closed or taken (`sudo ss -tlnp | grep -E ':(80|443) '`). Caddy retries by itself; `docker compose restart caddy` retries now.
- **Sign-in fails with "This request did not come from the Infall app":** the address in the browser is not exactly `https://` + `INFALL_DOMAIN`. With other ports, set `INFALL_PUBLIC_ORIGIN` with the port.
- **`restore` says the server is still running:** `docker compose stop server` first.
- **`create-admin` says the email exists:** that Admin is there already; use `reset-password` if the password is lost.
- **Disk full:** `docker system df`. Old images of earlier versions can go: `docker image prune`. Do not remove volumes.
- **The backup service is `(unhealthy)`:** no Workspace file younger than 26 hours. `docker compose logs backup` says why.
- **`import-workspace` says the Workspace is not empty:** a Workspace file goes only onto an empty server. Restore onto a fresh data volume ([Restore from a Workspace file](#restore-from-a-workspace-file-the-usual-way)), or use a database copy with `restore`.
- **After `import-workspace` the page says something went wrong when you change anything:** the server was running during the import; `docker compose restart server`.

## The systemd route

Infall is one binary (`infall-server`), a folder of static web files, and one SQLite file. Caddy sits in front and provides HTTPS. This route takes a fresh Debian or Ubuntu VPS to a working server without Docker, and its backups are encrypted. It needs about an hour.

This guide has been followed, command by command, on a clean Debian 12 in a container: `scripts/rehearse-deploy.sh` does that again whenever you want, including a backup and a restore, and never touches a real server. What a container cannot show is listed at the end of its output: a real certificate, real DNS, and the steps of [harden.md](harden.md).

On this route, placeholders: replace `infall.example.org` with your domain and `YOUR_AGE_PUBLIC_KEY` with your backup public key everywhere they appear. Commands starting with `sudo` run on the VPS unless stated otherwise. All files named below are in this `deploy/` folder, and steps 4, 6 and 9 are run from inside a copy of it on the VPS (step 3 puts it there).

### 1. Prerequisites

1. A small VPS running a current Debian or Ubuntu LTS, with 1 GB RAM or more (2 GB if you build on it), and SSH access with a sudo-capable user.
2. A domain name with an `A` record (and `AAAA` if the VPS has IPv6) pointing at the VPS. Caddy cannot get a certificate until this resolves: check with `dig +short infall.example.org`.
3. Do the checklist in [harden.md](harden.md) now (firewall, key-only SSH, automatic updates), before the server holds anything. The safe setup is the one done first.

### 2. Create the service user and directories

A dedicated user with no login means a bug in Infall cannot touch anything else on the machine.

```sh
sudo adduser --system --group --no-create-home --home /nonexistent infall
sudo install -d -o root -g root -m 755 /opt/infall /opt/infall/web
sudo install -d -o infall -g infall -m 700 /var/lib/infall
sudo install -d -o infall -g infall -m 700 /var/backups/infall
sudo install -d -o root -g infall -m 750 /etc/infall
```

(`adduser` warns that the home directory `/nonexistent` cannot be accessed. That is intended: the account has no home.)

- `/opt/infall` is owned by root, so the running server cannot rewrite its own program or UI files.
- `/var/lib/infall` (the database) is mode 700: nobody but `infall` and root can read it.
- `/etc/infall` holds the config file, readable by `infall` only.

### 3. Get the program onto the server

You need two things: the server binary and the built web UI. The binary must be built for Linux, so a binary built on a Mac or Windows laptop will not run. Build either on the VPS (3a) or on another Linux machine of the same distribution (3b). The web UI is plain files and can be built anywhere.

#### 3a. Build on the VPS

```sh
sudo apt update
sudo apt install -y build-essential pkg-config git curl
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # accept defaults, then: . "$HOME/.cargo/env"
```

Install Node.js 22 or newer (the web build needs it; 20.19 or newer also works) from [nodejs.org](https://nodejs.org/en/download) or your preferred method. The `nodejs` package of Debian 12 is version 18, which is too old. Then:

```sh
git clone YOUR_REPOSITORY_URL infall-src && cd infall-src
cargo build --release --locked -p infall-server
(cd web && npm ci && npm run build)
```

`--locked` builds with exactly the library versions the repository was tested with. The kit files are now in `infall-src/deploy`.

If `cargo` is killed for lack of memory on a 1 GB VPS, add swap first, or use 3b.

#### 3b. Build elsewhere and copy

On a Linux machine with the same distribution family and the same kind of processor as the VPS, run the same two build commands (`cargo build --release --locked -p infall-server`, and `npm ci && npm run build` inside `web/`). Then copy the outputs and the kit files up:

```sh
scp target/release/infall-server you@infall.example.org:/tmp/
scp -r web/dist you@infall.example.org:/tmp/infall-web
scp -r deploy you@infall.example.org:/tmp/infall-deploy
```

`/tmp` is emptied when the VPS restarts. For step 10 and for later changes to the backup you copy them up again.

#### Install the outputs

Where each output goes:

| Built file | Install location |
|---|---|
| `target/release/infall-server` | `/opt/infall/infall-server` |
| contents of `web/dist/` | `/opt/infall/web/` |

```sh
# Run from the source folder (3a) or from /tmp (3b, using the copied paths).
sudo install -o root -g root -m 755 target/release/infall-server /opt/infall/infall-server
sudo cp -r web/dist/. /opt/infall/web/
sudo chown -R root:root /opt/infall/web
```

(For 3b use `/tmp/infall-server` and `/tmp/infall-web/.` as the sources.)

### 4. Configuration and the systemd service

Go into the kit folder: `cd infall-src/deploy` (3a) or `cd /tmp/infall-deploy` (3b). Steps 4, 6 and 9 name its files without a path.

```sh
sudo install -o root -g infall -m 640 infall.env.example /etc/infall/infall.env
sudoedit /etc/infall/infall.env
```

Set `INFALL_PUBLIC_ORIGIN` to your real `https://` address. It controls the secure-cookie flag, which Origin is accepted for changes, and the invite links, so a mistake shows up as failed logins. Leave `INFALL_DEV_ORIGIN` unset: it is only for local development and would add a second allowed origin. The backup variables are filled in during step 9.

```sh
sudo install -o root -g root -m 644 infall.service /etc/systemd/system/infall.service
sudo systemctl daemon-reload
sudo systemctl enable infall
```

Do not start it yet: the first Admin is created first.

### 5. Create the first Admin

```sh
sudo -u infall env INFALL_DB=/var/lib/infall/infall.db \
  /opt/infall/infall-server create-admin --email you@example.org --name "Your Name"
sudo chmod 600 /var/lib/infall/infall.db
```

It asks for a password (at least 12 characters), twice, and does not show what you type. It prints `Created Admin Your Name <you@example.org>.` This command also creates the database file, and the server creates it private to the `infall` account (mode 600), whichever command comes first; the folder around it keeps others out as well. The `chmod` is a second check that costs nothing: it changes nothing on a file made by this version, and makes private one that an earlier version left readable by everyone (the server never changes the rights of a file that is already there — it says so in its log instead). Use a password manager's generated password. The password is deliberately not a command-line option: arguments are visible to every user on the machine through `ps` and are saved in shell history. For the same reason do not put `INFALL_ADMIN_PASSWORD` in a file or in your shell. The command refuses if that email already exists.

### 6. Install Caddy and start everything

This is the official Caddy package repository, so Caddy receives updates through `apt`.

```sh
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

(The `chmod` is for a shell that creates private files by default: without it `apt update` cannot read the key and fails with `NO_PUBKEY`.) Installing the package starts Caddy with a placeholder page.

Put your domain into the Caddyfile and install it:

```sh
sed 's/infall\.example\.org/YOUR.DOMAIN/g' Caddyfile | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl start infall
sudo systemctl reload caddy
```

(Replace `YOUR.DOMAIN` with your domain, or edit `/etc/caddy/Caddyfile` by hand.) Caddy now fetches a certificate automatically, which can take under a minute. The Caddyfile refuses request bodies over the server's own limits (1 MiB; 2 MiB on the one route that carries the captured result of a Run; 100 MiB for a PDF, 20 MiB for its text; 8192 MiB for a Workspace file brought onto an empty server) and adds an HSTS header; the server sets its own content-security headers. If you change one of these limits, change it in both places.

### 7. First login and inviting the others

1. Open `https://infall.example.org` and sign in with the Admin email and password.
2. As Admin, create an invite for each person: their email, and role Member (the students) or Guest (with an end date, for outside readers such as a professor you only want to give temporary access).
3. Infall shows the invite link once, when you create it. Send it to that person over a channel you trust. It works one time and expires after 7 days.
4. They open the link, choose a name and a password of at least 12 characters, and are signed in.

There is no open sign-up: nobody gets an account without an invite. To remove someone, delete their account in the people list; their past changes stay attributed to them.

### 8. Check that it is healthy

```sh
systemctl status infall                 # should say "active (running)"
journalctl -u infall -n 50 --no-pager   # recent log lines; add -f to follow live
systemctl status caddy
curl -fsS https://infall.example.org/api/health   # must print {"ok":true}
curl -I https://infall.example.org/
```

The health call succeeds once the server has opened its database, and reveals nothing else. The header check below confirms Caddy's HTTPS and the headers.

The `curl -I` output should show `HTTP/2 200`, a `strict-transport-security` header (from Caddy), and `x-content-type-options: nosniff`, `referrer-policy: same-origin` and a `content-security-policy` header (from the server; the CSP is on the HTML page). Also check that plain HTTP redirects: `curl -I http://infall.example.org/` should answer with a redirect to `https://`. If the page does not load, `journalctl -u caddy` explains certificate problems (usually DNS or a closed port 80/443).

### Forgot a password

An Admin who forgot their password (or anyone, if no other Admin can help) is reset from the server shell:

```sh
sudo -u infall env INFALL_DB=/var/lib/infall/infall.db \
  /opt/infall/infall-server reset-password --email you@example.org
```

Type the new password at the prompt (at least 12 characters; not shown, not on the command line, for the reason in step 5). This also signs that person out everywhere. Needing shell access is deliberate: only someone who already administers the machine can take over an account.

### 9. Backups

Everything lives in one file, so one encrypted daily copy is enough. The backups are encrypted with a public key; the matching private key stays on your own laptop, never on the server. That way a stolen backup (or a compromised server) does not leak the data.

1. On your laptop (not the VPS) install `age` and make a key pair:

   ```sh
   age-keygen -o infall-backup-key.txt
   ```

   It prints `Public key: age1...`. That public key is what goes on the server. Store `infall-backup-key.txt` in your password manager and keep a second copy somewhere offline: **if you lose it, the backups are unreadable.** Never copy it to the VPS.

2. On the VPS, in the kit folder again (see step 4):

   ```sh
   sudo apt install -y sqlite3 age
   sudo install -o root -g root -m 755 backup.sh /opt/infall/backup.sh
   sudo install -o root -g root -m 644 infall-backup.service infall-backup.timer /etc/systemd/system/
   sudoedit /etc/infall/infall.env      # set INFALL_BACKUP_AGE_RECIPIENT to your age1... public key
   sudo systemctl daemon-reload
   sudo systemctl enable --now infall-backup.timer
   sudo systemctl start infall-backup.service      # run one now
   journalctl -u infall-backup -n 20 --no-pager
   sudo ls -l /var/backups/infall
   ```

   You should see a file like `infall-20260101T033000Z.db.gz.age`. A timer runs it daily at about 03:30 and catches up after downtime. Local copies older than 14 days are removed.

3. Copies on the same machine do not survive losing the machine. Set up an off-machine copy with rclone (any provider it supports, for example an object-storage bucket or another server over SFTP):

   ```sh
   sudo apt install -y rclone
   sudo RCLONE_CONFIG=/etc/infall/rclone.conf rclone config      # create a remote, e.g. named "offsite"
   sudo chown root:infall /etc/infall/rclone.conf && sudo chmod 640 /etc/infall/rclone.conf
   ```

   Then uncomment `INFALL_BACKUP_REMOTE=offsite:infall-backups` and `RCLONE_CONFIG=/etc/infall/rclone.conf` in `/etc/infall/infall.env` and run the backup service again. Use credentials limited to that one bucket. The remote keeps every copy; set a retention rule on the provider's side. Pruning is only done locally.

#### Test a restore (do this once now, then every few months)

A backup you have never restored is a hope, not a backup. Step A needs only your laptop and proves the file and the key work; step B is the real procedure.

**A. Check a backup on your laptop** (needs `age` and `sqlite3`):

```sh
scp you@infall.example.org:/var/backups/infall/infall-TIMESTAMP.db.gz.age .
age -d -i infall-backup-key.txt infall-TIMESTAMP.db.gz.age | gunzip > restored.db
sqlite3 restored.db 'PRAGMA integrity_check;'     # must print: ok
```

(If scp is refused because the directory is private to `infall`, run `sudo cp` into your home first and `chown` it to yourself, or fetch it from the off-machine copy.)

**B. Restore onto the server.** Decrypt on the laptop as above, then:

```sh
scp restored.db you@infall.example.org:/tmp/restored.db
# on the VPS:
sudo systemctl stop infall
sudo mv /var/lib/infall/infall.db /var/lib/infall/infall.db.before-restore
sudo rm -f /var/lib/infall/infall.db-wal /var/lib/infall/infall.db-shm
sudo install -o infall -g infall -m 600 /tmp/restored.db /var/lib/infall/infall.db
sudo rm /tmp/restored.db
sudo systemctl start infall
systemctl status infall
```

The database runs in WAL mode, so it has companion `-wal`/`-shm` files; stale ones left from the old database would not match the restored file, which is why they are removed. (A backup is one self-contained file: the backup script's online copy already includes everything committed.) Everything made after the backup is lost; keep `infall.db.before-restore` until you are sure, then delete it.

### 10. Updating to a new version

The database format only moves forward: the server records a schema version in the file and a newer version migrates an older file in place when it starts, but an older version cannot be relied on to open a migrated file (it refuses one). While it migrates, the server keeps a copy of the file as it was beside it (`infall.db.v<old version>-backup`) and removes it once the migration has succeeded; if the migration fails, the file is left as it was and the copy stays. So the backup is your way back. `systemctl stop infall` sends SIGTERM, and the server shuts down gracefully: it finishes in-flight requests (a database write is never cut off) and exits within a few seconds.

```sh
sudo systemctl start infall-backup.service            # 1. fresh backup (check it succeeded)
journalctl -u infall-backup -n 5 --no-pager
sudo systemctl stop infall                            # 2. stop
sudo cp -a /opt/infall/infall-server /opt/infall/infall-server.prev
sudo install -o root -g root -m 755 target/release/infall-server /opt/infall/infall-server   # 3. replace
sudo rm -rf /opt/infall/web && sudo install -d -o root -g root -m 755 /opt/infall/web
sudo cp -r web/dist/. /opt/infall/web/ && sudo chown -R root:root /opt/infall/web
sudo systemctl start infall                           # 4. start
systemctl status infall && journalctl -u infall -n 20 --no-pager
```

(Build first as in step 3.) To roll back: stop, restore the pre-update backup (step 9B), put `infall-server.prev` back, start.

## Upgrading from a pre-rename install

Builds before the code was renamed (0.9.0, before its release) called everything `qoop`. Nothing looks for those names, except that the server, `backup.sh` and the image's entrypoint still read a `QOOP_…` variable when its `INFALL_…` one is not set, with a warning (rename them anyway). Make a backup first, then:

- **Container route.** In `.env`, rename every `QOOP_…` variable to `INFALL_…`. The project is now called `infall`, so its volumes are `infall_data`, `infall_backups`, …; the old ones are `qoop_data`, …. Copy the old data volume into the new one before the first start (`docker run --rm -v qoop_data:/from -v infall_data:/to debian:trixie-slim cp -a /from/. /to/`, and the same for `qoop_backups`), then rename the database in it: `docker compose run --rm --no-deps --entrypoint mv server /data/qoop.db /data/infall.db` (also `-wal` and `-shm` if they are there; the server was stopped). The secret key file keeps its name.
- **systemd route.** `sudo systemctl disable --now qoop.service qoop-backup.timer`, then move the folders: `/opt/qoop` → `/opt/infall` (the program is now `infall-server`: install it as in step 3), `/etc/qoop/qoop.env` → `/etc/infall/infall.env` (rename the variables in it), `/var/lib/qoop/qoop.db` → `/var/lib/infall/infall.db`, `/var/backups/qoop` → `/var/backups/infall`. Make the `infall` user as in step 2 and `chown -R infall:infall` the two folders it owns (or keep the old user by changing `User=`/`Group=` in the units). Install `infall.service`, `infall-backup.service` and `infall-backup.timer` as in steps 4 and 9, remove the three old units from `/etc/systemd/system/`, `sudo systemctl daemon-reload`, and start as usual.
- **Access tokens** made before the rename (`qoop_pat_…`) keep working; people sign in again once (the session cookie has a new name).

## What protects you, and what does not

What both routes do:

- **TLS.** Caddy serves only HTTPS with an automatically renewed certificate, and HSTS tells browsers never to try plain HTTP. Traffic cannot be read or altered on the way.
- **Invite-only accounts.** There is no sign-up page. Invites work once and expire in 7 days; passwords are stored hashed (Argon2id); repeated wrong logins are rate-limited.
- **Small attack surface.** The firewall allows only SSH, HTTP and HTTPS, and SSH takes keys only. Caddy is the only way in: on the systemd route Infall listens on `127.0.0.1` only; in the container it is reachable only on the compose network, and only Caddy publishes ports.
- **Contained service.** Infall runs as an unprivileged user that can write only to its own data folder: in a systemd sandbox, or in a container with a read-only system, no capabilities and `no-new-privileges`.
- **Automatic security updates** for the operating system (not for Infall or Caddy: update those yourselves — on the systemd route step 10 and `sudo apt upgrade`; in the container `./update.sh`, which also brings a newer `caddy:2.x` tag once `compose.yaml` names one).
- **Backups.** On the systemd route encrypted, with the decryption key off the server, plus an off-machine copy if you set one up. In the container a daily Workspace file (the work, no sign-ins), consistent and checked, plus database copies before upgrades and on request; not encrypted, and on the same host until you copy them off.
- **Few outgoing requests.** The server connects out only for two things, and only when a Member uses them: the AI sidebar's OpenRouter path (once a Member has added a key), and **Look up** in the Source form, which sends one DOI to `api.crossref.org` or one arXiv id to `export.arxiv.org` over HTTPS, with nothing about the Workspace or the person. The firewall of [harden.md](harden.md) allows outgoing connections; if you restrict them, allow HTTPS to those hosts, or those two features say they could not reach them. The full list for Members: [docs/privacy.md](../docs/privacy.md).

What it does not do:

- It is not hardened against a targeted attacker. It stops opportunistic scanning and casual mistakes, not a determined attempt on the box.
- Whoever administers the VPS can read everything: the database, the running process, and any API keys Members store in Infall later. Hosting providers have the same technical ability. Do not put in anything you could not accept those people seeing, and keep the number of people with `sudo` and with the provider's account as small as possible.
- Anyone holding a Member's password or session can read what that Member can. Use a password manager and long unique passwords.
- Password resets need shell access to the server ("Forgot a password" in either route).
- Losing the backup private key (systemd route) means losing the backups.
- The container's backups are readable by whoever can read the host's Docker volumes, as the database itself is.
