# Running ScrapSaver as a local production stack

IT_4 workstream P. The user decided (2026-10-04) to drop Fly.io: **everything runs on the team Mac**.
The ML models use the Mac's GPU (MPS), SpacetimeDB stays local, and images stay in Cloudflare R2.
One script starts and stops the stack.

| Service | Address | Process | Started by `deploy/local.sh` from |
| --- | --- | --- | --- |
| SpacetimeDB (database `scrap`) | `127.0.0.1:3000` | `spacetime start` | the `spacetime` CLI |
| SAM 2.1 Small worker | `127.0.0.1:8790` | `vision/sam/worker.py` | `.venv` (MPS) |
| Depth Anything V2 Metric Indoor Small worker | `127.0.0.1:8791` | `vision/depth/worker.py` | `.venv` (MPS); skipped if the file is absent |
| Backend API + dashboard | `127.0.0.1:8787` | `node backend/dist/backend/src/server.js` | `NODE_ENV=production SERVE_FRONTEND=1` |

Everything binds to `127.0.0.1`. Nothing is reachable from other machines unless you add the optional
Cloudflare Tunnel described at the end.

## One-time setup

1. **Node 20+**, the **`spacetime` CLI** (2.10.x), and **Python 3.10+**.
2. **Python venv** at `<repo>/.venv` with torch, Meta `sam2` (installed from source at `2b90b9f`), and
   `transformers`. See [vision/sam/README.md](../vision/sam/README.md) and `vision/depth/` (its README and
   `requirements.txt`). The weights download from Hugging Face on the first start (SAM about 30 s, DAv2 longer).
   Use a different venv with `SCRAP_VENV=/path/to/venv`.
3. **`.env`** at the repo root (copy `.env.example`): `GEMINI_API_KEY`, the `R2_*` /
   `OBJECT_STORAGE_*` values, `SPACETIMEDB_URI=http://127.0.0.1:3000`, `SPACETIMEDB_MODULE=scrap`, and
   `SPACETIMEDB_TOKEN`. Production mode also needs **three auth secrets**. Put them in `.env`, so the
   camera bridge and scripts use the same values:
   ```bash
   # values are random; never commit them
   echo "SCRAP_INGEST_TOKEN=$(openssl rand -hex 32)" >> .env
   echo "SCRAP_ADMIN_PASSCODE=$(openssl rand -hex 6)" >> .env
   echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env
   ```
   If they are missing, `local.sh` generates them once into `deploy/.run/local-secrets.env` (mode 600,
   gitignored). Values in `.env` always win over that file. The admin passcode for the dashboard login
   is in whichever file holds it.
4. **The `scrap` database** must exist in local SpacetimeDB. It already does on the team Mac. On a fresh machine,
   follow [db/README.md](../db/README.md) (`spacetime publish … scrap`, never `--delete-data`).
5. **R2 CORS** (only for uploads *from the browser*, such as a dashboard calibration photo): the bucket must
   allow the dashboard's origin. Apply [deploy/r2-cors.local.json](../deploy/r2-cors.local.json) once:
   ```bash
   npx wrangler r2 bucket cors set scrap-images --file deploy/r2-cors.local.json
   ```
   It allows `http://localhost:5173` (vite dev), `http://localhost:8787` and `http://127.0.0.1:8787`.
   `backend/r2-cors.json` (backend owner) lists only the dev origin. The camera bridge and scripts upload
   server-to-server and do not need CORS.

## Daily use

```bash
deploy/local-up.sh            # = deploy/local.sh up
deploy/local.sh status        # each service: health, and who started it
deploy/local.sh seed --live-dinner   # once per day: menus + tonight's 26-food dinner (demo-labeled)
deploy/local.sh smoke         # deploy/smoke.mjs against the stack, with the stack's ingest token
open http://localhost:8787    # dashboard (reads are public; log in with the admin passcode to edit)
deploy/local-down.sh          # = deploy/local.sh down
deploy/local.sh restart       # down + up (rebuilds backend + frontend: use after git pull)
```

What `up` does, in order:

1. Loads `deploy/.run/local-secrets.env`, then `.env` (never printed), and points the backend at
   `SAM_WORKER_URL=http://127.0.0.1:8790` and `DEPTH_WORKER_URL=http://127.0.0.1:8791`.
2. For each service: if its port already answers the **health check**, it is **reused** and reported as
   `external`. The script never stops or restarts it, so a dev backend or a worker you started by hand
   keeps running. If the port is taken but unhealthy, it reports this and leaves the process alone. Otherwise it
   starts the service detached (its own session), writes `deploy/.run/<name>.pid`, and waits for health
   (`/v1/ping`, `/health`, `/api/health`).
3. Before starting the backend it runs `npm ci` where `node_modules` is missing, then `npm run build` in
   `backend/` (builds data, vision and analytics first) and `frontend/`. Set `SKIP_BUILD=1` to skip this.
4. It reports `/api/ready` (database, R2 and workers reachable) and whether `/` serves the dashboard.

`down` stops **only** processes listed in its pidfiles, after checking that each pid's command line still
matches the service (it guards against recycled pids). Everything else keeps running.

Logs: `deploy/.run/logs/{spacetimedb,sam,depth,api,build}.log` (appended; the backend writes JSON
lines without tokens or signed URLs). Follow one with `tail -f deploy/.run/logs/api.log`.

### Options

| Variable | Default | Meaning |
| --- | --- | --- |
| `SCRAP_ENV_FILE` | `<repo>/.env` | Secrets file |
| `SCRAP_VENV` | `<repo>/.venv` | Python venv for the workers |
| `API_PORT` / `API_HOST` | `8787` / `127.0.0.1` | Backend bind |
| `SAM_PORT` / `DEPTH_PORT` / `STDB_PORT` | `8790` / `8791` / `3000` | Other ports |
| `SKIP_BUILD=1` | – | Start the backend from the existing `dist/` |
| `SKIP_DEPTH=1` | – | Do not start the depth worker |
| `HEALTH_TIMEOUT_ML` | `300` | Seconds to wait for a model worker (first start downloads weights) |

A second stack on other ports (such as `API_PORT=8797 SAM_PORT=8798`) works for testing. Pidfiles are per
checkout, so run only one script-managed stack per checkout at a time.

### Camera bridge against the stack

The bridge and capture scripts send `Authorization: Bearer $SCRAP_INGEST_TOKEN` and use
`SCRAP_API_URL=http://127.0.0.1:8787` ([BRIDGE.md](../BRIDGE.md)). With the token in `.env`, they pick it up
the same way the backend does.

## Smoke test

```bash
deploy/local.sh smoke                 # or: node deploy/smoke.mjs http://127.0.0.1:8787
deploy/local.sh smoke --strict        # WARN counts as FAIL
node deploy/smoke.mjs <url> --no-roundtrip   # read-only checks only
```

Checks: `/api/health`; `/api/ready`; `/` and an unknown deep path return the dashboard HTML (SPA
fallback); security headers; `/api/dashboard/impact` JSON. Every probed mutation without credentials returns
**401**, and a wrong admin passcode returns 401. With a token it also runs a **round trip** on the dedicated hall
**`hall-smoke`**: it uploads a menu, normalizes `test2/IMG_2695.jpeg` to 1024² like the capture module,
uploads it to R2, finalizes it, submits a capture, and polls until the analysis ends. It then fetches read URLs
and confirms the capture is **not** in the `hall-main` gallery. The dashboard and `demo.py` only show
`hall-main`. This makes **one live Gemini + SAM call**.
Exit code 0 means no FAIL.

## Troubleshooting

- **`backend build failed`**: read `deploy/.run/logs/build.log`. `build-deps.mjs` hides tsc output, so
  run `cd data && npm run build` (then `vision`, `analytics`, `backend`) to see the error. When `main`
  is mid-change (a contract field added before its producer is regenerated), tsc still emits JS:
  `SKIP_BUILD=1 deploy/local.sh up` runs the last emitted `dist/`.
- **`startup refused` in `api.log`**: production mode requires `SCRAP_INGEST_TOKEN`,
  `SCRAP_ADMIN_PASSCODE` and `SESSION_SECRET` (see setup step 3).
- **Admin login does not stick over plain http**: the session cookie is `Secure` in production. Chrome and
  Firefox accept it on `http://localhost`. Safari may not, so use Chrome, or set `SESSION_COOKIE_SECURE=0`
  in `.env` for local-only use (never behind a public tunnel).
- **A port is "taken by pid N, which fails the health check"**: something else is on that port. Stop it
  yourself or pick another port. The script will not kill it.
- **A worker exits at startup**: the last 25 log lines are printed. Typical causes are a missing package in the venv,
  or no network on the first weights download. MPS failures fall back to CPU inside the SAM worker
  (`PYTORCH_ENABLE_MPS_FALLBACK=1` is set).
- **Captures end `failed` with a provider error**: Gemini billing/quota (`GEMINI_API_KEY`). Pixels are
  never reported as zero for a failed analysis.

## Optional later: a public URL with a Cloudflare Tunnel (documentation only)

This is **not** set up and nothing here runs automatically. A tunnel publishes the local backend on
your own domain over HTTPS without opening ports. The domain must use Cloudflare DNS (simplest with
Cloudflare Registrar). Steps, when you decide to do it:

```bash
brew install cloudflared
cloudflared tunnel login                         # browser: pick the domain's zone
cloudflared tunnel create scrapsaver             # writes ~/.cloudflared/<TUNNEL_ID>.json
cloudflared tunnel route dns scrapsaver scrap.example.com     # CNAME → <TUNNEL_ID>.cfargotunnel.com
cat > ~/.cloudflared/config.yml <<'YAML'
tunnel: scrapsaver
credentials-file: /Users/<you>/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: scrap.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
YAML
cloudflared tunnel run scrapsaver                # or: sudo cloudflared service install
```

Before exposing it:

- Set `TRUST_PROXY=1` in `.env` and `deploy/local.sh restart`, so per-IP rate limits see the real client IP
  (the tunnel is one proxy hop). Keep `SESSION_COOKIE_SECURE` unset: the public origin is HTTPS.
- Use strong, freshly generated `SCRAP_ADMIN_PASSCODE` / `SCRAP_INGEST_TOKEN` / `SESSION_SECRET`.
  Reads are public by design (live demo). Every mutation is authenticated.
- Add `https://scrap.example.com` to `deploy/r2-cors.local.json` origins and re-apply it with wrangler.
- Only the backend port is routed. SpacetimeDB (:3000) and the ML workers stay on `127.0.0.1`.
  Do not add ingress rules for them.
- The site is down whenever the Mac sleeps or the stack is stopped (`caffeinate -dis` keeps it awake).

To take it down: stop `cloudflared` and `cloudflared tunnel delete scrapsaver`. Remove the DNS record in the
Cloudflare dashboard if `route dns` created one.

## Rotating secrets

1. Generate new values in `.env` (or delete `deploy/.run/local-secrets.env` to regenerate the fallback).
2. `deploy/local.sh restart`. Existing admin sessions become invalid when `SESSION_SECRET` changes.
3. Restart the camera bridge so it reads the new `SCRAP_INGEST_TOKEN`.
4. R2 / Gemini keys: rotate them in the Cloudflare / Google consoles, update `.env`, then restart.
