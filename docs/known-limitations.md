# Known limitations

Honest boundaries for the hackathon prototype. Update as modules land.

## Product

- Leftover amounts are **AI-estimated pixel areas**, not weighed mass, volume, cost, or carbon.
- Attendance is **simulated** in a configurable range; it is not meal-swipe data.
- Camera hardware, conveyor triggers, and plate tracking are out of scope until supplied.
- Gemini confidence is **not** calibrated measurement accuracy.

## Architecture

- Images go to Cloudflare R2 (`OBJECT_STORAGE_PROVIDER=r2`); `local-dev` (backend filesystem) remains for offline runs and tests.
- SpacetimeDB runs locally (standalone); no hosted deployment. Reducers have no caller auth — the backend is the only intended client on a trusted machine.
- The dashboard reads through the backend API (polling on navigation), not live SpacetimeDB subscriptions.
- Two §7 summary implementations exist (backend `SummaryService` for `/api/dashboard/summary`, analytics for the UI endpoints); both are checked against hand calculations.
- Upload to object storage and SpacetimeDB registration are **separate** steps — not one atomic transaction.

## Verification

- CI proves fixture/unit agreement only (no key or database in CI).
- Live Gemini smoke and live API e2e were run by hand on 2026-10-03 (see verification-report.md). Camera hardware is untested.
- Demo images are AI-generated synthetic plates and demo baselines are hand-assigned: live estimates often exceed the baseline and are excluded as `above_baseline`. The numbers show the pipeline works, not real-world accuracy.
- Agent 8 reports defects; feature owners fix their own modules.

## Data / privacy

- Do not commit real diner photos, swipe records, or API keys.
- Treat menu text and model output as untrusted input.
