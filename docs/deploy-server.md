# Running scrapsaver.app on an offsite server (read-only)

The public site runs on a small rented Linux server, so the Mac can be off. That server is
**read-only**. It shows the recorded data: dashboard, statistics, menus, portions, plates and their
photos, and the last stored AI recommendation. It accepts no uploads or edits. Gemini, SAM 2.1 and
the camera are never used there. The Mac keeps the full app for capturing plates and live demos
([deploy.md](deploy.md)).

```text
browser ──https──▶ Cloudflare ──tunnel──▶ cloudflared (server) ──▶ 127.0.0.1:8787 backend + dashboard (READ_ONLY=1)
                                                                    ├─▶ 127.0.0.1:3000 SpacetimeDB `scrap` (copied from the Mac)
                                                                    └─▶ Cloudflare R2 (photos, presigned reads)
```

- **Read-only means it.** With `READ_ONLY=1`, every non-GET `/api` request answers `403 READ_ONLY`,
  even with the ingest token. So do `/api/try-image/*` and `/api/camera/*`. No admin sign-in exists.
  Gemini stays off even if a key is present. The dashboard hides upload, edit, "Ask again", Try an
  Image and admin controls, and shows "Read-only view" at the top.
- **Data comes from the Mac.** `sync-db` copies the Mac's SpacetimeDB data folder and its signing keys,
  so the existing `SPACETIMEDB_TOKEN` keeps working. New plates captured on the Mac reach the site only
  when you run `sync-db` again.
- **Same tunnel, same domain.** The existing `scrapsaver` tunnel moves to the server. No DNS changes.

## 1. [You] Rent a server

Any Ubuntu 24.04 (or Debian 12) VM with **2 GB RAM or more** and about 10 GB of disk works. No GPU is
needed. For example, Hetzner Cloud's smallest shared-vCPU plans or a DigitalOcean 2 GB droplet. Add
your SSH public key when you create it (`cat ~/.ssh/id_ed25519.pub`). Then check that this works
without a password prompt:

```bash
export SCRAP_SERVER=root@<server-ip>      # or a user with passwordless sudo
ssh "$SCRAP_SERVER" true && echo ok
```

## 2. Set up, copy the data, start the site

From the repo on the Mac, with the Mac's stack running (`deploy/local.sh status`):

```bash
deploy/server/deploy.sh setup      # Node 22, SpacetimeDB 2.10.2, cloudflared, user `scrap`, systemd, firewall (SSH only)
deploy/server/deploy.sh sync-db    # pauses the Mac's SpacetimeDB ~10 s, copies data + keys, starts it on the server
deploy/server/deploy.sh push       # ships the committed HEAD, builds it there, writes /etc/scrapsaver/scrap.env, starts it
deploy/server/deploy.sh status
```

`push` builds `/etc/scrapsaver/scrap.env` from the Mac's `.env`. It contains `READ_ONLY=1`, the
SpacetimeDB token and the R2 bucket and keys, and nothing else: no Gemini key, ingest token or
passcode. **Recommended:** create an R2 API token with **Object Read only** on the bucket (Cloudflare
→ R2 → Manage API tokens) and push it instead of the Mac's read/write one:

```bash
SERVER_R2_ACCESS_KEY_ID=… SERVER_R2_SECRET_ACCESS_KEY=… deploy/server/deploy.sh push --env
```

Optional check through an SSH tunnel before going public:
`ssh -L 8799:127.0.0.1:8787 "$SCRAP_SERVER"`, then `node deploy/smoke.mjs http://127.0.0.1:8799` in
another terminal. Every check should pass, and writes should show `403 READ_ONLY`.

## 3. Move the tunnel

```bash
deploy/server/deploy.sh tunnel       # copies ~/.cloudflared/config.yml + <id>.json; cloudflared runs as a systemd service
deploy/server/deploy.sh retire-mac   # checks scrapsaver.app answers from the server, then stops the Mac's connector
```

Between those two commands, Cloudflare splits visitors between the Mac and the server. Both show the
same data right after `sync-db`. `retire-mac` refuses to run until the public site answers with
`"readOnly":true`. It disables the Mac's LaunchAgent by renaming it to `…cloudflared.plist.disabled`.
To undo, rename it back and run `launchctl bootstrap gui/$(id -u) <plist>`.

Verify:

```bash
curl -s https://scrapsaver.app/api/health                   # … "readOnly":true …
SCRAP_PROD_URL=https://scrapsaver.app python3 demo.py --only deploy
node deploy/smoke.mjs https://scrapsaver.app                # 0 failed; writes → 403 READ_ONLY
```

## Day to day

| Task | Command |
| --- | --- |
| Show newly captured plates online | `deploy/server/deploy.sh sync-db` (replaces the server's copy; the previous one is kept as `data.prev`) |
| Ship a code change | commit, then `deploy/server/deploy.sh push` (only the committed HEAD is shipped) |
| Schema changed in `db/` | publish it on the Mac as usual (deploy.md step 4c), then `sync-db`: the module travels with the data |
| Health | `deploy/server/deploy.sh status` |
| Logs | `deploy/server/deploy.sh logs [scrap-api\|scrap-spacetimedb\|cloudflared]` |

The server restarts all three services on boot and after a crash (`Restart=always`). Ubuntu cloud images install
security updates automatically (`unattended-upgrades`).

## Where things live on the server

| What | Where |
| --- | --- |
| Code + builds | `/opt/scrapsaver/app` (owned by `scrap`) |
| Settings (secrets, `root:scrap 640`) | `/etc/scrapsaver/scrap.env`, `/etc/scrapsaver/release.env` (`GIT_COMMIT`) |
| Database | `/var/lib/scrapsaver/stdb/data` (+ `data.prev`, `incoming/`), keys in `stdb/keys/` (600) |
| Units | `scrap-spacetimedb`, `scrap-api` (`deploy/server/*.service`), `cloudflared` |
| Tunnel | `/etc/cloudflared/config.yml`, `/etc/cloudflared/<id>.json` (600) |
| Last build log | `/var/lib/scrapsaver/build.log` |

Everything listens on `127.0.0.1`. The firewall allows SSH only, because the tunnel connects outward.

## Troubleshooting

- **`sync-db`: "SpacetimeDB on :3000 was not started by deploy/local.sh".** A copy needs the database
  paused, and the script only stops a process it can identify. Stop your `spacetime start` (Ctrl-C),
  run `sync-db`, then start it again.
- **`push`: build failed.** The last 40 lines are printed, and the previous build keeps serving.
- **The dashboard loads but shows no plates / images.** Check that `status` shows `ready 200`. A 503
  means the database or R2 check failed: `logs scrap-api`. With a read-only R2 token, check it covers
  the bucket in `OBJECT_STORAGE_CONTAINER`.
- **Cloudflare 1033 after `retire-mac`.** The server's connector is down: `logs cloudflared`, then
  undo `retire-mac` (above) while you fix it.
