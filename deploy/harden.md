# Server hardening checklist

Do these on a fresh VPS before installing Qoop. Run commands as your normal sudo user. Keep your first SSH session open until step 2 is confirmed working from a second terminal, so a mistake cannot lock you out.

## 1. Firewall: allow only SSH, HTTP, HTTPS

Why: anything not listed is unreachable from the internet even if some service starts listening by accident. Port 80 is needed for Caddy's certificates and the redirect to HTTPS.

```sh
sudo apt update
sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

If you moved SSH to another port, allow that port instead of 22 before `enable`.

## 2. SSH: keys only, no root password login

Why: password logins on a public server are guessed by bots all day; a key cannot be guessed.

First, from your laptop, install your public key and confirm it works in a new terminal (skip if your provider already set one up):

```sh
ssh-copy-id you@qoop.example.org
ssh you@qoop.example.org        # must log in without asking for the account password
```

Then on the VPS. The file name starts with `00-` on purpose: SSH uses the first value it finds, and cloud images ship a file that re-enables passwords.

```sh
sudo tee /etc/ssh/sshd_config.d/00-qoop.conf >/dev/null <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
CONF
sudo sshd -t && sudo systemctl reload ssh
sudo sshd -T | grep -E '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin)'
```

The last command must show `passwordauthentication no`, `kbdinteractiveauthentication no` and `permitrootlogin prohibit-password`. Use `PermitRootLogin no` instead if you log in as a normal user (recommended). Now open a second terminal and confirm you can still log in.

## 3. Automatic security updates

Why: most break-ins use bugs that already have a fix; this installs the fixes without anyone remembering to.

```sh
sudo apt install -y unattended-upgrades
echo 'APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";' | sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null
sudo unattended-upgrade --dry-run -d 2>&1 | tail -n 5
systemctl list-timers 'apt-daily*'
```

Some updates (the kernel) apply only after a reboot. Check now and then: `ls /var/run/reboot-required` (if the file exists, run `sudo reboot` at a quiet moment; Qoop and Caddy start by themselves). Caddy and Qoop are not covered by this; run `sudo apt update && sudo apt upgrade` for Caddy monthly.

## 4. Confirm nothing else listens publicly

Why: this is the real test that the firewall and the loopback-only setting do what you think.

```sh
sudo ss -tlnp
```

Expected after Qoop is installed:

- `0.0.0.0:22` / `[::]:22` (sshd), `*:80` and `*:443` (caddy): public, intended.
- `127.0.0.1:8787` (qoop-server): local only, intended.
- `127.0.0.1:2019` (caddy admin) and `127.0.0.53:53` / `127.0.0.54:53` (DNS resolver): local only, fine.

Anything else on `0.0.0.0`, `[::]` or `*` needs an explanation: stop and disable that service, or remove the package. Finally, from your laptop, confirm the server's port is closed from outside: `nc -vz qoop.example.org 8787` must fail.
