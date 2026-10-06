#!/usr/bin/env bash
# ScrapSaver read-only public site on an offsite Linux server (docs/deploy-server.md).
# Run from the Mac, in the repo. The server shows recorded data only: READ_ONLY=1
# refuses every upload and edit, and Gemini, SAM 2.1 and the camera are never used.
#
#   deploy/server/deploy.sh setup       once: Node, SpacetimeDB 2.10.2, cloudflared, user `scrap`,
#                                       systemd units, firewall (SSH only), swap on small servers
#   deploy/server/deploy.sh sync-db     copy the Mac's SpacetimeDB (data + signing keys) to the server,
#                                       replacing its copy. The Mac's SpacetimeDB pauses ~10 s.
#   deploy/server/deploy.sh push [--env]  ship the committed HEAD, build it there and restart the site.
#                                       Writes /etc/scrapsaver/scrap.env the first time (or with --env).
#   deploy/server/deploy.sh tunnel      run the Cloudflare Tunnel (scrapsaver.app) on the server too
#   deploy/server/deploy.sh retire-mac  stop the Mac's tunnel connector, so only the server serves
#   deploy/server/deploy.sh status      services + health on the server and the public site
#   deploy/server/deploy.sh logs [unit] last 100 lines of scrap-api (or scrap-spacetimedb, cloudflared)
#
# Environment:
#   SCRAP_SERVER    required: ssh target, e.g. root@203.0.113.7 (root or a passwordless-sudo user;
#                   key-based ssh, no password prompt)
#   SCRAP_ENV_FILE  the Mac's secrets file (default <repo>/.env; values are never printed)
#   SERVER_R2_ACCESS_KEY_ID / SERVER_R2_SECRET_ACCESS_KEY
#                   optional: a read-only R2 token for the server instead of the Mac's read/write one
#   PUBLIC_URL      default https://scrapsaver.app
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$REPO/deploy/server"
RUN="$REPO/deploy/.run"
ENV_FILE="${SCRAP_ENV_FILE:-$REPO/.env}"
PUBLIC_URL="${PUBLIC_URL:-https://scrapsaver.app}"
STDB_VERSION=2.10.2
NODE_MAJOR=22
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)

say()  { printf '[server] %s\n' "$*"; }
warn() { printf '[server] WARNING: %s\n' "$*" >&2; }
die()  { printf '[server] ERROR: %s\n' "$*" >&2; exit 1; }

server() {
  [ -n "${SCRAP_SERVER:-}" ] || die "set SCRAP_SERVER=root@<server-ip> (see docs/deploy-server.md)"
  printf '%s' "$SCRAP_SERVER"
}
# Run a bash script (stdin) as root on the server; extra args become $1, $2, ...
remote() {
  local target args=""
  target="$(server)"
  for a in "$@"; do args+=" $(printf '%q' "$a")"; done
  # shellcheck disable=SC2029  # $args is quoted with %q here, on purpose
  ssh "${SSH_OPTS[@]}" "$target" "sudo -n bash -s --$args"
}
# Write stdin to a root-owned file on the server: remote_file <path> <owner:group> <mode>
remote_file() {
  # shellcheck disable=SC2029  # the command is built and %q-quoted here, on purpose
  ssh "${SSH_OPTS[@]}" "$(server)" "sudo -n bash -c $(printf '%q' "umask 077; cat > '$1.new' && chown '$2' '$1.new' && chmod '$3' '$1.new' && mv '$1.new' '$1'")"
}
rsync_to() { rsync -az --delete -e "ssh ${SSH_OPTS[*]}" --rsync-path="sudo -n rsync" "$@"; }
envval() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 || true; }

# ---------------------------------------------------------------- setup

cmd_setup() {
  say "installing on $(server) (Node $NODE_MAJOR, SpacetimeDB $STDB_VERSION, cloudflared)"
  tar -C "$HERE" -czf - scrap-spacetimedb.service scrap-api.service \
    | ssh "${SSH_OPTS[@]}" "$(server)" "sudo -n tar -xzf - -C /etc/systemd/system --no-same-owner"
  remote "$STDB_VERSION" "$NODE_MAJOR" <<'REMOTE'
set -euo pipefail
STDB_VERSION="$1"; NODE_MAJOR="$2"
export DEBIAN_FRONTEND=noninteractive
. /etc/os-release
case "$ID" in ubuntu|debian) ;; *) echo "needs Ubuntu or Debian (found $ID)" >&2; exit 1 ;; esac
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg rsync ufw tar gzip >/dev/null

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
if ! command -v cloudflared >/dev/null; then
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq && apt-get install -y -qq cloudflared >/dev/null
fi

id scrap >/dev/null 2>&1 || useradd --system --home-dir /var/lib/scrapsaver --create-home --shell /usr/sbin/nologin scrap
install -d -o scrap -g scrap -m 750 /var/lib/scrapsaver /var/lib/scrapsaver/stdb
install -d -o scrap -g scrap -m 700 /var/lib/scrapsaver/stdb/keys
install -d -o scrap -g scrap -m 755 /opt/scrapsaver /opt/scrapsaver/app
install -d -o root -g scrap -m 750 /etc/scrapsaver

SP=/var/lib/scrapsaver/.local/bin/spacetime
if [ ! -x "$SP" ]; then
  sudo -u scrap -H bash -c 'curl -sSf https://install.spacetimedb.com | sh -s -- --yes' >/dev/null
fi
[ -x "$SP" ] || { echo "spacetime not found at $SP after install" >&2; exit 1; }
sudo -u scrap -H "$SP" version list 2>/dev/null | grep -q "^$STDB_VERSION" \
  || sudo -u scrap -H "$SP" version install "$STDB_VERSION" --yes >/dev/null
sudo -u scrap -H "$SP" version use "$STDB_VERSION" >/dev/null

# Small servers: 2 GB of swap so npm/tsc/vite builds do not run out of memory.
if [ "$(swapon --show --noheadings | wc -l)" -eq 0 ] && [ "$(awk '/MemTotal/{print $2}' /proc/meminfo)" -lt 3500000 ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Only SSH is open: the site leaves through the Cloudflare Tunnel (outbound), everything binds 127.0.0.1.
SSH_PORT="$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')"
ufw allow "${SSH_PORT:-22}/tcp" >/dev/null
ufw --force enable >/dev/null

systemctl daemon-reload
systemctl enable scrap-spacetimedb scrap-api >/dev/null 2>&1
echo "node $(node --version), $(sudo -u scrap -H "$SP" --version 2>&1 | grep -o 'tool version [0-9.]*'), $(cloudflared --version | head -1)"
echo "firewall: $(ufw status | head -1); allowed ssh port ${SSH_PORT:-22}"
REMOTE
  say "setup done. Next: deploy/server/deploy.sh sync-db"
}

# ---------------------------------------------------------------- sync-db

cmd_sync_db() {
  local data="${SPACETIME_DATA:-$HOME/.local/share/spacetime/data}"
  local keys="${SPACETIME_KEYS:-$HOME/.config/spacetime}"
  local snap="$RUN/stdb-snapshot"
  [ -f "$data/metadata.toml" ] || die "no SpacetimeDB data at $data"
  [ -f "$keys/id_ecdsa" ] && [ -f "$keys/id_ecdsa.pub" ] || die "no signing keys at $keys/id_ecdsa(.pub)"
  grep -q "^version = \"$STDB_VERSION\"" "$data/metadata.toml" \
    || die "the Mac's data is not SpacetimeDB $STDB_VERSION ($(grep '^version' "$data/metadata.toml")); update STDB_VERSION here"
  mkdir -p "$RUN"

  # A consistent copy needs the Mac's SpacetimeDB stopped. Only one deploy/local.sh started is stopped.
  local pidfile="$RUN/spacetimedb.pid" pid="" restart=0
  if curl -sf -m 3 http://127.0.0.1:3000/v1/ping >/dev/null 2>&1; then
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o command= | grep -q spacetime; then
      say "pausing the Mac's SpacetimeDB (pid $pid) for a consistent copy"
      kill -TERM "$pid"
      for _ in $(seq 1 15); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
      kill -0 "$pid" 2>/dev/null && die "SpacetimeDB (pid $pid) did not stop; nothing was copied"
      restart=1
    else
      die "SpacetimeDB on :3000 was not started by deploy/local.sh; stop it (Ctrl-C) and run sync-db again"
    fi
  fi
  rsync -a --delete --exclude spacetime.pid --exclude logs/ --exclude cache/ "$data/" "$snap/"
  if [ "$restart" = 1 ]; then
    say "restarting the Mac's SpacetimeDB"
    (cd "$REPO" && SKIP_BUILD=1 deploy/local.sh up >/dev/null) || warn "deploy/local.sh up failed; run it yourself"
  fi

  say "uploading $(du -sh "$snap" | cut -f1) to $(server)"
  rsync_to "$snap/" "$(server):/var/lib/scrapsaver/stdb/incoming/"
  rsync_to "$keys/id_ecdsa" "$keys/id_ecdsa.pub" "$(server):/var/lib/scrapsaver/stdb/keys/"
  remote <<'REMOTE'
set -euo pipefail
cd /var/lib/scrapsaver/stdb
systemctl stop scrap-spacetimedb
rm -rf data.prev
[ -d data ] && mv data data.prev
cp -a incoming data
chown -R scrap:scrap /var/lib/scrapsaver/stdb
chmod 700 keys && chmod 600 keys/id_ecdsa && chmod 644 keys/id_ecdsa.pub
systemctl start scrap-spacetimedb
for _ in $(seq 1 60); do curl -sf -m 2 http://127.0.0.1:3000/v1/ping >/dev/null && break; sleep 1; done
curl -sf -m 2 http://127.0.0.1:3000/v1/ping >/dev/null || { journalctl -u scrap-spacetimedb -n 30 --no-pager; exit 1; }
curl -sf -m 5 http://127.0.0.1:3000/v1/database/scrap >/dev/null || { echo "database scrap is missing after the copy" >&2; exit 1; }
systemctl try-restart scrap-api
echo "SpacetimeDB up with database scrap (previous copy kept in data.prev)"
REMOTE
  say "database synced"
}

# ---------------------------------------------------------------- push

server_env() {
  [ -f "$ENV_FILE" ] || die "no $ENV_FILE"
  local k v
  echo "# ScrapSaver read-only public site (deploy/server/deploy.sh push, $(date -u +%FT%TZ))."
  echo "# READ_ONLY=1: every upload and edit is refused; Gemini, SAM and the camera are off."
  printf '%s\n' NODE_ENV=production READ_ONLY=1 SERVE_FRONTEND=1 HOST=127.0.0.1 PORT=8787 \
    TRUST_PROXY=1 SESSION_COOKIE_SECURE=1 SPACETIMEDB_URI=http://127.0.0.1:3000
  for k in SPACETIMEDB_MODULE SPACETIMEDB_TOKEN OBJECT_STORAGE_PROVIDER OBJECT_STORAGE_CONTAINER \
    R2_ACCOUNT_ID R2_ENDPOINT R2_KEY_PREFIX HALL_ID MEAL_WINDOWS ATTENDANCE_MIN ATTENDANCE_MAX ATTENDANCE_SEED; do
    v="$(envval "$k")"
    if [ -n "$v" ]; then echo "$k=$v"; fi
  done
  echo "R2_ACCESS_KEY_ID=${SERVER_R2_ACCESS_KEY_ID:-$(envval R2_ACCESS_KEY_ID)}"
  echo "R2_SECRET_ACCESS_KEY=${SERVER_R2_SECRET_ACCESS_KEY:-$(envval R2_SECRET_ACCESS_KEY)}"
}

cmd_push() {
  local sha write_env=0
  [ "${1:-}" = "--env" ] && write_env=1
  sha="$(git -C "$REPO" rev-parse HEAD)"
  [ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ] \
    || warn "uncommitted changes are not shipped: only the committed HEAD ($(git -C "$REPO" rev-parse --short HEAD)) goes up"
  if [ "$write_env" = 0 ] && ! ssh "${SSH_OPTS[@]}" "$(server)" "sudo -n test -f /etc/scrapsaver/scrap.env"; then write_env=1; fi
  if [ "$write_env" = 1 ]; then
    [ "$(envval SPACETIMEDB_TOKEN)" ] || die "SPACETIMEDB_TOKEN is missing from $ENV_FILE"
    server_env | remote_file /etc/scrapsaver/scrap.env root:scrap 640
    say "wrote /etc/scrapsaver/scrap.env (values not shown)"
  fi

  say "shipping $(git -C "$REPO" rev-parse --short HEAD) to $(server)"
  # Photos, experiments and the archived app are not needed to serve the site.
  git -C "$REPO" archive --format=tar HEAD -- . ':!test2' ':!demo_pictures' ':!images' ':!archive' \
      ':!experiments' ':!demo-tests-2' ':!tests/fixtures' \
    | gzip | ssh "${SSH_OPTS[@]}" "$(server)" \
      "sudo -n bash -c 'rm -rf /opt/scrapsaver/staging && install -d /opt/scrapsaver/staging && tar -xzf - -C /opt/scrapsaver/staging --no-same-owner'"
  remote "$sha" <<'REMOTE'
set -euo pipefail
SHA="$1"
rsync -a --delete --exclude node_modules/ --exclude dist/ --exclude '*.tsbuildinfo' /opt/scrapsaver/staging/ /opt/scrapsaver/app/
chown -R scrap:scrap /opt/scrapsaver/app
echo "GIT_COMMIT=$SHA" > /etc/scrapsaver/release.env
log=/var/lib/scrapsaver/build.log
if ! sudo -u scrap -H bash -c 'set -e
  cd /opt/scrapsaver/app/backend && npm ci --no-audit --no-fund && npm run build
  cd /opt/scrapsaver/app/frontend && npm ci --no-audit --no-fund && npm run build' > "$log" 2>&1; then
  tail -n 40 "$log"; echo "build failed; the previous build keeps running (full log: $log)" >&2; exit 1
fi
systemctl restart scrap-api
for _ in $(seq 1 30); do curl -sf -m 2 http://127.0.0.1:8787/api/health >/dev/null && break; sleep 1; done
curl -sf -m 2 http://127.0.0.1:8787/api/health || { journalctl -u scrap-api -n 30 --no-pager; exit 1; }
echo
REMOTE
  say "site is running $(git -C "$REPO" rev-parse --short HEAD) on the server"
}

# ---------------------------------------------------------------- tunnel

cmd_tunnel() {
  local cf="${CLOUDFLARED_DIR:-$HOME/.cloudflared}" id
  [ -f "$cf/config.yml" ] || die "no $cf/config.yml (docs/deploy.md step 9)"
  id="$(sed -n 's/^tunnel: *//p' "$cf/config.yml" | head -1)"
  [ -n "$id" ] && [ -f "$cf/$id.json" ] || die "tunnel credentials $cf/$id.json not found"
  grep -q 'service: http://127.0.0.1:8787' "$cf/config.yml" || die "config.yml does not point at http://127.0.0.1:8787"
  ssh "${SSH_OPTS[@]}" "$(server)" "sudo -n install -d -m 755 /etc/cloudflared"
  sed "s|^credentials-file:.*|credentials-file: /etc/cloudflared/$id.json|" "$cf/config.yml" \
    | remote_file /etc/cloudflared/config.yml root:root 644
  remote_file "/etc/cloudflared/$id.json" root:root 600 < "$cf/$id.json"
  remote <<'REMOTE'
set -euo pipefail
curl -sf -m 3 http://127.0.0.1:8787/api/health >/dev/null || { echo "the site is not running on the server yet (push first)" >&2; exit 1; }
systemctl list-unit-files cloudflared.service --no-legend | grep -q cloudflared || cloudflared service install >/dev/null 2>&1
systemctl enable cloudflared >/dev/null 2>&1
systemctl restart cloudflared
for _ in $(seq 1 30); do
  journalctl -u cloudflared --since '-2min' --no-pager | grep -q 'Registered tunnel connection' && break; sleep 1
done
n="$(journalctl -u cloudflared --since '-2min' --no-pager | grep -c 'Registered tunnel connection' || true)"
[ "$n" -gt 0 ] || { journalctl -u cloudflared -n 30 --no-pager; exit 1; }
echo "cloudflared on the server: $n tunnel connection(s) registered"
REMOTE
  say "the server now serves $PUBLIC_URL alongside the Mac. Finish with: deploy/server/deploy.sh retire-mac"
}

cmd_retire_mac() {
  local hits=0 plist="$HOME/Library/LaunchAgents/com.cloudflare.cloudflared.plist"
  # Both connectors share the traffic; make sure the server really answers before the Mac stops.
  for _ in $(seq 1 12); do
    curl -sf -m 5 "$PUBLIC_URL/api/health" | grep -q '"readOnly":true' && hits=$((hits + 1))
  done
  [ "$hits" -gt 0 ] || die "$PUBLIC_URL never answered from the server (readOnly); run tunnel first. The Mac keeps serving."
  say "$hits/12 public requests answered by the server"
  if launchctl list 2>/dev/null | grep -q com.cloudflare.cloudflared; then
    launchctl bootout "gui/$(id -u)/com.cloudflare.cloudflared" 2>/dev/null || true
  fi
  # Renamed, not deleted: `mv <plist>.disabled <plist>` and `launchctl bootstrap gui/$(id -u) <plist>` undo it.
  [ -f "$plist" ] && mv "$plist" "$plist.disabled"
  pgrep -f 'cloudflared.*tunnel run' >/dev/null && warn "a foreground cloudflared still runs on this Mac (Ctrl-C it)"
  say "the Mac's tunnel connector is off; $PUBLIC_URL is served by the server only"
}

# ---------------------------------------------------------------- status / logs

cmd_status() {
  remote <<'REMOTE'
for u in scrap-spacetimedb scrap-api cloudflared; do printf '%-18s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null)"; done
printf 'health             %s\n' "$(curl -s -m 3 http://127.0.0.1:8787/api/health || echo unreachable)"
printf 'ready              %s\n' "$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:8787/api/ready)"
printf 'disk               %s\n' "$(df -h /var/lib/scrapsaver | awk 'NR==2{print $4" free"}')"
REMOTE
  printf 'public             %s\n' "$(curl -s -m 5 "$PUBLIC_URL/api/health" || echo unreachable)"
}

cmd_logs() {
  local unit="${1:-scrap-api}"
  case "$unit" in scrap-api|scrap-spacetimedb|cloudflared) ;; *) die "unit must be scrap-api, scrap-spacetimedb or cloudflared" ;; esac
  remote "$unit" <<'REMOTE'
journalctl -u "$1" -n 100 --no-pager
REMOTE
}

case "${1:-}" in
  setup) cmd_setup ;;
  sync-db) cmd_sync_db ;;
  push) shift; cmd_push "$@" ;;
  tunnel) cmd_tunnel ;;
  retire-mac) cmd_retire_mac ;;
  status) cmd_status ;;
  logs) shift; cmd_logs "$@" ;;
  *) sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
