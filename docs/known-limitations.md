# Known limitations

Honest boundaries for the hackathon prototype. Update as modules land.

## Product

- Leftover amounts are **AI-estimated pixel areas**, not weighed mass, volume, cost, or carbon.
- Attendance is **simulated** in a configurable range; it is not meal-swipe data.
- Camera hardware, conveyor triggers, and plate tracking are out of scope until supplied.
- Gemini confidence is **not** calibrated measurement accuracy.

## Architecture

- Object-storage cloud provider is undecided; `local-dev` is the provisional offline adapter.
- SpacetimeDB module language/version is still provisional (see `contracts/decisions.md`).
- Upload to object storage and SpacetimeDB registration are **separate** steps — not one atomic transaction.

## Verification

- Agent 8 CI currently proves **fixture + formula** agreement only.
- Live API e2e, live Gemini smoke, and live camera tests are documented but not claimed until explicitly run.
- Agent 8 reports defects; feature owners fix their own modules.

## Data / privacy

- Do not commit real diner photos, swipe records, or API keys.
- Treat menu text and model output as untrusted input.
