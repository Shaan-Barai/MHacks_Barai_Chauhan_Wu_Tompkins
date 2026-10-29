# Camera calibration checklist (at the dining hall)

Use this checklist at the hall, with the real C920s camera on the Uno Q board, the laptop, a card and a tape measure. It takes about 15 minutes. The background (what k means, why focus matters) is in [calibration.md](calibration.md).

**Before you start, bring:**
- a card the size of a credit card (85.60 × 53.98 mm). A gift card, hotel key card, library card or expired card works best: **don't use a live payment card.** The photo is uploaded to the project's image storage, so put the card **number side down** either way;
- a tape measure;
- the laptop with this repo, `.env` and the Uno Q SSH key (`~/.ssh/scrap_unoq`, see [ARDUINO.md](ARDUINO.md)).

---

## 1. Mount the camera (once)

- [ ] **Point the lens straight down** at the spot where plates will sit. Check from the side that it is not tilted.
- [ ] **Set the height: 43–45 cm from the lens to the tray surface.**
  - The demo stands are built for this: the printed stand is 44.1 cm, the plywood stand 43.3 cm.
  - The app keeps only the **centre square** of each photo: the middle 1080 × 1080 of the 1920 × 1080 frame.
  - At 45 cm that square covers about **36 × 36 cm** of tray; at 43 cm, about 34 × 34 cm. A 28 cm plate fits with a few cm to spare.
  - **Don't go below about 38 cm**, or a 28 cm plate no longer fits inside the square.
  - These sizes are computed from the camera's nominal focal length (1,360 px at 1920 wide), not measured.
- [ ] **Tighten everything.** After calibration, the camera must not move, tilt or change height. If it does, calibrate again (step 6).
- [ ] **Check the light.** Use even overhead light with no strong glare spot on the tray.

## 2. Start the software (laptop, repo root)

- [ ] Start the local stack: `deploy/local.sh up`. It starts or reuses SAM 2.1 and the backend on `127.0.0.1:8787`.
- [ ] Check it: `deploy/local.sh status`. Every service should be healthy.
- [ ] Find the board's IP on the hall network and check SSH: `ssh -i ~/.ssh/scrap_unoq arduino@BOARD_IP true`. It should return with no error.

## 3. Lock the focus (automatic, but check it)

Autofocus changes the scale between photos, so focus is locked to one fixed value.

- [ ] Use the **default fixed focus**: don't pass `--focus-absolute`, so it is 0 for the calibration and for every scan.
- [ ] If plates look blurry at your height, pick one value, e.g. `--focus-absolute 40` (0–255, steps of 5). Use **that same value for the calibration and every later capture**.
- [ ] **Never use `--no-focus-lock`.** Pound and CO2e estimates are not trustworthy with autofocus on.

## 4. Place the card and take the calibration photo

- [ ] **Remove plates and trays from view.** Lay the card **flat** on the tray, **number side down**, at the **centre** of the camera view.
  - It must be fully inside the centre square, well away from the edges.
  - It must be on the same surface plates sit on: lift a removable tray and the scale changes.
- [ ] Make sure the card **stands out from the tray** (not white on white) and shows **no glare**.
- [ ] Take the photo:
  ```bash
  python3 capture/uno-q/laptop_capture.py --target arduino@BOARD_IP --identity ~/.ssh/scrap_unoq --calibrate
  ```
- [ ] In the output, check that **`Focus:` says locked**, and that the size is 1920 × 1080. The photo goes to `images/arduino-inbox/<id>/`, marked as a calibration frame; it is never counted as a dish.

## 5. Measure it and make it the hall's calibration

- [ ] Run:
  ```bash
  cd capture
  npm run calibrate -- --known-area-cm2 46.21 --reference-label "credit card" --hall hall-main
  ```
  - 46.21 cm² is the area of a standard card. If you used another flat object, type **its** area and name instead.
  - The command uses the newest calibration photo. A `401` means `SCRAP_INGEST_TOKEN` is missing from `.env`.
- [ ] It prints something like this (this example is from the synthetic test image):
  ```text
  reference: "credit card" 46.21 cm² = 38,102 px in a 1024×1024 image
  k = 0.001213 cm² per pixel  (one pixel ≈ 0.35 mm on the tray)
  camera height (f·√k): 44.9 cm  [fx 1,289.7 px, nominal-fov]
  flags: none
  ✓ active calibration for hall-main: cal_01K… (area method)
  ```

## 6. Check that it worked

- [ ] **The flags line says `none`.** Otherwise, fix the cause and go back to step 4:

  | Flag | Meaning | Fix |
  |---|---|---|
  | `reference_not_found` | The card wasn't found | More contrast, less glare, card centred |
  | `reference_touches_edge` | The card is cut off by the frame | Move it to the centre |
  | `reference_low_confidence` | The AI wasn't sure | Better light, plainer background |

- [ ] **The printed camera height matches your tape measure** (lens to tray) **within about 3 cm.**
  - If it is off by more, the card was probably not fully outlined: retake the photo (step 4).
  - The printed height uses the nominal focal length, so a difference of 1–2 cm is normal.
- [ ] **The card's pixel count is in range.** At 45 cm it should be about **38,000 px**; at 43 cm, about **41,600 px**. These are expected values from the nominal focal length. Far fewer pixels means only part of the card was outlined.
- [ ] **Look at the outline.** With `cal_…` = the id printed in step 5:
  ```bash
  curl -s http://127.0.0.1:8787/api/calibrations/cal_…/images | python3 -c "import json,sys; print(json.load(sys.stdin)['overlay']['url'])"
  ```
  Open the printed link (it expires after a while). The outline should follow the card's edges and corners closely, with nothing outside the card.
- [ ] **Confirm it is active:** `python3 demo.py --only calibration` shows the reference, k, the camera height and flags `none`, and ends with **PASS**.
- [ ] **Scan one real plate** the normal way. The plate's foods should now show estimated grams, CO2e and water (labeled estimates). Pixels wasted is unchanged.
  - For the numbers: `python3 demo.py --events cap_… --only area`.

## 7. Calibrate again when

- the camera is bumped, tilted, raised or lowered, or the tray/counter height changes;
- you change `--focus-absolute`, swap the camera, or change the resolution;
- a scan shows `incompatible_geometry`.

Old scans keep the calibration they were measured with, so recalibrating never changes past numbers.

**Write down** for the record: the date, the camera height you measured with the tape, the `--focus-absolute` value, the `cal_…` id, and the printed height and flags.
