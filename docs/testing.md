# Testing the end-to-end pipeline

Everything except the camera tests runs without the board. Run from `tests/`.
Every command builds the packages it needs first.

| Level | Command | Needs | Spends Gemini |
| --- | --- | --- | --- |
| Unit | `npm run test:unit` | nothing | no |
| Integration | `npm run test:integration` | local SpacetimeDB (`spacetime start`) and R2 keys in `.env`; those parts skip with a message if missing | no |
| Image (live) | `npm run test:images` | Gemini key, SAM worker on :8790, R2, local SpacetimeDB | yes, about 2 per photo + 1 |
| Camera | `npm run test:camera -- <stage>` | the board on the network, key login | only in plate / empty / reliability |
| Smoke | `npm run test:smoke` | Google Chrome | no |

`./test-all.sh` (repo root) runs the offline suites in one go; these levels add the
system, live image, camera and dashboard checks. Nothing here touches the real
`scrap` database or the real R2 keys. Tests that need
storage write under an R2 `test/` prefix and delete it afterwards. Tests that
need SpacetimeDB publish a throwaway database (`scrap-test-…`) and delete it.

## Unit

`npm run test:unit` runs each package's own tests plus the db typecheck and the
Python capture tests. The table lists where each requested check lives:

| What | Where |
| --- | --- |
| Score formula, nutrition excluded; `largest_factor` | `data/test/factors.test.ts`, `analytics/test/wasteImpact.test.ts` |
| Waste per portion (pixels per portion, sum then divide) | `analytics/test/wasteImpact.test.ts`, `analytics/test/portions.test.ts` |
| R2 key naming and idempotency | `backend/test/objectKeys.test.ts`, `backend/test/r2Storage.test.ts` |
| Recommendation input building (facts, trend, 2-3 bullets naming the dish) | `analytics/test/wasteImpact.test.ts`, `backend/test/impact.test.ts` |
| Single ingest path, checksums, retries | `capture/test/ingestPhoto.test.ts` |
| Camera config, key-only SSH, C920 node by name, meal from the clock | `capture/test/camera.test.ts` |
| Photo quality (size, brightness, sharpness) | `capture/test/imageQuality.test.ts` |
| Sample history and today/week/month totals | `backend/test/demoHistory.test.ts` |

SpacetimeDB reducers run inside SpacetimeDB, so their tests are in the
integration level, on a throwaway database. Calibration (cm² per pixel, the
estimated grams / CO2e / water) is covered by `analytics/test/physical.test.ts`,
the backend calibration tests and `npm run test:e2e:calibration` (live).

## Integration (`tests/system/`)

- `pipeline.test.mjs` uses the real backend, ingest path, storage and
  repository code, with fake Gemini and fake SAM.
  - A simulated device sends every `test2/` photo through `ingestPhoto`. Each
    raw original must be byte-identical in storage, and overlays, masks and
    scan rows must exist.
  - Retries add nothing.
  - Dashboard totals, daily and captures numbers equal the sum of the scan rows.
  - Mocked SSH: the real `take-photo` → `laptop_capture.py` → board script
    runs with only `ssh` and `ffmpeg` faked.
- `r2.test.mjs` does a presigned PUT, finalize (checked in R2), a presigned
  GET with byte comparison, and an idempotent retry under `test/it-…/`. It
  then deletes the prefix and checks it is empty.
- `spacetime.test.mjs` runs on a throwaway database:
  - menu versions
  - capture event updates
  - `scan_info` validation
  - `record_analysis` atomicity
  - portion snapshots
  - `clear_demo_data`
  - the full backend on SpacetimeDB, where totals equal the rows
- `scoring.test.mjs`: the ground-truth scorer reproduces `experiment_summary.csv`.

## Image tests (live)

`npm run test:images` sends all 13 `test2/` photos through ingest, R2,
Gemini (2 passes), SAM 2.1, target-dish counting, the overlay in R2,
SpacetimeDB and the dashboard API.

It checks, per photo:

- the raw photo and overlay are in R2
- the scan is complete
- the pixel count is present

Then, across the run:

- each dish's impact points equal 0.19 × CO₂ points + 1.50 × water points
- totals equal the rows
- a Gemini recommendation is generated and saved
- detections are scored against `ground_truth.csv`

A drop below 100% recall or 92.3% precision is a REGRESSION. The output shows
every failure with its photo name and a running Gemini call count. The report
and overlays are written to `images/live-test/<time>/`. Set `KEEP_LIVE_DATA=1`
to keep the database and R2 prefix for inspection.

## Camera

Run the stages in order. `auto` runs stages 1-6 and stops at the first failure.

| # | Stage | Checks |
| --- | --- | --- |
| 1 | reachable | `CAMERA_HOST:22` answers within 5 s |
| 2 | login | key-only SSH (BatchMode, connect timeout); never prompts |
| 3 | camera | the C920 is found by name in `v4l2-ctl --list-devices`; MJPG 1920x1080 offered |
| 4 | tools | ffmpeg / fswebcam / v4l2-ctl / python3 and the board script (installs nothing) |
| 5 | capture | 1920x1080 JPEG after ~2 s warmup (~60 frames); brightness and sharpness thresholds |
| 6 | transfer | SHA-256 of the photo on the board equals the copy here; transfer time |
| 7 | plate | a plate of food: full flow, same checks as the image tests; original + overlay saved for review |
| 8 | empty | nothing under the camera: completes with zero dishes and no waste rows |
| 9 | reliability | 5 captures in a row: success rate and average trigger-to-dashboard time |
| 10 | cleanup | deletes this run's capture bundles on the board, the R2 `test/camera-…/` prefix and the throwaway database |

Local copies of the photos and overlays stay in `images/camera-test/<run>/`.
Foods on a test plate that are not on the dinner menu can be added for the run with
`CAMERA_EXTRA_FOODS="Halal Rice,Tomato,Lettuce"`, and `CAMERA_EXPECT_FOODS` (same format)
makes the plate stage compare detections against what is really on the plate.
Camera calibration itself (a known-area reference under the camera) is a separate
flow: `cd capture && npm run calibrate` and `npm run test:e2e:calibration`.

## Smoke

`npm run test:smoke` starts the backend (offline vision, three `test2/` photos)
and the real dashboard. It checks the page in Chrome:

- total waste
- the per-portion table
- the most-wasted ranking toggle
- the original and overlay images loaded
- the recommendation

The screenshot goes to `images/smoke/dashboard.png`. To check a running
dashboard instead, run `SMOKE_URL=http://localhost:5173 npm run test:smoke`.
