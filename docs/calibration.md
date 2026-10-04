# Camera calibration

IT_4 (2026-10-04), decisions I1–I3 and I9 in [IT_4.md](../IT_4.md). This page covers what a calibration
is, how to take one with a credit card, and when to redo it.

## What it is

**Pixels wasted** remains the stored measurement. A calibration adds an *estimate* of physical size on
top of it:

```text
k (cm² per pixel)       = known reference area (cm², typed by you) / reference pixels N_ref
food area (cm²)         = food pixels × k                      area method, Depth Anything V2 off
camera height (cm)      = f · √k                               geometric; f = C920s focal length in px
grams                   = area × weight_g_per_cm2              area method
                        = volume × density_g_per_cm3           volume method (DAv2 on, experimental)
kg CO2e = grams/1000 × C        L water = grams × W            factors: menu_waste_factors.csv
```

You lay a flat object of known area (default: a credit card, 85.60 × 53.98 mm = **46.21 cm²**) on the
tray where plates sit and take one **calibration frame**. The backend asks Gemini to box the object,
SAM 2.1 segments it, and code counts its pixels `N_ref`. With the Depth Anything V2 worker running, the
same photo also yields a depth scale and a table plane, so the depth toggle can be switched on later
without recalibrating.

Rules that keep the numbers honest:

- Grams, kg CO2e and litres are **estimates** and are labeled that way everywhere. Without an active,
  compatible calibration, or without a factor or density, they are `null` with a reason, **never 0**.
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
   camera height, geometric (f·√k): 44.9 cm  [fx 1,289.7 px, nominal-fov]
   camera height, Depth Anything V2: 82.0 cm  (scale 0.548, raw median 0.820 m)
   flags: depth_scale_disagrees
   ✓ active calibration for hall-main; Depth Anything V2 OFF (area method)
   ```
   (That example is the synthetic fixture; see "Without a card" below.) Check the geometric height
   against a tape measure from the lens to the tray. If it is off by more than a few cm, the card was
   not fully segmented: retake the frame.
6. **Check the outline** in the dashboard (Settings → Camera calibration). It shows the reference
   outline, k, both heights and the flags.

Any other flat object works if you know its area: `--known-area-cm2 <cm²> --reference-label "<what it is>"`.

Options: `--frame <captureId>` picks a specific calibration frame (default: the newest), `--depth on|off`
sets the toggle at the same time, `--no-activate` measures without activating, `--inbox`/`--state-dir`
as for `ingest-inbox`. A rerun with the same frame, area and label shows the existing calibration. A
different area or label, or a failed one, makes a new calibration.

Remote/production backend: set `SCRAP_API_URL` (https) and `SCRAP_INGEST_TOKEN`; the scripts also read
the token from `.env`, then from `deploy/.run/local-secrets.env`. The token is never printed. A 401 tells
you to set it.

### Without a card (demo, tests)

```bash
cd capture && npm run simulate-camera -- --calibrate [--hall hall-main] [--depth off]
```

This uses `capture/fixtures/calibration/credit-card-synthetic.jpg`, a **synthetic** frame (a drawn card
on an empty table patch; see [fixture-provenance.md](fixture-provenance.md)) drawn for a 45 cm camera
height. It tests the pipeline only and says nothing about real accuracy. `python3 demo.py --simulate`
uses it in its `calibration` step when the hall has no active calibration (`--recalibrate` forces one).

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

## Depth Anything V2 on/off

- **Off (default):** the area method (`area-calibrated-v1`): `area = pixels × k`, grams from
  `weight_g_per_cm2`. It treats food as lying flat on the tray.
- **On (experimental):** each capture also goes through Depth Anything V2 Metric Indoor Small (the
  `:8791` worker). Heights above a plate plane fitted around the food give `volume`, and grams come from
  `density_g_per_cm3`. Foods without a density (pizzas, cheese bread), bowls/liquids
  (`bowl_volume_unreliable`) and invalid depth (`depth_invalid`, `negative_heights_clipped`,
  `depth_unavailable`) fall back to the area method for grams.
- Switch it in the dashboard, with `npm run calibrate -- --depth on`, or with `python3 demo.py --depth on`.
- **Volume is unvalidated.** On close top-down phone photos, DAv2 Small read distances 3–5× too far and
  put food at or below the plate, so foods fell back to area. Keep it off until the live check with the
  mounted C920s and an object of measured volume is recorded in
  [verification-report.md](verification-report.md). See [known-limitations.md](known-limitations.md).

## Check it

```bash
python3 demo.py --only calibration                 # active calibration: k, N_ref, heights, flags, depth on/off
python3 demo.py --events cap_… --only volume       # per-food cm² / cm³ / g / kg CO2e / L for those captures
cd tests && SCRAP_E2E=1 npm run test:e2e:calibration   # live: calibrate → capture (depth off/on) → totals
```
