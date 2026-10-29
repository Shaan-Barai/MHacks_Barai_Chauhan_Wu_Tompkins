# Camera calibration

IT_4 (2026-10-04), decisions I1–I3 and I9 in [IT_4.md](plans/IT_4.md) (amended in §10). This page covers
what a calibration is, how to take one with a credit card, and when to redo it. The app uses the **area
method** only; Depth Anything V2 was tried and removed (see the end of this page).

## What it is

**Pixels wasted** remains the stored measurement. A calibration adds an *estimate* of physical size on
top of it:

```text
k (cm² per pixel)       = known reference area (cm², typed by you) / reference pixels N_ref
food area (cm²)         = food pixels × k                      area method (area-calibrated-v1)
camera height (cm)      = f · √k                               f = C920s focal length in px
grams                   = area × weight_g_per_cm2              factors: factors/menu_waste_factors_EastQuad.csv
kg CO2e = grams/1000 × C        L water = grams × W
```

You lay a flat object of known area (default: a credit card, 85.60 × 53.98 mm = **46.21 cm²**) on the
tray where plates sit and take one **calibration frame**. The backend asks Gemini to box the object,
SAM 2.1 segments it, and code counts its pixels `N_ref`.

Rules that keep the numbers honest:

- Grams, kg CO2e and litres are **estimates** and are labeled that way everywhere. Without an active,
  compatible calibration, or without a factor, they are `null` with a reason, **never 0**.
- A calibration holds for **one camera at one height, one focus setting and one image resolution**.
  Captures of a different size are `incompatible_geometry` (their pixels still count).
- The calibration frame goes through the **same normalization as every dish** (centre square crop to
  1024 × 1024, `capture/src/normalize.ts`). Its geometry therefore matches the captures. The C920s
  focal length at that size is ≈ 1289.7 px: 1360.2 px at 1920 × 1080, scaled by 1024/1080.

## Do it with a credit card

1. **Mount the camera** at its final height, looking straight down at the tray. Don't move it afterwards.
2. **Lock focus.** `uno_q_camera.py` does this before every capture with `v4l2-ctl` (see below). Use the
   same `--focus-absolute` for the calibration and every capture.
3. **Place the card** flat on the tray, fully inside the **middle** of the frame (the normalization keeps
   only the centre 1080 × 1080 of a 1920 × 1080 frame). Keep it clear of plates and of the frame edge, and
   avoid glare.
4. **Take the calibration frame** (laptop):
   ```bash
   python3 capture/uno-q/laptop_capture.py --target arduino@BOARD_IP --calibrate
   ```
   This saves one frame to `images/arduino-inbox/<id>/`, marked `capturePurpose: "calibration"`. The
   bridge never counts it as a dish. The command prints the exact upload command.
5. **Upload and measure it:**
   ```bash
   cd capture
   npm run calibrate -- --known-area-cm2 46.21 --reference-label "credit card" [--camera-id uno-q-c920s-1] [--hall hall-main]
   ```
   This runs normalize → presign → PUT → finalize (association kind `calibration`, id = a new
   `cal_<ULID>`) → `POST /api/calibrations` → makes it the hall's active calibration. It prints:
   ```text
   reference: "credit card" 46.21 cm² = 38,102 px in a 1024×1024 image
   k = 0.001213 cm² per pixel  (one pixel ≈ 0.35 mm on the tray)
   camera height (f·√k): 44.9 cm  [fx 1,289.7 px, nominal-fov]
   flags: none
   ✓ active calibration for hall-main: cal_01K… (area method)
   ```
   (That example is the synthetic fixture; see "Without a card" below.) Check the camera height
   against a tape measure from the lens to the tray. If it is off by more than a few cm, the card was
   not fully segmented: retake the frame.
6. **Check the outline** in the dashboard (Settings → Camera calibration). It shows the reference
   outline, k, the camera height and the flags.

Any other flat object works if you know its area: `--known-area-cm2 <cm²> --reference-label "<what it is>"`.

Options: `--frame <captureId>` picks a specific calibration frame (default: the newest),
`--no-activate` measures without activating, `--inbox`/`--state-dir`
as for `ingest-inbox`. A rerun with the same frame, area and label shows the existing calibration. A
different area or label, or a failed one, makes a new calibration.

Remote/production backend: set `SCRAP_API_URL` (https) and `SCRAP_INGEST_TOKEN`; the scripts also read
the token from `.env`, then from `deploy/.run/local-secrets.env`. The token is never printed. A 401 tells
you to set it.

### Without a card (demo, tests)

```bash
cd capture && npm run simulate-camera -- --calibrate [--hall hall-main]
```

This uses `capture/fixtures/calibration/credit-card-synthetic.jpg`, a **synthetic** frame (a drawn card
on an empty table patch; see [fixture-provenance.md](fixture-provenance.md)) drawn for a 45 cm camera
height. It tests the pipeline only and says nothing about real accuracy. `python3 demo.py --simulate`
uses it in its `calibration` step when the hall has no active calibration (`--recalibrate` forces one),
and puts the hall's previous `activeCalibrationId` back when it finishes. `python3 demo.py --simulate
--hall hall-test` does all of this on a test hall, so hall-main is never touched.

## Focus lock (Logitech C920s)

Autofocus changes the focal length, and with it the pixels-per-cm² relation. Before each capture (and
once per `--auto` stream), `capture/uno-q/uno_q_camera.py` runs:

```bash
v4l2-ctl -d /dev/video0 -c focus_automatic_continuous=0 -c focus_absolute=0   # newer kernels
v4l2-ctl -d /dev/video0 -c focus_auto=0 -c focus_absolute=0                   # fallback, older kernels
```

- `--focus-absolute N` (0–255; the C920s steps by 5) sets another fixed focus. Pass the same value to
  `laptop_capture.py` for the calibration and every capture. If 0 (far) looks soft at your height, try
  e.g. 30–60 and recalibrate.
- `--no-focus-lock` leaves autofocus on. Physical estimates are then unreliable.
- The result (`locked` / `failed` / `unavailable` / `disabled`, control used, actual `focus_absolute` read
  back) is stored in each frame's `metadata.json` as `focus` and printed by `laptop_capture.py`. A
  missing `v4l2-ctl` (`sudo apt install v4l-utils`) or a failing control only logs a warning, and the
  capture still happens.
- The bridge warns once per run if a camera frame is not locked, or is locked at a different
  `focus_absolute` than the newest calibration frame in the inbox.

The resolution is fixed at **1920 × 1080** (the C920s native MJPEG mode). The board warns if the camera
delivers another size.

## Recalibrate when

- the camera moves, tilts or changes height, or the tray/table surface height changes;
- you change `--focus-absolute`, turn the focus lock off, or swap the camera;
- you change `--width/--height` (a different resolution makes every capture `incompatible_geometry`);
- the flags show `reference_touches_edge`, `reference_low_confidence` or `reference_not_found`.

Old captures keep the calibration they were analysed with (`calibrationId` is snapshotted on each
analysis attempt), so recalibrating never rewrites history.

## Why there is no depth/volume method (history)

On 2026-10-04 the app briefly had an optional **Depth Anything V2** path (Metric Indoor Small, a
`:8791` worker): heights above a plate plane fitted around the food gave a volume, and grams came from
a per-food density. The user removed it the same day. The record of why:

- On close top-down photos (test2/, camera 22–30 cm above the plate), DAv2 Small read distances 3–5×
  too far (`depth_scale_disagrees`) and put food **at or below the plate surface**, so heights were 0
  and every food fell back to the area method anyway.
- Thin foods (rice spread flat, sauces) are millimetres high, below the depth noise, and bowls hide
  their floor, so volume was unreliable even when depth worked.

What remains is the area method above. Old rows written during the trial are read as area estimates.
The worker, the per-hall depth toggle, plate thickness and the density column are gone;
`deploy/local.sh down` still stops a depth worker that it started earlier.

## Check it

```bash
python3 demo.py --only calibration                 # active calibration: k, camera height, flags
python3 demo.py --events cap_… --only area         # per-food cm² / g / kg CO2e / L + totals and coverage
cd tests && SCRAP_E2E=1 npm run test:e2e:calibration   # live: calibrate a test hall → capture → totals
./test-all.sh --only stack,e2e-calibration         # the same, with the local stack's token
```

## Plate scale (plate-scale-v1, Run 3): estimated pounds without a calibration frame

A second, rougher path to physical units, for scans with no camera calibration. **Pixels wasted is not changed.** Pounds are shown beside it, labeled as an estimate, with the assumptions in the API (`GET /api/dashboard/estimated-weight`) and in the Statistics page tooltip.

```text
plate diameter (px)  = mean of the width and height of the AI's box around the target plate
                       (only a plate, fully in frame, box width/height ratio ≤ 1.25)
cm² per pixel        = (PLATE_DIAMETER_CM / plate diameter px)²       = π(D/2)² / π(d/2)²
grams                = Pixels wasted × cm² per pixel × weight_g_per_cm2 (factors CSV, per food)
pounds               = grams / 453.59237
```

- **Assumption 1:** every plate is `PLATE_DIAMETER_CM` (default **26.7 cm**, a 10.5" dinner plate). Halls use several plate sizes. A 9" (22.9 cm) plate estimated as 10.5" is overstated by (26.7/22.9)² ≈ 1.36×. The value in effect is stored with each scan (`plate_scale_estimate.assumed_plate_diameter_cm`), so changing the setting never rewrites old estimates.
- **Assumption 2:** the plate's size comes from Gemini's box, not a fitted rim, so a loose box shifts the scale.
- **Assumption 3:** food is flat on the plate, and `weight_g_per_cm2` is an average per food.
- Bowls, cut-off plates and oval boxes get **no** scale, with the reason stored. Their pounds are "—", never 0, and coverage says how many plates have a scale.
- The forecast uses these grams for tray waste only when scans cover ≥ 80% of a meal's diners (`forecast/data.py`, `MIN_SCAN_COVERAGE`). Camera-calibrated measurements are preferred when both exist.
- Code: `vision/src/targetDish.ts` (`measurePlate`), `analytics/src/plateScale.ts`, `backend/src/services/impactService.ts` (`estimatedWeight`), and migration `20261028000015_plate_scale.sql`.
- Scans analyzed before this change have no plate record. Re-analysis would add one, but costs Gemini calls.

### Scans analyzed before plate-scale-v1 (Run 4 backfill)

```bash
cd backend && npm run build && node scripts/backfill-plate-scale.mjs --hall hall-main --dry-run    # then without --dry-run
```

- **What it does:** for each visible scan whose counted attempt has no plate row, it re-runs **only Gemini pass 1**. That is the unchanged base prompt the full pipeline takes its dish box from, run on the same stored photo with the attempt's own menu version. It then measures the plate.
- **What it stores:** the row goes on the counted attempt with `box_source = 'backfill-pass1'` (migration `20261028000018`).
- **What it costs and never touches:** one Gemini call per scan, capped by `--max-gemini` (default 10). No new attempt, no SAM and no measurement change, so Pixels wasted cannot move.
- **Run 4 result (2026-10-28, 6 Gemini calls):** all 6 visible hall-main scans got a usable plate (a fully visible round plate, 680–817 px across).
  - Pixel totals are unchanged: 1,531,798 px over all 12 stored attempts, before and after; 748,986 px counted on the dashboard.
  - Estimated food left: about **2.1 lb in total (ESTIMATE)**, assuming every plate is 26.7 cm across.
  - That covers 578,319 of the 748,986 px. The rest (Belgian Waffles, Margherita Flatbread, and food not on the menu) has no grams-per-cm² factor, so it gets no pounds.
