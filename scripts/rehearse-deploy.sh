#!/usr/bin/env bash
# Rehearses deploy/README.md from an empty machine to a signed-in Admin, a restored
# backup and a new Member's first day, and says at the end what it checked.
#
# What it does, in the guide's order:
#   - builds the server for Linux in a throwaway Debian 12 container (guide 3a's
#     commands) and uses web/dist built on this computer (guide 3b);
#   - starts a clean Debian 12 container with systemd as its first process: this is
#     "the VPS". It installs Sheaf there with the guide's commands and the kit files in
#     deploy/, unchanged;
#   - checks the service, HTTPS, the headers, the redirect, file rights, the sandbox
#     and the request body limits;
#   - walks the first day through the API (docs/first-day.md): invite, accept once,
#     sign in, a Card;
#   - takes a backup with the guide's unit, destroys the database, and restores it
#     with the guide's steps from the encrypted file alone. A second container is
#     "your laptop": the backup key is made there and never reaches "the VPS".
#
# The one deliberate difference from the guide: a rehearsal has no public name, so
# Caddy cannot get a real certificate. The site is called qoop.test (it resolves only
# inside the container), one line `tls internal` is added to the guide's Caddyfile,
# and every HTTPS check is made against Caddy's own local root certificate.
#
# It never touches a real server. It talks to Docker on this computer and, from
# inside its containers, to the package mirrors the guide names (Debian, Caddy,
# rustup, crates.io). Passwords and the backup key are made inside the containers
# at run time, are never printed, and go away with the containers.
#
# What it creates, all named qoop-rehearsal…:
#   containers  qoop-rehearsal ("the VPS"), qoop-rehearsal-laptop, qoop-rehearsal-build
#   volume      qoop-rehearsal-cargo   (Rust toolchain, crates, build output)
#   image       debian:bookworm        (pulled if this Docker does not have it)
# What it leaves behind: the volume, so that the next run does not build everything
# again, and nothing else. `--clean` removes the volume too. With `--keep` the "VPS"
# container stays up for inspection until the next run or `--clean`.
#
# Usage: scripts/rehearse-deploy.sh [--keep] [--build-in-memory] [--clean]
#   --keep             leave the "VPS" container running; the script says how to look inside
#   --build-in-memory  keep the build's intermediate files in memory, not in the volume
#                      (for a nearly full disk; a changed server is then built from scratch)
#   --clean            remove everything a rehearsal left (containers and the volume), then stop
#
# Needs: Docker, and Node/npm only if web/dist is missing or older than web/src.
# Exit status: 0 when every check passed, 1 otherwise.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
MACHINE=qoop-rehearsal
LAPTOP=qoop-rehearsal-laptop
BUILDER=qoop-rehearsal-build
VOLUME=qoop-rehearsal-cargo
IMAGE=debian:bookworm
# Free space below which a build into the volume is not started (KiB).
MIN_FREE_KB=$((2500 * 1024))

KEEP=0
CLEAN=0
IN_MEMORY=0
for arg in "$@"; do
	case "$arg" in
	--keep) KEEP=1 ;;
	--clean) CLEAN=1 ;;
	--build-in-memory) IN_MEMORY=1 ;;
	-h | --help)
		awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
		exit 0
		;;
	*)
		echo "rehearse-deploy: unknown option: $arg (see --help)" >&2
		exit 2
		;;
	esac
done

say() { printf '\n== %s\n' "$*"; }
die() {
	echo "rehearse-deploy: $*" >&2
	exit 1
}

command -v docker >/dev/null 2>&1 || die "docker is not installed"
docker info >/dev/null 2>&1 || die "docker is not running"

remove_containers() {
	for c in "$MACHINE" "$LAPTOP" "$BUILDER"; do
		docker rm -f "$c" >/dev/null 2>&1 || true
	done
}

if [ "$CLEAN" = 1 ]; then
	remove_containers
	docker volume rm "$VOLUME" >/dev/null 2>&1 || true
	echo "Removed the rehearsal's containers and the volume $VOLUME."
	exit 0
fi

PULLED_IMAGE=0
finish() {
	code=$?
	trap - EXIT
	docker rm -f "$BUILDER" "$LAPTOP" >/dev/null 2>&1 || true
	if [ "$KEEP" = 1 ] && docker inspect "$MACHINE" >/dev/null 2>&1; then
		printf '\nKept the container %s. Look inside with:\n  docker exec -it %s bash\n' "$MACHINE" "$MACHINE"
		printf 'The rehearsal'"'"'s own files (results, the two passwords) are in /root/rehearsal there.\n'
		printf 'Remove it with: scripts/rehearse-deploy.sh --clean   (or: docker rm -f %s)\n' "$MACHINE"
	else
		docker rm -f "$MACHINE" >/dev/null 2>&1 || true
		if [ "$PULLED_IMAGE" = 1 ]; then
			docker image rm "$IMAGE" >/dev/null 2>&1 || true
		fi
	fi
	exit "$code"
}
trap finish EXIT
trap 'exit 130' INT TERM

# Runs a script given on standard input as root on "the VPS".
in_machine() {
	docker exec -i "$@" "$MACHINE" bash -s
}
in_laptop() {
	docker exec -i "$@" "$LAPTOP" bash -s
}

sha256_of_stdin() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi
}

# ---------------------------------------------------------------------------
# The outputs: web UI (built here) and the server binary (built for Linux).
# ---------------------------------------------------------------------------

build_web() {
	say "Web UI"
	local index="$REPO/web/dist/index.html"
	if [ -f "$index" ] && [ -z "$(find "$REPO/web/src" "$REPO/web/index.html" "$REPO/web/package.json" -newer "$index" -print 2>/dev/null | head -n 1)" ]; then
		echo "web/dist is current."
		return 0
	fi
	command -v npm >/dev/null 2>&1 || die "web/dist is missing or old, and npm is not installed"
	echo "web/dist is missing or older than web/src: building it."
	local out
	if [ ! -d "$REPO/web/node_modules" ]; then
		out="$(npm --prefix "$REPO/web" ci 2>&1)" || {
			printf '%s\n' "$out" >&2
			die "npm ci failed in web/"
		}
	fi
	out="$(npm --prefix "$REPO/web" run build 2>&1)" || {
		printf '%s\n' "$out" >&2
		die "the web build failed"
	}
}

# One line that changes whenever the server's sources do.
source_stamp() {
	(cd "$REPO" && find Cargo.toml Cargo.lock crates -type f -print0 | LC_ALL=C sort -z | xargs -0 cat | sha256_of_stdin | cut -d' ' -f1)
}

build_server() {
	say "Server binary for Linux (guide 3a, in a throwaway container)"
	docker volume create "$VOLUME" >/dev/null
	local stamp
	stamp="$(source_stamp)"
	if docker run --rm -v "$VOLUME":/cargo -e STAMP="$stamp" "$IMAGE" \
		sh -c '[ -x /cargo/out/qoop-server ] && [ "$(cat /cargo/out/stamp 2>/dev/null)" = "$STAMP" ]'; then
		echo "The binary in $VOLUME was built from these sources; using it."
		return 0
	fi

	local target_args
	if [ "$IN_MEMORY" = 1 ]; then
		# Intermediate files in memory. The limit keeps a build that runs out of
		# memory from hurting other containers: it is this one that gets stopped.
		target_args=(--tmpfs /ramtarget:exec,size=1500m -e CARGO_TARGET_DIR=/ramtarget --memory 2800m)
	else
		local free_kb
		free_kb="$(df -Pk "$REPO" | awk 'NR==2 { print $4 }')"
		if [ "$free_kb" -lt "$MIN_FREE_KB" ]; then
			die "less than 2.5 GB free here; the build needs about 1.5 GB. Free some space or use --build-in-memory."
		fi
		target_args=(-e CARGO_TARGET_DIR=/cargo/target)
	fi

	# Guide 3a, with two differences that only save space and time: rustup's
	# "minimal" profile (no documentation), and --locked.
	docker run --rm --name "$BUILDER" -v "$VOLUME":/cargo -v "$REPO":/src:ro "${target_args[@]}" \
		-e STAMP="$stamp" -e CARGO_HOME=/cargo/home -e RUSTUP_HOME=/cargo/rustup \
		-e CARGO_INCREMENTAL=0 -e DEBIAN_FRONTEND=noninteractive "$IMAGE" sh -euc '
			apt-get update -qq
			apt-get install -y -qq build-essential pkg-config git curl >/dev/null 2>&1
			if [ ! -x /cargo/home/bin/cargo ]; then
				curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs |
					sh -s -- -y --profile minimal --no-modify-path
			fi
			. /cargo/home/env
			cd /src
			cargo build --release --locked -p qoop-server
			mkdir -p /cargo/out
			cp "$CARGO_TARGET_DIR/release/qoop-server" /cargo/out/qoop-server
			printf "%s" "$STAMP" >/cargo/out/stamp
		'
}

# ---------------------------------------------------------------------------
# "The VPS": a clean Debian 12 with systemd as its first process.
# ---------------------------------------------------------------------------

wait_for_boot() {
	local state
	for _ in $(seq 1 120); do
		if [ "$(docker inspect -f '{{.State.Running}}' "$MACHINE" 2>/dev/null)" != true ]; then
			docker logs "$MACHINE" 2>&1 | tail -n 20 >&2
			die "the container stopped while starting"
		fi
		state="$(docker exec "$MACHINE" systemctl is-system-running 2>/dev/null || true)"
		case "$state" in
		# "degraded" is what a container without a console gives (getty fails).
		running | degraded) return 0 ;;
		esac
		sleep 2
	done
	die "systemd did not come up in the container"
}

start_machine() {
	say "A clean Debian 12 with systemd"
	# What a fresh Debian server has and the Docker image lacks: systemd itself,
	# sudo, and the right to start services when a package is installed.
	# systemd needs --privileged here to set up the sandbox the units ask for.
	docker run -d --name "$MACHINE" --hostname "$MACHINE" --privileged --cgroupns=private \
		--tmpfs /run --tmpfs /run/lock --add-host qoop.test:127.0.0.1 \
		--stop-signal SIGRTMIN+3 "$IMAGE" sh -c '
			if [ ! -x /sbin/init ]; then
				export DEBIAN_FRONTEND=noninteractive
				apt-get update -qq &&
					apt-get install -y -qq --no-install-recommends systemd systemd-sysv dbus sudo ca-certificates >/dev/null ||
					exit 1
				rm -f /usr/sbin/policy-rc.d
			fi
			exec /sbin/init
		' >/dev/null
	wait_for_boot
	docker exec "$MACHINE" sh -c '. /etc/os-release && echo "$PRETTY_NAME, systemd $(systemctl --version | head -n 1 | cut -d" " -f2)"'

	# The rehearsal's own helpers and notes live in /root/rehearsal.
	docker exec "$MACHINE" install -d -m 700 /root/rehearsal
	docker exec -i "$MACHINE" sh -c 'cat >/root/rehearsal/lib.sh' <<'LIB'
# Helpers for the rehearsal's scripts on "the VPS". Sourced, not executed.
R=/root/rehearsal
ORIGIN=https://qoop.test
CA=/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt

ok() { printf 'ok    %s\n' "$1" >>"$R/results"; }
fail() { printf 'FAIL  %s\n' "$1" >>"$R/results"; }
note() { printf 'note  %s\n' "$1" >>"$R/results"; }
# check "what" command…  — passes when the command succeeds.
check() {
	local what="$1"
	shift
	if "$@" >/dev/null 2>&1; then ok "$what"; else fail "$what"; fi
}
is() { [ "$1" = "$2" ]; }

# following_guide: from here on, a command that fails ends the script, and the
# results say at which step of the guide. checking: from here on, nothing ends it.
STEP='(start)'
following_guide() {
	set -eE
	trap 'fail "the guide did not work as written at: $STEP"' ERR
}
checking() {
	set +eE
	trap - ERR
}

owner_mode() { stat -c '%U:%G %a' "$1"; }

# api <cookie jar> <method> <path> [file with the JSON body]
# Leaves the status in $STATUS and the response body in $R/body.
# It sends what the page sends: the Origin and the X-Qoop-Request header.
api() {
	local jar="$1" method="$2" path="$3" body="${4:-}"
	set -- -sS --cacert "$CA" -b "$jar" -c "$jar" -X "$method" -o "$R/body" -w '%{http_code}' \
		-H "Origin: $ORIGIN" -H 'X-Qoop-Request: 1' -H 'Expect:'
	if [ -n "$body" ]; then
		set -- "$@" -H 'Content-Type: application/json' --data-binary "@$body"
	fi
	: >"$R/body"
	STATUS="$(curl ${CURL_EXTRA:-} "$@" "$ORIGIN$path" 2>"$R/curl-error")" || true
}

# login <cookie jar> <email> <file holding the password>
login() {
	printf '{"email":"%s","password":"%s"}' "$2" "$(cat "$3")" >"$R/login.json"
	api "$1" POST /api/auth/login "$R/login.json"
	: >"$R/login.json"
}

new_password() { head -c 18 /dev/urandom | base64 | tr '+/' 'xy'; }
new_id() { cat /proc/sys/kernel/random/uuid; }
# The last "id" in the response body.
body_id() { sed -n 's/.*"id":"\([0-9a-f-]\{36\}\)".*/\1/p' "$R/body" | head -n 1; }
body_has() { grep -qF -- "$1" "$R/body"; }
health_ok() { [ "$(curl -fsS --cacert "$CA" "$ORIGIN/api/health" 2>/dev/null)" = '{"ok":true}' ]; }
wait_for_health() {
	for _ in $(seq 1 30); do
		if health_ok; then return 0; fi
		sleep 1
	done
	return 1
}
LIB
}

copy_outputs() {
	say "Copy the outputs to the machine (guide 3b)"
	# scp target/release/qoop-server …:/tmp/   ·   scp -r web/dist …:/tmp/qoop-web
	# scp -r deploy …:/tmp/qoop-deploy
	docker run --rm -v "$VOLUME":/cargo "$IMAGE" cat /cargo/out/qoop-server |
		docker exec -i "$MACHINE" sh -c 'cat >/tmp/qoop-server'
	docker cp "$REPO/web/dist" "$MACHINE":/tmp/qoop-web >/dev/null
	docker cp "$REPO/deploy" "$MACHINE":/tmp/qoop-deploy >/dev/null
}

# ---------------------------------------------------------------------------
# Guide steps 2 to 6: from an empty machine to a running server behind Caddy.
# ---------------------------------------------------------------------------

follow_guide() {
	say "Guide steps 2 to 6"
	in_machine <<'EOF'
. /root/rehearsal/lib.sh
set -uo pipefail
following_guide

STEP='2. Create the service user and directories'
sudo adduser --system --group --no-create-home --home /nonexistent qoop >/dev/null 2>&1
sudo install -d -o root -g root -m 755 /opt/qoop /opt/qoop/web
sudo install -d -o qoop -g qoop -m 700 /var/lib/qoop
sudo install -d -o qoop -g qoop -m 700 /var/backups/qoop
sudo install -d -o root -g qoop -m 750 /etc/qoop

STEP='3. Install the outputs'
sudo install -o root -g root -m 755 /tmp/qoop-server /opt/qoop/qoop-server
sudo cp -r /tmp/qoop-web/. /opt/qoop/web/
sudo chown -R root:root /opt/qoop/web

STEP='4. Configuration and the systemd service'
cd /tmp/qoop-deploy
sudo install -o root -g qoop -m 640 qoop.env.example /etc/qoop/qoop.env
# "sudoedit /etc/qoop/qoop.env": set QOOP_PUBLIC_ORIGIN.
sudo sed -i 's|^QOOP_PUBLIC_ORIGIN=.*|QOOP_PUBLIC_ORIGIN=https://qoop.test|' /etc/qoop/qoop.env
sudo install -o root -g root -m 644 qoop.service /etc/systemd/system/qoop.service
sudo systemctl daemon-reload
sudo systemctl enable qoop 2>/dev/null

STEP='5. Create the first Admin'
# The guide types the password at a prompt. Nobody is here to type, so the
# rehearsal makes one now and hands it over in the environment of this one
# command: never as an argument, never in a file the server reads.
new_password >"$R/admin-password"
QOOP_ADMIN_PASSWORD="$(cat "$R/admin-password")"
export QOOP_ADMIN_PASSWORD
sudo --preserve-env=QOOP_ADMIN_PASSWORD -u qoop env QOOP_DB=/var/lib/qoop/qoop.db \
	/opt/qoop/qoop-server create-admin --email admin@qoop.test --name "Rehearsal Admin"
unset QOOP_ADMIN_PASSWORD
sudo chmod 600 /var/lib/qoop/qoop.db

STEP='6. Install Caddy and start everything'
{
	sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
		sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' |
		sudo tee /etc/apt/sources.list.d/caddy-stable.list
	sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
	sudo apt-get update
	sudo apt-get install -y caddy
} >>"$R/apt.log" 2>&1
# The guide's Caddyfile with the rehearsal's name, plus the one allowed line.
sed 's/qoop\.example\.org/qoop.test/g' Caddyfile | sed '/^qoop\.test {$/a\	tls internal' |
	sudo tee /etc/caddy/Caddyfile >/dev/null
sudo caddy validate --config /etc/caddy/Caddyfile >>"$R/apt.log" 2>&1
sudo systemctl start qoop
sudo systemctl reload caddy

STEP='waiting for the first HTTPS answer'
for _ in $(seq 1 30); do
	if [ -s "$CA" ]; then break; fi
	sleep 1
done
wait_for_health
EOF
}

# ---------------------------------------------------------------------------
# Guide step 8 and the contract's list: is what the guide promises true?
# ---------------------------------------------------------------------------

check_deployment() {
	say "Checks: service, HTTPS, headers, rights, sandbox"
	in_machine <<'EOF'
. /root/rehearsal/lib.sh
set -uo pipefail

check 'qoop.service is active' is "$(systemctl is-active qoop)" active
check 'qoop.service is enabled (starts with the machine)' is "$(systemctl is-enabled qoop)" enabled
PID="$(systemctl show -p MainPID --value qoop)"
check 'the server runs under the account qoop' is "$(stat -c '%U:%G' "/proc/$PID")" qoop:qoop
check 'caddy.service is active' is "$(systemctl is-active caddy)" active

check '/api/health over HTTPS answers {"ok":true}' health_ok

curl -sS -I --cacert "$CA" "$ORIGIN/" 2>/dev/null | tr -d '\r' | tr 'A-Z' 'a-z' >"$R/head"
check 'the page answers HTTP/2 200' grep -qx 'http/2 200 *' "$R/head"
check 'header: strict-transport-security (a year, from Caddy)' grep -q '^strict-transport-security: max-age=31536000' "$R/head"
check 'header: x-content-type-options: nosniff' grep -qx 'x-content-type-options: nosniff' "$R/head"
check 'header: referrer-policy: same-origin' grep -qx 'referrer-policy: same-origin' "$R/head"
check "header: content-security-policy on the page" grep -q "^content-security-policy: default-src 'self'" "$R/head"

curl -sS -I "http://qoop.test/" 2>/dev/null | tr -d '\r' | tr 'A-Z' 'a-z' >"$R/head"
redirects() { grep -q '^http/1.1 30[18]' "$R/head" && grep -qx 'location: https://qoop.test/' "$R/head"; }
check 'plain HTTP is redirected to https://' redirects

check '/var/lib/qoop is qoop:qoop, mode 700' is "$(owner_mode /var/lib/qoop)" 'qoop:qoop 700'
check 'the database file is qoop:qoop, mode 600' is "$(owner_mode /var/lib/qoop/qoop.db)" 'qoop:qoop 600'
others_cannot_read() {
	local f
	for f in /var/lib/qoop/qoop.db*; do
		case "$(stat -c '%a' "$f")" in 600) ;; *) return 1 ;; esac
	done
}
check 'the database companions (-wal, -shm) are mode 600 too' others_cannot_read
check '/etc/qoop/qoop.env is root:qoop, mode 640' is "$(owner_mode /etc/qoop/qoop.env)" 'root:qoop 640'
check '/etc/qoop is root:qoop, mode 750' is "$(owner_mode /etc/qoop)" 'root:qoop 750'
check '/opt/qoop is root:root, mode 755' is "$(owner_mode /opt/qoop)" 'root:root 755'
check '/opt/qoop/qoop-server is root:root, mode 755' is "$(owner_mode /opt/qoop/qoop-server)" 'root:root 755'
nothing_of_qoop() { [ -z "$(find /opt/qoop \( ! -user root -o ! -group root -o -perm /022 \) -print | head -n 1)" ]; }
check 'nothing under /opt/qoop belongs to, or is writable by, anyone but root' nothing_of_qoop
check '/var/backups/qoop is qoop:qoop, mode 700' is "$(owner_mode /var/backups/qoop)" 'qoop:qoop 700'

# The sandbox the unit declares, read from the running process.
status_has() { grep -Eq "^$1:[[:space:]]*$2\$" "/proc/$PID/status"; }
check 'sandbox: the server can gain no new privileges (NoNewPrivileges)' status_has NoNewPrivs 1
check 'sandbox: the system call filter is on (SystemCallFilter)' status_has Seccomp 2
check 'sandbox: the server holds no capabilities (CapabilityBoundingSet)' status_has CapBnd 0000000000000000
mount_options() { awk -v at="$1" '$5 == at { print $6 }' "/proc/$PID/mountinfo" | tail -n 1; }
root_read_only() { case "$(mount_options /)" in ro | ro,*) return 0 ;; *) return 1 ;; esac; }
data_writable() { case "$(mount_options /var/lib/qoop)" in rw | rw,*) return 0 ;; *) return 1 ;; esac; }
check 'sandbox: the server sees the system read-only (ProtectSystem=strict)' root_read_only
check 'sandbox: the server can write to /var/lib/qoop' data_writable
own_namespace() { [ "$(readlink "/proc/$PID/ns/mnt")" != "$(readlink /proc/1/ns/mnt)" ]; }
check 'sandbox: the server has its own view of the file system' own_namespace

# Loopback only: the machine's own address must not answer on the server's port.
ADDRESS="$(hostname -I | cut -d' ' -f1)"
not_reachable() { ! curl -s -m 3 -o /dev/null "http://$ADDRESS:8787/api/health"; }
check "the server listens on 127.0.0.1 only (not on $ADDRESS:8787)" not_reachable

sudo systemctl restart qoop
back() { wait_for_health && [ "$(systemctl is-active qoop)" = active ]; }
check 'after "systemctl restart qoop" the server is active and healthy again' back
check 'the journal of qoop.service has no error lines' sh -c '! journalctl -q -u qoop --no-pager -p err | grep -q .'
note "systemd-analyze security qoop:$(systemd-analyze security qoop --no-pager 2>/dev/null | tail -n 1 | sed 's/.*qoop.service://; s/ [^ ]*$//')"
exit 0
EOF
}

# ---------------------------------------------------------------------------
# The first day (docs/first-day.md), through the API the page uses.
# ---------------------------------------------------------------------------

first_day() {
	say "The first day: invite, accept once, sign in, a Card"
	in_machine <<'EOF'
. /root/rehearsal/lib.sh
set -uo pipefail

login "$R/admin.jar" admin@qoop.test "$R/admin-password"
check 'the Admin signs in' is "$STATUS" 200
body_id >"$R/admin-id"

printf '{"email":"member@qoop.test","role":"member"}' >"$R/req"
api "$R/admin.jar" POST /api/invites "$R/req"
check 'the Admin creates an invite for a Member' is "$STATUS" 200
check 'the invite link starts with the public address' body_has '"url":"https://qoop.test/invite/'
sed -n 's|.*"url":"https://qoop.test/invite/\([^"]*\)".*|\1|p' "$R/body" >"$R/invite-token"
TOKEN="$(cat "$R/invite-token")"

api "$R/nobody.jar" GET "/api/invites/lookup?token=$TOKEN"
opens() { [ "$STATUS" = 200 ] && body_has '"email":"member@qoop.test"' && body_has '"role":"member"'; }
check 'the invite link opens: it names the email and the role' opens

new_password >"$R/member-password"
printf '{"token":"%s","name":"Rehearsal Member","password":"%s"}' "$TOKEN" "$(cat "$R/member-password")" >"$R/accept.json"
api "$R/invited.jar" POST /api/auth/accept-invite "$R/accept.json"
check 'the invite is accepted' is "$STATUS" 200
body_id >"$R/member-id"
api "$R/invited.jar" GET /api/me
signed_in_as_member() { [ "$STATUS" = 200 ] && body_has '"role":"member"'; }
check 'accepting signs the new Member in' signed_in_as_member

api "$R/second.jar" POST /api/auth/accept-invite "$R/accept.json"
check 'a second use of the same invite is refused (410)' is "$STATUS" 410
api "$R/second.jar" GET /api/me
check 'the refused second use signed nobody in' is "$STATUS" 401
: >"$R/accept.json"
api "$R/nobody.jar" GET "/api/invites/lookup?token=$TOKEN"
check 'the used invite link no longer opens (410)' is "$STATUS" 410

login "$R/member.jar" member@qoop.test "$R/member-password"
check 'the new Member signs in with their own password' is "$STATUS" 200

api "$R/member.jar" GET /api/branches
body_id >"$R/branch-id"
BRANCH="$(cat "$R/branch-id")"
new_id >"$R/member-card-id"
printf '{"ops":[{"Create":{"entity":"%s","kind":"Card","fields":{"title":{"Text":"First Card of the new Member"},"status":{"Text":"idea"},"x":{"Float":0},"y":{"Float":0}}}}]}' \
	"$(cat "$R/member-card-id")" >"$R/req"
api "$R/member.jar" POST "/api/branches/$BRANCH/ops" "$R/req"
check 'the new Member creates a Card' is "$STATUS" 200

api "$R/admin.jar" GET "/api/branches/$BRANCH/board"
sees_card() { [ "$STATUS" = 200 ] && body_has "$(cat "$R/member-card-id")" && body_has 'First Card of the new Member'; }
check 'the Admin sees that Card on the Board' sees_card
api "$R/admin.jar" GET "/api/branches/$BRANCH/changes?after=0"
by_member() { [ "$STATUS" = 200 ] && body_has "\"author\":\"$(cat "$R/member-id")\""; }
check 'the Change is recorded under the new Member' by_member
api "$R/admin.jar" GET /api/members
check 'the Admin sees the new Member in the list' body_has '"email":"member@qoop.test"'
exit 0
EOF
}

# ---------------------------------------------------------------------------
# Request body limits: Caddy's and the server's must agree (api.md §15).
# Also makes the content the backup has to bring back: a Card with a Page block.
# ---------------------------------------------------------------------------

body_limits() {
	say "Content for the backup, and the request body limits"
	in_machine <<'EOF'
. /root/rehearsal/lib.sh
set -uo pipefail

BRANCH="$(cat "$R/branch-id")"
ADMIN="$(cat "$R/admin-id")"
new_id >"$R/card-id"
new_id >"$R/block-id"
CARD="$(cat "$R/card-id")"
RUNS="$(new_id) $(new_id) $(new_id) $(new_id)"

# A Card, a text block on its Page, and four Runs.
{
	printf '{"ops":[{"Create":{"entity":"%s","kind":"Card","fields":{"title":{"Text":"Card made before the backup"},"status":{"Text":"reading"},"x":{"Float":320},"y":{"Float":0}}}}' "$CARD"
	printf ',{"Create":{"entity":"%s","kind":"Block","fields":{"card":{"Ref":"%s"},"type":{"Text":"text"},"text":{"Text":"Page block written before the backup."},"order":{"Text":"a"}}}}' "$(cat "$R/block-id")" "$CARD"
	n=0
	for run in $RUNS; do
		n=$((n + 1))
		printf ',{"Create":{"entity":"%s","kind":"Block","fields":{"card":{"Ref":"%s"},"type":{"Text":"run"},"title":{"Text":"Run %s"},"text":{"Text":"print(1)"},"order":{"Text":"b%s"}}}}' "$run" "$CARD" "$n" "$n"
	done
	printf ']}'
} >"$R/req"
api "$R/admin.jar" POST "/api/branches/$BRANCH/ops" "$R/req"
check 'the Admin creates a Card with a Page block and four Runs' is "$STATUS" 200

# The largest result a Run may record (api.md §15): 64 000 characters of output and
# three figures of 160 000 base64 characters each, written as the Runner writes it.
figure() { { printf '\211PNG\r\n\032\n'; head -c 119992 /dev/zero; } | base64 -w0; }
{
	printf '{"v":1,"by":"%s","at":%s000,"code_sha256":"%s","exit":0,"duration_ms":1200,"output":"' \
		"$ADMIN" "$(date +%s)" "$(printf 'print(1)' | sha256sum | cut -d' ' -f1)"
	head -c 64000 /dev/zero | tr '\0' 'o'
	printf '","figures":[{"png":"'
	figure
	printf '"},{"png":"'
	figure
	printf '"},{"png":"'
	figure
	printf '"}]}'
} >"$R/result"
# The result is one text value inside the request's JSON: escape its quotes.
sed 's/"/\\"/g' "$R/result" >"$R/result.escaped"

# results <how many>: one request that records that many Runs' results.
results() {
	local wanted="$1" n=0 run
	printf '{"ops":['
	for run in $RUNS; do
		n=$((n + 1))
		[ "$n" -le "$wanted" ] || break
		[ "$n" -eq 1 ] || printf ','
		printf '{"Set":{"entity":"%s","field":"result","value":{"Text":"' "$run"
		cat "$R/result.escaped"
		printf '"}}}'
	done
	printf ']}'
}
MIB=1048576

results 3 >"$R/req"
SIZE="$(stat -c %s "$R/req")"
fits() { [ "$SIZE" -gt "$MIB" ] && [ "$SIZE" -le $((2 * MIB)) ] && [ "$STATUS" = 200 ]; }
api "$R/admin.jar" POST "/api/branches/$BRANCH/ops" "$R/req"
check "three full Run results in one request ($SIZE bytes: over 1 MiB, under 2 MiB) pass Caddy and are accepted" fits
api "$R/admin.jar" GET "/api/branches/$BRANCH/board"
stored() { [ "$STATUS" = 200 ] && [ "$(stat -c %s "$R/body")" -gt 1500000 ]; }
check 'the Board gives those results back' stored

results 4 >"$R/req"
SIZE="$(stat -c %s "$R/req")"
too_big() { [ "$SIZE" -gt $((2 * MIB)) ] && [ "$STATUS" = 413 ]; }
CURL_EXTRA=--http1.1 api "$R/admin.jar" POST "/api/branches/$BRANCH/ops" "$R/req"
check "a request of $SIZE bytes (over 2 MiB) to the same route is refused (413)" too_big
# Over HTTP/2 Caddy answers 413 and closes the stream without reading the rest;
# this curl (7.88) reports that as a stream error instead of the status.
api "$R/admin.jar" POST "/api/branches/$BRANCH/ops" "$R/req"
refused_h2() { [ "$STATUS" = 413 ] || { [ "$STATUS" = 000 ] && grep -q 'HTTP/2' "$R/curl-error"; }; }
check 'the same over HTTP/2 does not get through either (413, or the stream is closed)' refused_h2

# Every other route keeps 1 MiB: the three-result request is too big for them.
results 3 >"$R/req"
SIZE="$(stat -c %s "$R/req")"
CURL_EXTRA=--http1.1 api "$R/admin.jar" POST /api/todos "$R/req"
check "a request of $SIZE bytes to another route is refused (413)" is "$STATUS" 413

# The limits are the server's own: asked directly, without Caddy, it refuses the
# same requests (with 400 "The request body is too large.").
# (The cookie is marked Secure, so curl would not send it over plain HTTP by itself.)
awk '$6 == "qoop_session" { print "Cookie: qoop_session=" $7 }' "$R/admin.jar" >"$R/cookie-header"
direct() {
	curl -sS -o "$R/body" -w '%{http_code}' -X POST -H "@$R/cookie-header" -H "Origin: $ORIGIN" -H 'X-Qoop-Request: 1' \
		-H 'Content-Type: application/json' -H 'Expect:' --data-binary "@$2" "http://127.0.0.1:8787$1" 2>/dev/null
}
printf '{"owner":"%s","text":"asked directly"}' "$ADMIN" >"$R/small"
check 'asked directly, the server accepts a small request (so the next two answers are about size)' is "$(direct /api/todos "$R/small")" 200
too_large() { [ "$(direct "$1" "$R/req")" = 400 ] && body_has 'The request body is too large.'; }
check 'asked directly, the server refuses that request on another route as too large' too_large /api/todos
results 4 >"$R/req"
check 'asked directly, the server refuses the over-2-MiB request as too large' too_large "/api/branches/$BRANCH/ops"
results 3 >"$R/req"
check 'asked directly, the server accepts the three results on their own route' is "$(direct "/api/branches/$BRANCH/ops" "$R/req")" 200
: >"$R/req"
exit 0
EOF
}

# ---------------------------------------------------------------------------
# Guide step 9: backups, then "Test a restore" A and B.
# ---------------------------------------------------------------------------

# Guide, Test a restore, A: prints "ok" when the file decrypts and is a sound database.
check_backup_on_laptop() {
	in_laptop -e NAME="$1" <<'EOF'
set -euo pipefail
cd /root/laptop
age -d -i qoop-backup-key.txt "$NAME" | gunzip >restored.db
sqlite3 restored.db 'PRAGMA integrity_check;'
EOF
}

backup_and_restore() {
	say "Backup key on \"your laptop\" (guide 9.1)"
	docker run -d --name "$LAPTOP" --hostname "$LAPTOP" "$IMAGE" sleep infinity >/dev/null
	in_laptop <<'EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq age sqlite3 >/dev/null 2>&1
install -d -m 700 /root/laptop
cd /root/laptop
umask 077
age-keygen -o qoop-backup-key.txt 2>/dev/null
EOF
	local recipient
	recipient="$(docker exec "$LAPTOP" age-keygen -y /root/laptop/qoop-backup-key.txt)"

	say "Backup with the guide's unit (guide 9.2)"
	in_machine -e AGE_RECIPIENT="$recipient" <<'EOF'
. /root/rehearsal/lib.sh
set -uo pipefail
following_guide

STEP='9.2 Backups on the VPS'
cd /tmp/qoop-deploy
sudo apt-get install -y sqlite3 age >>"$R/apt.log" 2>&1
sudo install -o root -g root -m 755 backup.sh /opt/qoop/backup.sh
sudo install -o root -g root -m 644 qoop-backup.service qoop-backup.timer /etc/systemd/system/
# "sudoedit /etc/qoop/qoop.env": set QOOP_BACKUP_AGE_RECIPIENT.
sudo sed -i "s|^QOOP_BACKUP_AGE_RECIPIENT=.*|QOOP_BACKUP_AGE_RECIPIENT=$AGE_RECIPIENT|" /etc/qoop/qoop.env
sudo systemctl daemon-reload
sudo systemctl enable --now qoop-backup.timer 2>/dev/null
sudo systemctl start qoop-backup.service
checking

check '/etc/qoop/qoop.env is still root:qoop, mode 640 after editing' is "$(owner_mode /etc/qoop/qoop.env)" 'root:qoop 640'
check 'qoop-backup.timer is enabled' is "$(systemctl is-enabled qoop-backup.timer)" enabled
check 'qoop-backup.timer is waiting for its next time' is "$(systemctl is-active qoop-backup.timer)" active
check 'qoop-backup.service ran and succeeded' is "$(systemctl show -p Result --value qoop-backup.service)" success
note "systemd-analyze security qoop-backup:$(systemd-analyze security qoop-backup --no-pager 2>/dev/null | tail -n 1 | sed 's/.*qoop-backup.service://; s/ [^ ]*$//')"
check 'its journal says which file it wrote' sh -c 'journalctl -u qoop-backup --no-pager | grep -q "qoop-backup: wrote /var/backups/qoop/qoop-"'
ls /var/backups/qoop/qoop-*.db.gz.age 2>/dev/null | tail -n 1 >"$R/backup-file"
BACKUP="$(cat "$R/backup-file")"
check 'there is one backup file named qoop-<time>.db.gz.age' is "$(ls /var/backups/qoop | wc -l)" 1
check 'the backup file is qoop:qoop, mode 600' is "$(owner_mode "$BACKUP")" 'qoop:qoop 600'
check 'the backup file is age-encrypted' sh -c "head -c 21 '$BACKUP' | grep -q '^age-encryption.org/v1'"
check 'the backup left no temporary files behind' sh -c '[ -z "$(find /var/backups/qoop -name ".tmp.*" -print)" ]'
check 'no private key is on the machine' sh -c '! grep -rqs "AGE-SECRET-KEY" /etc/qoop /opt/qoop /var/backups/qoop /root /tmp'
check 'the server stayed up during the backup' health_ok

# Something made after the backup: a restore must not bring it back.
new_id >"$R/late-card-id"
printf '{"ops":[{"Create":{"entity":"%s","kind":"Card","fields":{"title":{"Text":"Card made after the backup"},"x":{"Float":640},"y":{"Float":0}}}}]}' \
	"$(cat "$R/late-card-id")" >"$R/req"
api "$R/admin.jar" POST "/api/branches/$(cat "$R/branch-id")/ops" "$R/req"
check 'a Card is made after the backup' is "$STATUS" 200
exit 0
EOF

	say "A. Check the backup on \"your laptop\" (guide: Test a restore, A)"
	local backup name
	backup="$(docker exec "$MACHINE" cat /root/rehearsal/backup-file)"
	name="$(basename "$backup")"
	# scp you@…:/var/backups/qoop/qoop-TIMESTAMP.db.gz.age .
	docker exec "$MACHINE" cat "$backup" | docker exec -i "$LAPTOP" sh -c "cat >/root/laptop/$name"
	local verdict
	verdict="$(check_backup_on_laptop "$name")" || verdict="failed"
	if [ "$verdict" = ok ]; then
		docker exec "$MACHINE" sh -c 'echo "ok    A: the backup decrypts on the laptop and passes the integrity check" >>/root/rehearsal/results'
	else
		docker exec "$MACHINE" sh -c 'echo "FAIL  A: the backup decrypts on the laptop and passes the integrity check" >>/root/rehearsal/results'
		return 1
	fi

	say "Destroy the database"
	in_machine <<'EOF'
. /root/rehearsal/lib.sh
set -uo pipefail
sudo systemctl stop qoop
sudo rm -f /var/lib/qoop/qoop.db-wal /var/lib/qoop/qoop.db-shm
# What is left is not a database any more: the same size of random bytes.
SIZE="$(stat -c %s /var/lib/qoop/qoop.db)"
head -c "$SIZE" /dev/urandom | sudo -u qoop tee /var/lib/qoop/qoop.db >/dev/null
sudo systemctl start qoop
sleep 3
down() { ! health_ok; }
check 'with the database destroyed the server does not answer' down
exit 0
EOF

	say "B. Restore onto the server (guide: Test a restore, B)"
	# scp restored.db you@…:/tmp/restored.db
	docker exec "$LAPTOP" cat /root/laptop/restored.db | docker exec -i "$MACHINE" sh -c 'cat >/tmp/restored.db'
	in_machine <<'EOF'
. /root/rehearsal/lib.sh
set -uo pipefail
following_guide

STEP='Test a restore, B'
sudo systemctl stop qoop
sudo mv /var/lib/qoop/qoop.db /var/lib/qoop/qoop.db.before-restore
sudo rm -f /var/lib/qoop/qoop.db-wal /var/lib/qoop/qoop.db-shm
sudo install -o qoop -g qoop -m 600 /tmp/restored.db /var/lib/qoop/qoop.db
sudo rm /tmp/restored.db
sudo systemctl start qoop
checking

back() { wait_for_health && [ "$(systemctl is-active qoop)" = active ]; }
check 'after the restore the server is active and healthy' back
check 'the restored database file is qoop:qoop, mode 600' is "$(owner_mode /var/lib/qoop/qoop.db)" 'qoop:qoop 600'

BRANCH="$(cat "$R/branch-id")"
login "$R/admin-after.jar" admin@qoop.test "$R/admin-password"
check 'the Admin signs in after the restore' is "$STATUS" 200
api "$R/admin-after.jar" GET "/api/branches/$BRANCH/board"
card_back() { [ "$STATUS" = 200 ] && body_has "$(cat "$R/card-id")" && body_has 'Card made before the backup'; }
block_back() { body_has "$(cat "$R/block-id")" && body_has 'Page block written before the backup.'; }
runs_back() { [ "$(stat -c %s "$R/body")" -gt 1500000 ]; }
late_gone() { ! body_has "$(cat "$R/late-card-id")"; }
check 'restored: the Card' card_back
check 'restored: its Page block' block_back
check 'restored: the Runs with their results' runs_back
check 'restored: the Card the Member made on the first day' body_has "$(cat "$R/member-card-id")"
check 'what was made after the backup is gone, as the guide says' late_gone
api "$R/admin-after.jar" GET /api/members
check 'restored: the second Member' body_has '"email":"member@qoop.test"'
login "$R/member-after.jar" member@qoop.test "$R/member-password"
check 'the second Member signs in after the restore' is "$STATUS" 200
exit 0
EOF
}

# ---------------------------------------------------------------------------
# The whole machine restarts: do Sheaf, Caddy and the backup timer come back?
# ---------------------------------------------------------------------------

restart_machine() {
	say "Restart the machine"
	docker restart -t 60 "$MACHINE" >/dev/null
	wait_for_boot
	in_machine <<'EOF'
. /root/rehearsal/lib.sh
set -uo pipefail
came_back() { wait_for_health && [ "$(systemctl is-active qoop)" = active ] && [ "$(systemctl is-active caddy)" = active ]; }
check 'after a restart of the machine Sheaf and Caddy start by themselves and answer' came_back
check 'after a restart of the machine the backup timer is waiting again' is "$(systemctl is-active qoop-backup.timer)" active
login "$R/admin-reboot.jar" admin@qoop.test "$R/admin-password"
check 'the Admin signs in after the restart of the machine' is "$STATUS" 200
exit 0
EOF
}

# ---------------------------------------------------------------------------

run_all() {
	follow_guide || return 1
	check_deployment || return 1
	first_day || return 1
	body_limits || return 1
	backup_and_restore || return 1
	restart_machine || return 1
}

say "Rehearsal of deploy/README.md — nothing outside Docker on this computer is touched"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
	docker pull -q "$IMAGE" >/dev/null
	PULLED_IMAGE=1
fi
remove_containers
build_web
build_server
start_machine
copy_outputs

COMPLETE=1
run_all || COMPLETE=0

say "What was checked"
RESULTS="$(docker exec "$MACHINE" cat /root/rehearsal/results 2>/dev/null || true)"
printf '%s\n' "$RESULTS"
PASSED="$(printf '%s\n' "$RESULTS" | grep -c '^ok ' || true)"
FAILED="$(printf '%s\n' "$RESULTS" | grep -c '^FAIL ' || true)"
printf '\n%s passed, %s failed, in %s min %s s.\n' "$PASSED" "$FAILED" "$((SECONDS / 60))" "$((SECONDS % 60))"
if [ "$COMPLETE" = 0 ]; then
	echo "The rehearsal stopped early: a step did not work as written (see the last FAIL line)."
	exit 1
fi
if [ "$FAILED" != 0 ] || [ "$PASSED" = 0 ]; then
	exit 1
fi
echo "Not checked here, because a rehearsal cannot: a real certificate, real DNS, the firewall and SSH steps of deploy/harden.md."
