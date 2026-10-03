# Minimal runbook

## Start (fixture-only machine)

```bash
cd tests && npm test
```

Expected: all integration tests pass; e2e live suite skipped unless `SCRAP_E2E=1`.

## Start (full prototype — when published)

1. Load `.env` from `.env.example`.
2. Start SpacetimeDB module, backend API, and frontend (commands TBD in root README).
3. Ensure `.local-storage/` exists and is writable for `local-dev` object storage.
4. Smoke: upload menu → replay one capture → open dashboard overview.

## Recover

| Symptom | Check | Action |
| --- | --- | --- |
| Menu missing | Hall/date/service filter | Re-upload menu; confirm `MENU_NOT_FOUND` is gone |
| Capture stuck `pending` | Object upload state | Re-run finalize; look for `orphaned` objects |
| Analysis `failed` | ApiError code | Retry if `retryable`; otherwise needs_review |
| Broken image in UI | Read URL expiry | Renew temporary read URL; do not rewrite objectKey |
| Wild waste % | Geometry / baseline | Confirm `topdown-normalized-v1` and baseline > 0 |
| Attendance changes on refresh | Seed / persistence | Attendance must be persisted once per service |

## Do not

- Commit `.env` or real API keys
- Store image bytes in SpacetimeDB
- Present pixel estimates as grams, cost, or environmental impact
- Present simulated attendance as swipe data
