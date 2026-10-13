# Deploying Qoop on a VPS

Qoop is one binary (`qoop-server`), a folder of static web files, and one SQLite file. Caddy sits in front and provides HTTPS. This guide takes a fresh Debian or Ubuntu VPS to a working server. It needs about an hour.

Placeholders: replace `qoop.example.org` with your domain and `YOUR_AGE_PUBLIC_KEY` with your backup public key everywhere they appear. Commands starting with `sudo` run on the VPS unless stated otherwise. All files named below are in this `deploy/` folder, and steps 4, 6 and 9 are run from inside a copy of it on the VPS (step 3 puts it there).

This guide has been followed, command by command, on a clean Debian 12 in a container: `scripts/rehearse-deploy.sh` does that again whenever you want, including a backup and a restore, and never touches a real server. What a container cannot show is listed at the end of its output: a real certificate, real DNS, and the steps of [harden.md](harden.md).

## 1. Prerequisites

1. A small VPS running a current Debian or Ubuntu LTS, with 1 GB RAM or more (2 GB if you build on it), and SSH access with a sudo-capable user.
2. A domain name with an `A` record (and `AAAA` if the VPS has IPv6) pointing at the VPS. Caddy cannot get a certificate until this resolves: check with `dig +short qoop.example.org`.
3. Do the checklist in [harden.md](harden.md) now (firewall, key-only SSH, automatic updates), before the server holds anything. The safe setup is the one done first.

## 2. Create the service user and directories

A dedicated user with no login means a bug in Qoop cannot touch anything else on the machine.

```sh
sudo adduser --system --group --no-create-home --home /nonexistent qoop
sudo install -d -o root -g root -m 755 /opt/qoop /opt/qoop/web
sudo install -d -o qoop -g qoop -m 700 /var/lib/qoop
sudo install -d -o qoop -g qoop -m 700 /var/backups/qoop
sudo install -d -o root -g qoop -m 750 /etc/qoop
```

(`adduser` warns that the home directory `/nonexistent` cannot be accessed. That is intended: the account has no home.)

- `/opt/qoop` is owned by root, so the running server cannot rewrite its own program or UI files.
- `/var/lib/qoop` (the database) is mode 700: nobody but `qoop` and root can read it.
- `/etc/qoop` holds the config file, readable by `qoop` only.

## 3. Get the program onto the server

You need two things: the server binary and the built web UI. The binary must be built for Linux, so a binary built on a Mac or Windows laptop will not run. Build either on the VPS (3a) or on another Linux machine of the same distribution (3b). The web UI is plain files and can be built anywhere.

### 3a. Build on the VPS

```sh
sudo apt update
sudo apt install -y build-essential pkg-config git curl
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # accept defaults, then: . "$HOME/.cargo/env"
```

Install Node.js 22 or newer (the web build needs it; 20.19 or newer also works) from [nodejs.org](https://nodejs.org/en/download) or your preferred method. The `nodejs` package of Debian 12 is version 18, which is too old. Then:

```sh
git clone YOUR_REPOSITORY_URL qoop-src && cd qoop-src
cargo build --release --locked -p qoop-server
(cd web && npm ci && npm run build)
```

`--locked` builds with exactly the library versions the repository was tested with. The kit files are now in `qoop-src/deploy`.

If `cargo` is killed for lack of memory on a 1 GB VPS, add swap first, or use 3b.

### 3b. Build elsewhere and copy

On a Linux machine with the same distribution family and the same kind of processor as the VPS, run the same two build commands (`cargo build --release --locked -p qoop-server`, and `npm ci && npm run build` inside `web/`). Then copy the outputs and the kit files up:

```sh
scp target/release/qoop-server you@qoop.example.org:/tmp/
scp -r web/dist you@qoop.example.org:/tmp/qoop-web
scp -r deploy you@qoop.example.org:/tmp/qoop-deploy
```

`/tmp` is emptied when the VPS restarts. For step 10 and for later changes to the backup you copy them up again.

### Install the outputs

Where each output goes:

| Built file | Install location |
|---|---|
| `target/release/qoop-server` | `/opt/qoop/qoop-server` |
| contents of `web/dist/` | `/opt/qoop/web/` |

```sh
# Run from the source folder (3a) or from /tmp (3b, using the copied paths).
sudo install -o root -g root -m 755 target/release/qoop-server /opt/qoop/qoop-server
sudo cp -r web/dist/. /opt/qoop/web/
sudo chown -R root:root /opt/qoop/web
```

(For 3b use `/tmp/qoop-server` and `/tmp/qoop-web/.` as the sources.)

## 4. Configuration and the systemd service

Go into the kit folder: `cd qoop-src/deploy` (3a) or `cd /tmp/qoop-deploy` (3b). Steps 4, 6 and 9 name its files without a path.

```sh
sudo install -o root -g qoop -m 640 qoop.env.example /etc/qoop/qoop.env
sudoedit /etc/qoop/qoop.env
```

Set `QOOP_PUBLIC_ORIGIN` to your real `https://` address. It controls the secure-cookie flag, which Origin is accepted for changes, and the invite links, so a mistake shows up as failed logins. Leave `QOOP_DEV_ORIGIN` unset: it is only for local development and would add a second allowed origin. The backup variables are filled in during step 9.

```sh
sudo install -o root -g root -m 644 qoop.service /etc/systemd/system/qoop.service
sudo systemctl daemon-reload
sudo systemctl enable qoop
```

Do not start it yet: the first Admin is created first.

## 5. Create the first Admin

```sh
sudo -u qoop env QOOP_DB=/var/lib/qoop/qoop.db \
  /opt/qoop/qoop-server create-admin --email you@example.org --name "Your Name"
sudo chmod 600 /var/lib/qoop/qoop.db
```

It asks for a password (at least 12 characters), twice, and does not show what you type. It prints `Created Admin Your Name <you@example.org>.` This command also creates the database file, and outside the service it is created readable by everyone (mode 644): the folder around it already keeps others out, and the `chmod` makes the file itself private as well, as the service and a restore do. Use a password manager's generated password. The password is deliberately not a command-line option: arguments are visible to every user on the machine through `ps` and are saved in shell history. For the same reason do not put `QOOP_ADMIN_PASSWORD` in a file or in your shell. The command refuses if that email already exists.

## 6. Install Caddy and start everything

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
sed 's/qoop\.example\.org/YOUR.DOMAIN/g' Caddyfile | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl start qoop
sudo systemctl reload caddy
```

(Replace `YOUR.DOMAIN` with your domain, or edit `/etc/caddy/Caddyfile` by hand.) Caddy now fetches a certificate automatically, which can take under a minute. The Caddyfile refuses request bodies over the server's own limits (1 MiB; 2 MiB on the one route that carries the captured result of a Run) and adds an HSTS header; the server sets its own content-security headers. If you change one of these limits, change it in both places.

## 7. First login and inviting the others

1. Open `https://qoop.example.org` and sign in with the Admin email and password.
2. As Admin, create an invite for each person: their email, and role Member (the students) or Guest (with an end date, for outside readers such as a professor you only want to give temporary access).
3. Qoop shows the invite link once, when you create it. Send it to that person over a channel you trust. It works one time and expires after 7 days.
4. They open the link, choose a name and a password of at least 12 characters, and are signed in.

There is no open sign-up: nobody gets an account without an invite. To remove someone, delete their account in the people list; their past changes stay attributed to them.

## 8. Check that it is healthy

```sh
systemctl status qoop                 # should say "active (running)"
journalctl -u qoop -n 50 --no-pager   # recent log lines; add -f to follow live
systemctl status caddy
curl -fsS https://qoop.example.org/api/health   # must print {"ok":true}
curl -I https://qoop.example.org/
```

The health call succeeds once the server has opened its database, and reveals nothing else. The header check below confirms Caddy's HTTPS and the headers.

The `curl -I` output should show `HTTP/2 200`, a `strict-transport-security` header (from Caddy), and `x-content-type-options: nosniff`, `referrer-policy: same-origin` and a `content-security-policy` header (from the server; the CSP is on the HTML page). Also check that plain HTTP redirects: `curl -I http://qoop.example.org/` should answer with a redirect to `https://`. If the page does not load, `journalctl -u caddy` explains certificate problems (usually DNS or a closed port 80/443).

## Forgot a password

An Admin who forgot their password (or anyone, if no other Admin can help) is reset from the server shell:

```sh
sudo -u qoop env QOOP_DB=/var/lib/qoop/qoop.db \
  /opt/qoop/qoop-server reset-password --email you@example.org
```

Type the new password at the prompt (at least 12 characters; not shown, not on the command line, for the reason in step 5). This also signs that person out everywhere. Needing shell access is deliberate: only someone who already administers the machine can take over an account.

## 9. Backups

Everything lives in one file, so one encrypted daily copy is enough. The backups are encrypted with a public key; the matching private key stays on your own laptop, never on the server. That way a stolen backup (or a compromised server) does not leak the data.

1. On your laptop (not the VPS) install `age` and make a key pair:

   ```sh
   age-keygen -o qoop-backup-key.txt
   ```

   It prints `Public key: age1...`. That public key is what goes on the server. Store `qoop-backup-key.txt` in your password manager and keep a second copy somewhere offline: **if you lose it, the backups are unreadable.** Never copy it to the VPS.

2. On the VPS, in the kit folder again (see step 4):

   ```sh
   sudo apt install -y sqlite3 age
   sudo install -o root -g root -m 755 backup.sh /opt/qoop/backup.sh
   sudo install -o root -g root -m 644 qoop-backup.service qoop-backup.timer /etc/systemd/system/
   sudoedit /etc/qoop/qoop.env      # set QOOP_BACKUP_AGE_RECIPIENT to your age1... public key
   sudo systemctl daemon-reload
   sudo systemctl enable --now qoop-backup.timer
   sudo systemctl start qoop-backup.service      # run one now
   journalctl -u qoop-backup -n 20 --no-pager
   sudo ls -l /var/backups/qoop
   ```

   You should see a file like `qoop-20260101T033000Z.db.gz.age`. A timer runs it daily at about 03:30 and catches up after downtime. Local copies older than 14 days are removed.

3. Copies on the same machine do not survive losing the machine. Set up an off-machine copy with rclone (any provider it supports, for example an object-storage bucket or another server over SFTP):

   ```sh
   sudo apt install -y rclone
   sudo RCLONE_CONFIG=/etc/qoop/rclone.conf rclone config      # create a remote, e.g. named "offsite"
   sudo chown root:qoop /etc/qoop/rclone.conf && sudo chmod 640 /etc/qoop/rclone.conf
   ```

   Then uncomment `QOOP_BACKUP_REMOTE=offsite:qoop-backups` and `RCLONE_CONFIG=/etc/qoop/rclone.conf` in `/etc/qoop/qoop.env` and run the backup service again. Use credentials limited to that one bucket. The remote keeps every copy; set a retention rule on the provider's side. Pruning is only done locally.

### Test a restore (do this once now, then every few months)

A backup you have never restored is a hope, not a backup. Step A needs only your laptop and proves the file and the key work; step B is the real procedure.

**A. Check a backup on your laptop** (needs `age` and `sqlite3`):

```sh
scp you@qoop.example.org:/var/backups/qoop/qoop-TIMESTAMP.db.gz.age .
age -d -i qoop-backup-key.txt qoop-TIMESTAMP.db.gz.age | gunzip > restored.db
sqlite3 restored.db 'PRAGMA integrity_check;'     # must print: ok
```

(If scp is refused because the directory is private to `qoop`, run `sudo cp` into your home first and `chown` it to yourself, or fetch it from the off-machine copy.)

**B. Restore onto the server.** Decrypt on the laptop as above, then:

```sh
scp restored.db you@qoop.example.org:/tmp/restored.db
# on the VPS:
sudo systemctl stop qoop
sudo mv /var/lib/qoop/qoop.db /var/lib/qoop/qoop.db.before-restore
sudo rm -f /var/lib/qoop/qoop.db-wal /var/lib/qoop/qoop.db-shm
sudo install -o qoop -g qoop -m 600 /tmp/restored.db /var/lib/qoop/qoop.db
sudo rm /tmp/restored.db
sudo systemctl start qoop
systemctl status qoop
```

The database runs in WAL mode, so it has companion `-wal`/`-shm` files; stale ones left from the old database would not match the restored file, which is why they are removed. (A backup is one self-contained file: the backup script's online copy already includes everything committed.) Everything made after the backup is lost; keep `qoop.db.before-restore` until you are sure, then delete it.

## 10. Updating to a new version

The database format only moves forward: the server records a schema version in the file and a newer version migrates an older file in place when it starts, but an older version cannot be relied on to open a migrated file. So the backup is your way back. `systemctl stop qoop` sends SIGTERM, and the server shuts down gracefully: it finishes in-flight requests (a database write is never cut off) and exits within a few seconds.

```sh
sudo systemctl start qoop-backup.service            # 1. fresh backup (check it succeeded)
journalctl -u qoop-backup -n 5 --no-pager
sudo systemctl stop qoop                            # 2. stop
sudo cp -a /opt/qoop/qoop-server /opt/qoop/qoop-server.prev
sudo install -o root -g root -m 755 target/release/qoop-server /opt/qoop/qoop-server   # 3. replace
sudo rm -rf /opt/qoop/web && sudo install -d -o root -g root -m 755 /opt/qoop/web
sudo cp -r web/dist/. /opt/qoop/web/ && sudo chown -R root:root /opt/qoop/web
sudo systemctl start qoop                           # 4. start
systemctl status qoop && journalctl -u qoop -n 20 --no-pager
```

(Build first as in step 3.) To roll back: stop, restore the pre-update backup (step 9B), put `qoop-server.prev` back, start.

## What protects you, and what does not

What this setup does:

- **TLS.** Caddy serves only HTTPS with an automatically renewed certificate, and HSTS tells browsers never to try plain HTTP. Traffic cannot be read or altered on the way.
- **Invite-only accounts.** There is no sign-up page. Invites work once and expire in 7 days; passwords are stored hashed (Argon2id); repeated wrong logins are rate-limited.
- **Small attack surface.** The firewall allows only SSH, HTTP and HTTPS. Qoop listens on `127.0.0.1` only, so Caddy is the only way in, and SSH takes keys only.
- **Contained service.** Qoop runs as an unprivileged user, in a systemd sandbox that can write only to its own database folder.
- **Automatic security updates** for the operating system (not for Qoop or Caddy: update those yourselves, step 10 and `sudo apt upgrade`).
- **Encrypted backups** whose decryption key is not on the server, plus an off-machine copy if you set one up.

What it does not do:

- It is not hardened against a targeted attacker. It stops opportunistic scanning and casual mistakes, not a determined attempt on the box.
- Whoever administers the VPS can read everything: the database, the running process, and any API keys Members store in Qoop later. Hosting providers have the same technical ability. Do not put in anything you could not accept those people seeing, and keep the number of people with `sudo` and with the provider's account as small as possible.
- Anyone holding a Member's password or session can read what that Member can. Use a password manager and long unique passwords.
- Password resets need shell access to the server (see "Forgot a password").
- Losing the backup private key means losing the backups.
