# Minimal runbook

## Start (fixture-only machine)

```bash
cd tests && npm test
```

Expected: all integration tests pass; e2e live suite skipped unless `SCRAP_E2E=1`.

## Start (full prototype)

Follow the root [README](../README.md#setup). In short, four terminals:

1. `spacetime start`
2. `cd backend && npm start` — logs `persistence: SpacetimeDB scrap, vision: live Gemini`
3. `cd frontend && npm run dev` → http://localhost:5173
4. One-off: `cd backend && npm run seed`, then `cd capture && npm run replay`

Smoke: the dashboard's "Today" preset shows waste for 2026-10-03 and the
Dinner tab shows a Gemini tip.

## Reset the demo data

```bash
spacetime publish --module-path db/spacetimedb --server local --delete-data=always --yes scrap
rm -f capture/.replay-state.json      # replay identities belong to the old database
rm -rf backend/.local-storage          # local-dev images (R2 objects can stay; they're unreferenced)
# restart the backend, then seed + replay again
```

## Recover

| Symptom | Check | Action |
| --- | --- | --- |
| Backend 500 `SpacetimeDB … failed` | `spacetime start` running? `SPACETIMEDB_URI`/`SPACETIMEDB_TOKEN` in `.env` | Start it; re-run README setup step 3 if the database is missing |
| `spacetime` command hits maincloud | Missing `--server local` | Always pass `--server local` |
| Menu missing | Hall/date/service filter | Re-upload menu; confirm `MENU_NOT_FOUND` is gone |
| Capture stuck `pending` | Object upload state | Re-run finalize; look for `orphaned` objects |
| `502 STORAGE_UNAVAILABLE` | R2 credentials/bucket in `.env`, Cloudflare status | Fix `R2_*` / `OBJECT_STORAGE_CONTAINER`; retry |
| R2 PUT returns 403 `SignatureDoesNotMatch` | PUT headers | Send exactly the returned `uploadHeaders` and the declared byte count |
| Analysis `failed` | ApiError code | Retry if `retryable` (re-run replay); otherwise needs_review |
| `GEMINI_AUTH_FAILED` | Key in `.env` | Fix `GEMINI_API_KEY`; `cd vision && npm run smoke` |
| `GEMINI_MODEL_NOT_FOUND` | `GEMINI_MODEL` | Use a model the key can access (`gemini-3.8-flash`) |
| Tip says "rule-based (AI unavailable)" | Gemini error/truncation | Reload the meal; fallback tips are retried with Gemini |
| Meal shows "every food estimate was left out" | Exclusion reasons in `/api/dashboard/meal` | Usually `above_baseline`: the reference area is smaller than the plate's estimate — review baselines |
| Replay adds duplicate dishes | `.replay-state.json` deleted without resetting the DB | Reset the demo data (above) |
| Broken image in UI | Read URL expiry | Renew temporary read URL; do not rewrite objectKey |
| Wild waste % | Geometry / baseline | Confirm `topdown-normalized-v1` and baseline > 0 |
| Attendance changes on refresh | Seed / persistence | Attendance must be persisted once per service |

## Do not

- Commit `.env` or real API keys
- Store image bytes in SpacetimeDB
- Present pixel estimates as grams, cost, or environmental impact
- Present simulated attendance as swipe data
