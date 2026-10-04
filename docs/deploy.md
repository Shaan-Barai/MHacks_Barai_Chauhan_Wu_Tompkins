# Deploying ScrapSaver on your own domain

Everything runs on **this Mac**. A **Cloudflare Tunnel** publishes it at `https://<your domain>`, so you
open no ports and need no server. (Fly.io was dropped on 2026-10-04.)

```text
browser ──https──▶ Cloudflare edge ──tunnel──▶ cloudflared (this Mac) ──▶ 127.0.0.1:8787 backend + dashboard
                                                                            ├─▶ 127.0.0.1:8790 SAM 2.1 worker (MPS)
                                                                            ├─▶ 127.0.0.1:3000 SpacetimeDB `scrap`
                                                                            ├─▶ Gemini API
                                                                            └─▶ Cloudflare R2 (images)
```

| Service | Address | Process | Started by `deploy/local.sh` |
| --- | --- | --- | --- |
| SpacetimeDB (database `scrap`) | `127.0.0.1:3000` | `spacetime start` | the `spacetime` CLI |
| SAM 2.1 Small worker | `127.0.0.1:8790` | `vision/sam/worker.py` | `.venv` (MPS) |
| Backend API + dashboard | `127.0.0.1:8787` | `node backend/dist/backend/src/server.js` | `NODE_ENV=production SERVE_FRONTEND=1` |

Everything binds to `127.0.0.1`. Only the backend is published through the tunnel. Reads are public (it
is a live demo); every write needs the ingest token (camera bridge, scripts) or an admin login with the
passcode (dashboard).

**Who does what.** Steps marked **[You]** need a purchase, a login in a browser, `sudo` or an account
console. Only you can do those. Everything else is a command you can paste. Run all commands from the
repo root (`cd ~/mhacks`, or wherever you cloned it) unless a step says otherwise.

Set your domain once per terminal. Every later command uses it:

```bash
export DOMAIN=scrapsaver.example     # your domain, e.g. scrapsaver.app (no https://, no trailing /)
```

---

## 1. Prerequisites

| Need | Check | Install |
| --- | --- | --- |
| macOS on Apple silicon (MPS) | `uname -m` → `arm64` | – |
| Homebrew | `brew --version` | https://brew.sh |
| Node.js **20.12+** (22 LTS is fine) | `node --version` | `brew install node@22` |
| SpacetimeDB CLI **2.10.x** | `spacetime --version` | `curl -sSf https://install.spacetimedb.com \| sh` |
| Python 3.10+ | `python3 --version` | `brew install python@3.12` |
| openssl, curl, git | `openssl version` | preinstalled |
| shellcheck (optional, used by `./test-all.sh`) | `shellcheck --version` | `brew install shellcheck` |

**Python venv + SAM 2.1** (once; details in [vision/sam/README.md](../vision/sam/README.md)):

```bash
python3 -m venv .venv
SAM2_BUILD_CUDA=0 .venv/bin/pip install -r vision/sam/requirements.txt   # torch + Meta sam2 @ 2b90b9f
```

The SAM checkpoint downloads from Hugging Face the first time the worker starts (about 30 s).

**[You] Gemini API key with billing.** In Google AI Studio (https://aistudio.google.com/apikey) create an
API key, and enable billing on its Google Cloud project. Without credits, captures end `failed` with a
provider error (that happened on 2026-10-04: [verification-report.md](verification-report.md)).

**[You] Cloudflare R2 bucket and token.** Cloudflare dashboard → **R2** → *Create bucket* `scrap-images`
(any name; it is `OBJECT_STORAGE_CONTAINER`). Then R2 → *Manage R2 API Tokens* → *Create API token* with
**Object Read & Write** on that bucket. Copy the **Access Key ID**, the **Secret Access Key** and your
**Account ID**. This token can read and write objects but cannot change CORS (step 11 uses `wrangler`).

## 2. Configuration: `.env`

```bash
cp .env.example .env        # .env is gitignored: never commit it
chmod 600 .env
open -e .env                # or any editor
```

Fill in:

| Variable | Value |
| --- | --- |
| `GEMINI_API_KEY` | from step 1 |
| `OBJECT_STORAGE_PROVIDER` | `r2` |
| `OBJECT_STORAGE_CONTAINER` | your bucket, e.g. `scrap-images` |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | from step 1 |
| `SPACETIMEDB_URI` / `SPACETIMEDB_MODULE` | `http://127.0.0.1:3000` / `scrap` (the defaults) |
| `SPACETIMEDB_TOKEN` | filled in by step 4 |

## 3. Strong secrets and proxy settings

Production mode refuses to start without three secrets. Generate strong ones and add the two settings
the tunnel needs:

```bash
# drop the empty placeholder lines copied from .env.example, then append real values
sed -i '' -E '/^(SCRAP_INGEST_TOKEN|SCRAP_ADMIN_PASSCODE|SESSION_SECRET|SESSION_COOKIE_SECURE|TRUST_PROXY)=$/d' .env
{
  echo "SCRAP_INGEST_TOKEN=$(openssl rand -hex 32)"      # camera bridge + scripts (Bearer token)
  echo "SCRAP_ADMIN_PASSCODE=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"   # dashboard login
  echo "SESSION_SECRET=$(openssl rand -hex 32)"          # signs the admin session cookie
  echo "TRUST_PROXY=1"              # the tunnel is one proxy hop: rate limits see the real client IP
  echo "SESSION_COOKIE_SECURE=1"    # the public site is HTTPS: the session cookie is Secure
} >> .env
grep -c -E '^(SCRAP_INGEST_TOKEN|SCRAP_ADMIN_PASSCODE|SESSION_SECRET)=.' .env    # must print 3
```

Run this once. Running it again appends a second set; the last line in the file wins, so delete the
older lines if that happens.

Read your admin passcode when you need it: `grep ^SCRAP_ADMIN_PASSCODE= .env`. Never paste these values
into chat, issues or commits.

## 4. First-time database

```bash
# a) SpacetimeDB, temporarily in its own terminal (Ctrl-C it after c; deploy/local.sh manages it later)
spacetime start --listen-addr 127.0.0.1:3000

# b) In another terminal: a local identity that owns the database, saved to .env
sed -i '' -E '/^SPACETIMEDB_TOKEN=$/d' .env
echo "SPACETIMEDB_TOKEN=$(curl -s -X POST http://127.0.0.1:3000/v1/identity | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')" >> .env
spacetime login --token "$(grep ^SPACETIMEDB_TOKEN= .env | tail -1 | cut -d= -f2)"

# c) Publish the module as `scrap` (additive; NEVER --delete-data on scrap)
(cd db/spacetimedb && npm ci && spacetime publish --module-path . --server local --delete-data=never --yes=migrate,break-clients scrap)
```

Skip this step on the team Mac: `scrap` already exists there. Stop the temporary `spacetime start` with
Ctrl-C (or leave it running: `deploy/local.sh` then reuses it and never stops it).

## 5. Start the stack

```bash
deploy/local.sh up
```

It builds data/vision/analytics/backend/frontend (`npm ci` where needed), starts SpacetimeDB, the SAM
worker and the backend (or reuses healthy ones), waits for health checks, and prints a status table:

```text
SERVICE      PORT   HEALTH    OWNER
spacetimedb  3000   healthy   local.sh (pid 51234)
sam          8790   healthy   local.sh (pid 51301)
api          8787   healthy   local.sh (pid 51388)
[local] stack up. Smoke test: node deploy/smoke.mjs http://127.0.0.1:8787
```

Open http://127.0.0.1:8787. Logs are in `deploy/.run/logs/`.

## 6. Demo data

```bash
deploy/local.sh seed --live-dinner     # menus, demo portions, and today's 26-food dinner (labeled demo)
```

It is idempotent. Run it again on each new day you demo, so the camera's captures resolve to tonight's
dinner (`svc_hall-main_<today>_dinner`).

## 7. Test everything

```bash
./test-all.sh            # offline: every package's tests, dashboard build, integration, Python, scripts
./test-all.sh --live     # + the running stack: smoke test, live E2E suites, demo.py --simulate
```

Both end with a PASS/FAIL table and exit non-zero on any failure. `--live` makes a handful of Gemini +
SAM calls and writes only to test halls (`hall-test`, `hall-smoke`, `hall-e2e-*`), never hall-main.
Fix any failure before going public. Details: [runbook.md](runbook.md#run-every-test-test-allsh).

## 8. [You] Get the domain onto Cloudflare

The tunnel needs the domain's DNS on Cloudflare (a free plan is enough).

- **Buy a new domain on Cloudflare Registrar:** dashboard → *Domain Registration* → *Register Domains*,
  search, pay. The domain is on Cloudflare DNS immediately.
- **Or use a domain you already own:** dashboard → *Add a domain* → enter it → *Free* plan → Cloudflare
  shows two nameservers. At your current registrar, replace the domain's nameservers with those two. Wait
  until the domain shows **Active** in Cloudflare (minutes to a few hours; you get an email). Check with
  `dig +short NS $DOMAIN`.

## 9. [You] Create the Cloudflare Tunnel

```bash
brew install cloudflared
cloudflared tunnel login                     # [You] browser opens: pick $DOMAIN; writes ~/.cloudflared/cert.pem
cloudflared tunnel create scrapsaver         # prints "Created tunnel scrapsaver with id <TUNNEL_ID>"
export TUNNEL_ID=<paste the id>              # also the name of ~/.cloudflared/<TUNNEL_ID>.json
cloudflared tunnel route dns scrapsaver "$DOMAIN"         # CNAME $DOMAIN → <TUNNEL_ID>.cfargotunnel.com
cloudflared tunnel route dns scrapsaver "www.$DOMAIN"
```

Write the config from [deploy/cloudflared.example.yml](../deploy/cloudflared.example.yml) (ingress for
`$DOMAIN` and `www.$DOMAIN` → `http://127.0.0.1:8787`, everything else → 404):

```bash
sed -e "s/<TUNNEL_ID>/$TUNNEL_ID/g" -e "s/<YOU>/$USER/g" -e "s/scrap\.example\.com/$DOMAIN/g" \
  deploy/cloudflared.example.yml > ~/.cloudflared/config.yml
cloudflared tunnel ingress validate                    # "OK"
cloudflared tunnel ingress rule "https://$DOMAIN"      # matches rule 0 → http://127.0.0.1:8787
cloudflared tunnel run scrapsaver                      # foreground; Ctrl-C stops it
```

With the stack up (step 5), open `https://$DOMAIN`: the dashboard loads over HTTPS. The tunnel credentials
file (`~/.cloudflared/<TUNNEL_ID>.json`) is a secret: never commit or share it.

## 10. [You] Run the tunnel as a service

Stop the foreground `cloudflared` (Ctrl-C), then:

```bash
cloudflared service install          # LaunchAgent: starts at login, reads ~/.cloudflared/config.yml
```

The LaunchAgent it writes runs bare `cloudflared`, which current versions (2026.9.x) refuse: the service
exits 1 every 5 s and `~/Library/Logs/com.cloudflare.cloudflared.err.log` repeats "use `cloudflared
tunnel run` to start tunnel …". Add the two arguments and reload it:

```bash
P=~/Library/LaunchAgents/com.cloudflare.cloudflared.plist
plutil -insert ProgramArguments.1 -string tunnel "$P"
plutil -insert ProgramArguments.2 -string run "$P"
launchctl bootout gui/$(id -u)/com.cloudflare.cloudflared; launchctl bootstrap gui/$(id -u) "$P"
launchctl list | grep cloudflared     # a pid in the first column, not "-"
```

`cloudflared tunnel run` reads the tunnel id from `tunnel:` in `config.yml`.

That is the simplest choice, and it matches step 12 (the stack also starts at login). To start at
**boot** without a login instead, copy `config.yml` and `<TUNNEL_ID>.json` to `/etc/cloudflared/`, point
`credentials-file` at the new path, and run `sudo cloudflared service install` (a LaunchDaemon).

Check: Cloudflare dashboard → *Zero Trust* → *Networks* → *Tunnels* shows `scrapsaver` **Healthy**, or
`cloudflared tunnel info scrapsaver` lists a connection. Remove the service with
`cloudflared service uninstall` (`sudo` for the boot-time one).

## 11. [You] R2 CORS for the domain

Only uploads **from the browser** (such as a calibration photo from the dashboard) go straight to R2,
and R2 must allow the site's origin. The camera bridge and scripts upload server-to-server and need no
CORS. The R2 API token from step 1 **cannot** set CORS, so use your Cloudflare login:

```bash
npx wrangler login                   # [You] browser login to Cloudflare
: "${DOMAIN:?export DOMAIN first (step 1)}"                    # empty DOMAIN → R2 says "JSON not well formed"
BUCKET="$(sed -n 's/^OBJECT_STORAGE_CONTAINER=//p' .env)"; echo "bucket: $BUCKET"   # the bucket the backend uses
sed "s/scrap\.example\.com/$DOMAIN/g" deploy/r2-cors.prod.json > deploy/.run/r2-cors.json
npx wrangler r2 bucket cors set "$BUCKET" --file deploy/.run/r2-cors.json
npx wrangler r2 bucket cors list "$BUCKET"        # shows https://$DOMAIN, https://www.$DOMAIN, localhost
```

An empty `$DOMAIN` (a new terminal) writes the origins `https://` and `https://www.`, which R2 rejects
as "The JSON you provided was not well formed. [code: 10040]". "The specified bucket does not exist.
[code: 10006]" means the name differs from `OBJECT_STORAGE_CONTAINER` (`npx wrangler r2 bucket list`).

[deploy/r2-cors.prod.json](../deploy/r2-cors.prod.json) keeps the local origins
([r2-cors.local.json](../deploy/r2-cors.local.json)) and adds the domain placeholders. Without wrangler:
dashboard → R2 → your bucket → *Settings* → *CORS policy* → *Edit*, and paste:

```json
[{ "AllowedOrigins": ["https://YOUR-DOMAIN", "https://www.YOUR-DOMAIN", "http://localhost:5173", "http://localhost:8787", "http://127.0.0.1:8787"],
   "AllowedMethods": ["GET", "PUT"], "AllowedHeaders": ["content-type"], "MaxAgeSeconds": 3600 }]
```

## 12. Keep the Mac serving

The site is down whenever the Mac sleeps, logs out or the stack stops.

- **For a demo day:** `caffeinate -dims` in a terminal (keeps the Mac and disks awake until Ctrl-C).
- **[You] Always on (on power):** `sudo pmset -c sleep 0 disksleep 0` (never sleep on the charger), and
  on a laptop with the lid closed `sudo pmset -a disablesleep 1`. Undo with `sudo pmset -a disablesleep 0`
  and `sudo pmset -c sleep 10`. Check with `pmset -g`.
- **[You] Start the stack at login:** fill in your paths in
  [deploy/com.scrapsaver.stack.plist.example](../deploy/com.scrapsaver.stack.plist.example), then
  ```bash
  sed "s|/Users/YOU|$HOME|g" deploy/com.scrapsaver.stack.plist.example > ~/Library/LaunchAgents/com.scrapsaver.stack.plist
  plutil -lint ~/Library/LaunchAgents/com.scrapsaver.stack.plist
  launchctl load -w ~/Library/LaunchAgents/com.scrapsaver.stack.plist   # runs `SKIP_BUILD=1 deploy/local.sh up` now and at each login
  ```
  Its output goes to `deploy/.run/logs/launchd.log`. Remove it with `launchctl unload -w` on the same
  file. *System Settings → Users & Groups → Automatically log in as* makes a reboot come back up on its
  own (only on a Mac you trust physically).

## 13. Point the camera bridge at the site

If the bridge runs **on this Mac**, keep it on `http://127.0.0.1:8787` (the default): it is faster and
does not depend on the tunnel. It reads `SCRAP_INGEST_TOKEN` from `.env`.

If the bridge runs on **another laptop**, give it the domain and the same token:

```bash
export SCRAP_API_URL="https://$DOMAIN"
export SCRAP_INGEST_TOKEN=<the value from this Mac's .env>     # [You] copy it over a private channel
cd capture && npm run ingest-inbox -- --service "svc_hall-main_$(TZ=America/Detroit date +%F)_dinner" --watch
```

The scripts send `Authorization: Bearer …` only to the backend, never to R2's presigned URLs, and never
print the token ([BRIDGE.md](../BRIDGE.md)). A 401 means the token is missing or different from the server's.

## 14. Verify the public site

```bash
curl -s "https://$DOMAIN/api/health"                       # {"ok":true,"provider":"r2",…}
curl -s -o /dev/null -w '%{http_code}\n' "https://$DOMAIN/api/ready"          # 200
curl -s -o /dev/null -w '%{http_code}\n' "https://$DOMAIN/api/services"       # 200: reads work logged out
curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://$DOMAIN/api/captures" \
  -H 'content-type: application/json' -d '{}'                                # 401: writes need auth
curl -sI "https://$DOMAIN/" | grep -i -E '^(content-type|strict-transport-security|x-frame-options)'

node deploy/smoke.mjs "https://$DOMAIN" --no-roundtrip    # read-only checks + 401s, no token needed
(set -a; . ./.env; set +a; node deploy/smoke.mjs "https://$DOMAIN")   # + one upload → analysis round trip on hall-smoke
SCRAP_PROD_URL="https://$DOMAIN" python3 demo.py --only deploy        # health, ready, dashboard HTML
```

In a browser (private window): `https://$DOMAIN` shows the dashboard logged out; *Settings* → log in with
the admin passcode → a change saves; log out → the same change is refused.

## 15. Optional: Cloudflare Access in front of Settings

The admin passcode already protects every write. For a second factor on the admin login, add a
Cloudflare Access application (**[You]**, Zero Trust dashboard → *Access* → *Applications* → *Add* →
*Self-hosted*):

- Destinations: `$DOMAIN/settings` and `$DOMAIN/api/auth/login` in **one** application (one Access cookie
  covers both).
- Policy: *Allow*, *Emails* = the staff who administer it (one-time PIN by email).
- Staff then open `https://$DOMAIN/settings` **directly** (bookmark it), pass Access, and log in with the
  passcode. Clicking *Settings* inside the already-loaded app does not reload the page, so Access only sees
  direct visits; the login request is what it really guards.
- Do **not** put Access in front of `/` or all of `/api/*`: public reads are the point of the demo, and the
  camera bridge authenticates with its bearer token and cannot do an Access login (unless you also create
  an Access service token for it).

---

## Updating

```bash
git pull --ff-only
git diff --stat 'HEAD@{1}' HEAD -- db/     # schema changed? then publish it (step 4c) before restarting
deploy/local.sh restart                    # down + up: rebuilds backend + frontend
./test-all.sh --live                       # or at least: ./test-all.sh --only stack,smoke
```

`restart` stops and starts the services this script started, so the site answers **502** for a minute or
two while SAM reloads. Captures sent meanwhile fail with a retryable error, and the bridge retries them.

## Rollback

```bash
git log --oneline -10                      # find the last good commit
git switch --detach <good-sha>
deploy/local.sh restart
./test-all.sh --only stack,smoke
# back to the latest later:  git switch main && git pull --ff-only && deploy/local.sh restart
```

Schema publishes are additive and are not rolled back: older code ignores the newer columns. Never use
`--delete-data` on `scrap` (it deletes every capture).

## Logs

| What | Where |
| --- | --- |
| Backend (JSON lines, no tokens or signed URLs) | `tail -f deploy/.run/logs/api.log` |
| SAM worker / SpacetimeDB / build | `deploy/.run/logs/{sam,spacetimedb,build}.log` |
| Stack at login (launchd) | `deploy/.run/logs/launchd.log` |
| Tunnel (service) | `~/Library/Logs/com.cloudflare.cloudflared.err.log` (boot-time daemon: `/Library/Logs/…`) |
| Tunnel health | Zero Trust → Networks → Tunnels, or `cloudflared tunnel info scrapsaver` |
| Last test run | `tests/.logs/latest/<suite>.log` |

## Rotating secrets

1. Generate new values (step 3 commands) and replace the old lines in `.env`.
2. `deploy/local.sh restart`. Changing `SESSION_SECRET` logs every admin out.
3. Give the camera bridge the new `SCRAP_INGEST_TOKEN` and restart it.
4. Gemini / R2 keys: rotate them in Google AI Studio / Cloudflare R2, update `.env`, then restart.
5. Tunnel credentials leaked? `cloudflared tunnel delete scrapsaver` and redo step 9 (new id).

## Troubleshooting

- **Python `CERTIFICATE_VERIFY_FAILED` (`demo.py`, `capture/scripts/live_camera_test.py`) on macOS:** python.org
  builds ship no CA bundle. Run `/Applications/Python 3.x/Install Certificates.command` or `pip install certifi`
  (both scripts use certifi automatically when importable).
- **502 Bad Gateway from the tunnel:** cloudflared runs but the backend does not answer. Check
  `deploy/local.sh status` and `curl -s http://127.0.0.1:8787/api/health`. The ingress service must be
  `http://127.0.0.1:8787` (http, not https; `127.0.0.1`, not `localhost`, which can resolve to IPv6).
  During `deploy/local.sh restart` a short 502 is expected.
- **Cloudflare error 1033 / "tunnel not found":** cloudflared is not running. Check
  `cloudflared tunnel info scrapsaver` and the tunnel log, or run `cloudflared tunnel run scrapsaver`.
- **Domain does not resolve:** the nameservers are not active yet (step 8; `dig +short NS $DOMAIN`), or
  `route dns` was not run (`dig +short $DOMAIN` should show Cloudflare addresses).
- **Admin login works but edits return 401, or the login does not stick:** the session cookie is `Secure`
  (`SESSION_COOKIE_SECURE=1`) and needs `https://$DOMAIN`, not `http://`. Clear the site's cookies and log
  in again. Do not set `SESSION_COOKIE_SECURE=0` on a public site. On `http://127.0.0.1:8787`, Safari drops
  Secure cookies: use Chrome locally.
- **403 `ORIGIN_MISMATCH` on admin edits:** the browser's `Origin` host differs from the request `Host`.
  Use one hostname per tab (`$DOMAIN` or `www.$DOMAIN`), and do not set `httpHostHeader` in the tunnel config.
- **Rate limit (429) for everyone at once:** `TRUST_PROXY=1` is missing, so every visitor looks like the
  tunnel's IP. Add it to `.env` and restart.
- **CORS error / 403 on a browser upload to `*.r2.cloudflarestorage.com`:** the bucket's CORS lacks
  `https://$DOMAIN`. Redo step 11 and check with `npx wrangler r2 bucket cors list`. Changes take up to a
  minute. Image *display* never needs CORS.
- **SAM not ready (`/api/ready` not 200, captures `failed`/`needs_review`):** `deploy/local.sh status`,
  then `tail -n 50 deploy/.run/logs/sam.log`. The first start downloads the checkpoint (needs network). A
  missing package means the venv is incomplete (step 1). `deploy/local.sh restart` after fixing it.
- **`startup refused` in `api.log`:** a production secret is missing (step 3).
- **`backend build failed`:** read `deploy/.run/logs/build.log`. `cd data && npm run build` (then
  `vision`, `analytics`, `backend`) shows the tsc error. `SKIP_BUILD=1 deploy/local.sh up` runs the last
  emitted `dist/` meanwhile.
- **A port is "taken by pid N, which fails the health check":** something else holds it. Stop that
  process yourself or use another port; the script never kills processes it did not start.
- **Captures end `failed` with a provider error:** Gemini billing or quota. Failed analyses are never
  counted as zero waste; re-run them later with `node backend/scripts/retry-failed.mjs`.

## Taking the site down

```bash
cloudflared service uninstall                 # or Ctrl-C a foreground tunnel
deploy/local.sh down                          # stops only what deploy/local.sh started
# permanently: cloudflared tunnel cleanup scrapsaver && cloudflared tunnel delete scrapsaver,
# then delete the two CNAME records in the Cloudflare DNS dashboard.
```

---

## Reference: `deploy/local.sh`

```bash
deploy/local.sh up | down | status | restart
deploy/local.sh seed --live-dinner     # backend/scripts/seed.mjs against the stack
deploy/local.sh smoke [--strict]       # deploy/smoke.mjs with the stack's token
```

- `up` loads `deploy/.run/local-secrets.env` and then `.env` (never printed), points the backend at
  `SAM_WORKER_URL=http://127.0.0.1:8790`, and starts or **reuses** each service. A service whose port
  already passes its health check is reused, reported as `external`, and never stopped. A port that is
  taken but unhealthy is reported and left alone. If `.env` lacks the three auth secrets, `up` generates
  them once into `deploy/.run/local-secrets.env` (mode 600, gitignored); `.env` always wins.
- `down` stops only pids from its own pidfiles whose command line still matches the service. That
  includes a **Depth Anything V2 worker** (`deploy/.run/depth.pid`, :8791) started before depth was
  removed on 2026-10-04: `up` warns while one is still running, and `down` (or `restart`) stops it.
- State: `deploy/.run/` (gitignored): `<name>.pid`, `logs/`, `local-secrets.env`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SCRAP_ENV_FILE` | `<repo>/.env` | Secrets file |
| `SCRAP_VENV` | `<repo>/.venv` | Python venv for the SAM worker |
| `SCRAP_RUN_DIR` | `<repo>/deploy/.run` | State dir (a git worktree can point at the main checkout's) |
| `API_PORT` / `API_HOST` | `8787` / `127.0.0.1` | Backend bind |
| `SAM_PORT` / `STDB_PORT` | `8790` / `3000` | Other ports |
| `SKIP_BUILD=1` | – | Start the backend from the existing `dist/` |
| `HEALTH_TIMEOUT_ML` | `300` | Seconds to wait for the SAM worker (first start downloads weights) |

## Reference: smoke test

`node deploy/smoke.mjs [url] [--strict] [--no-roundtrip] [--image path]` checks `/api/health`,
`/api/ready`, that `/` and a deep link return the dashboard HTML, security headers,
`/api/dashboard/impact`, and that unauthenticated writes and a wrong passcode get **401**. With
`SCRAP_INGEST_TOKEN` set (read from `deploy/.run/local-secrets.env` automatically for a local URL) it also
does one upload → capture → analysis round trip on the hall **`hall-smoke`** (one Gemini + SAM call) and
confirms that capture is not in hall-main's gallery. Exit code 0 means no FAIL; `--strict` also fails on
WARN.
