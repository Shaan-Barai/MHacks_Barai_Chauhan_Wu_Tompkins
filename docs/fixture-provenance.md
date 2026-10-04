# Fixture provenance

Owner: Agent 8. Fixtures are **synthetic demo data** for verification. They are not measured dining-hall waste.

## Sources

| Asset | Origin |
| --- | --- |
| Entity shapes | [`contracts/types.ts`](../contracts/types.ts) |
| Canonical single-record samples | [`contracts/samples.json`](../contracts/samples.json) (Agent 1) |
| Scenario compositions | [`tests/fixtures/scenarios/`](../tests/fixtures/scenarios/) (Agent 8) |
| Measurement formulas | AGENTS.md §7 |

## Notable numbers

| Value | Meaning |
| --- | --- |
| `expectedAreaPx = 48000` | Hand-chosen uneaten reference area for scrambled eggs in normalized 1024² space |
| `remainingAreaPx = 14880` | Chosen so `14880/48000 = 0.31` exactly for a clean demo percent |
| Attendance `742` | Arbitrary value inside 300–1,200 with seed `demo-seed-1` |
| Hall `hall-main` / TZ `America/Detroit` | Provisional MHacks defaults from decisions.md |

## Modes

Every scenario sets `"mode": "fixture"` today. Live-provider fixtures will be added only when credentials/hardware exist, and will be labeled `live_gemini` / `live_camera` separately.

## Calibration fixture (IT_4, synthetic)

[`capture/fixtures/calibration/credit-card-synthetic.jpg`](../capture/fixtures/calibration/) is a
**synthetic** calibration frame, not a camera photo. No real photo of a card under the C920s exists yet.

- Generator: `capture/scripts/make-calibration-fixture.mjs` (`npm run calibration-fixture` in
  `capture/`), deterministic for a given `sharp` version.
- Background: an empty patch of dark table from `test2/IMG_2704.jpeg` (EXIF-rotated, bottom band
  x 0–2155, y 4500–5712 px, below the plate), resized to the C920s native 1920 × 1080.
- Reference: a light-blue rounded rectangle labeled "SAMPLE CARD · SYNTHETIC FIXTURE" with a fake
  number `0000 0000 0000 0000`, drawn at the size an ID-1 card (85.60 × 53.98 mm, r 3.18 mm) would have
  from **45 cm** with nominal C920s intrinsics (f = 1360.2 px at 1920 wide): 259 × 163 px, corner radius
  10 px, at (830, 720), inside the centre square that normalization keeps.
- Sidecar `credit-card-synthetic.json` gives the drawn geometry and the expected values after
  normalization to 1024²: N_ref ≈ 37,875 px, k ≈ 0.001220 cm²/px, fx ≈ 1289.7 px, geometric height
  ≈ 45.0 cm.
- Live result (2026-10-04, real Gemini + SAM 2.1): N_ref 38,102 px (+0.6%), geometric height 44.9 cm.
  DAv2 read 82 cm (`depth_scale_disagrees`); the image is flat, so the depth number means nothing.
- Used by `simulate-camera --calibrate`, `demo.py --simulate` (calibration step),
  `tests/integration/calibrate-capture.test.mjs` (fake backend) and `tests/e2e/calibration-live.test.mjs`.

## Image bytes

Scenario JSON contains **metadata only**. Demo replay images live in
[`capture/fixtures/replay/images/`](../capture/fixtures/replay/) — six
AI-generated (`gemini-3.1-flash-image`, 2026-10-03) synthetic top-down plates
of demo-seed menu items, no people or real halls. They are uploaded to object
storage by the replay command and are never embedded in SpacetimeDB rows.
