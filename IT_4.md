# IT_4: production deploy + calibrated area and Depth Anything V2 volume

> **Amendment (2026-10-04, user): Depth Anything V2 is removed.** Everything about depth, volume,
> density, the depth toggle and plate thickness below is superseded. What remains: known-area
> calibration (`reference-area-v1`), grams = area × `weight_g_per_cm2`, and estimated kg CO2e and
> litres of water next to each food label. See §10 and `contracts/decisions.md`.

**Started:** 2026-10-04 · **Branch:** work lands on `main` (each agent works in its own worktree, then
rebases on `origin/main` and pushes) · **Coordinator:** Agent 1 (main session). This file is the live
tracker. The coordinator updates §9 as agents report back.

## 0. Goal (from the user)

Make the MVP production-ready. The two big outcomes:

1. **Deploy the website.** A live demo on a custom domain that is ready to use.
2. **Volume calculations.**
   - The camera first does a **calibration run**: a reference object with a **known area (cm², entered
     by the user)** lies at the bottom of the frame. **Depth Anything V2** then finds the camera's current
     height above that surface.
   - Depth Anything V2 is **optional**. Without it, the reference object's pixel count gives
     **cm² per pixel**, and food area comes from its mask pixels.
   - With it, each capture goes through Depth Anything V2, and the depth map plus the SAM masks give the
     **volume of each food** on the plate.
   - The camera is a **Logitech C920s**. Use its optics where they help.
   - Area and volume feed **CO2 emissions and water wasted**. Those numbers appear **next to each food's
     label** (overlay image and dashboard), and the dashboard shows **total CO2 and total water** wasted.

User decisions (2026-10-04): the user will **buy the domain**. **Update (same day): Fly.io is dropped
for now. SAM 2.1 and Depth Anything V2 run locally on the Mac (MPS)**, along with SpacetimeDB (`scrap`) and
the backend in production mode serving the built dashboard (`deploy/local-up.sh`). The custom domain will
point at this local stack later (Cloudflare Tunnel, documented but not set up yet). Fly/maincloud text below
in I10, §4 row P and §5 is superseded.

## 1. What exists today (v2, `main` @ `4f23615`)

| Piece | State | Where |
| --- | --- | --- |
| Uno Q + C920s → laptop inbox → bridge → R2 + SpacetimeDB `scrap` | live-tested | `capture/`, `BRIDGE.md`, `ARDUINO.md` |
| Gemini classify + boxes → SAM 2.1 (local worker :8790) → target-dish clip → pixel counts → overlay JPEG | implemented | `vision/src/maskPipeline.ts`, `vision/sam/worker.py`, `vision/src/overlay.ts` |
| Relative impact **points** (unitless) from `weight_g_per_cm2`, C, W | implemented | `analytics/src/wasteImpact.ts`, `menu_waste_factors.csv` |
| Dashboard (React + Vite), dev proxy to backend :8787 | implemented, local only | `frontend/` |
| Backend (Express), **no auth, no static serving**, local SpacetimeDB | local only | `backend/src/http/app.ts` |
| Depth / volume | plan only | `AI.md` "Future extension" |
| Deployment | none. No Dockerfiles, no fly config, no CI deploy | — |

## 2. Decisions (coordinator records them in `contracts/decisions.md`)

- **I1. Physical units come back, but only through calibration.** AGENTS.md §2 forbade grams and
  physical amounts "without an independently specified conversion". A camera calibration supplies one:
  a user-measured reference area plus per-food density factors. **Pixels wasted stays the raw stored
  measurement and is always shown.** Physical numbers are labeled **"estimated"** everywhere. Captures
  without an active compatible calibration keep pixels and relative points only, and their physical
  fields are `null` with reason `no_calibration`. Never zero.
- **I2. Calibration = known reference area at the base plane** (`reference-area-v1`). The user lays a
  flat object of known area (default: a credit card, 85.6 × 53.98 mm = **46.21 cm²**; any value can be
  typed) on the tray/table where plates sit and runs a calibration capture. Gemini boxes the reference
  object, SAM 2.1 segments it, and code counts its pixels `N_ref`.
  `k = cm2_per_px = known_area_cm2 / N_ref`. The calibration is tied to one camera and **one image
  resolution**. Captures with a different `widthPx × heightPx` are `incompatible_geometry` for physical
  numbers (pixels still count).
- **I3. Camera height, two ways.** Logitech C920s intrinsics: native 1920×1080, 78° diagonal FOV ⇒
  nominal `f = (√(1920²+1080²)/2) / tan(39°) ≈ 1360 px` at 1920 wide, scaled linearly with width, with
  the principal point at the image centre. Override with `CAMERA_FX_PX` / `CAMERA_FY_PX` (and record
  `source: 'checkerboard'`) if someone measures it.
  - **Geometric** (always): a pixel at distance Z covers `(Z/f)²`, so `Z_cam_cm = f · √k`.
  - **Depth Anything V2** (when enabled): `D_ref` = median metric depth over the reference mask.
    `scale = Z_cam_cm / (100·D_ref)` corrects DAv2's metric output to this camera. Store `scale`, both
    heights, and a least-squares **table plane** `Z(x,y) = a·x + b·y + c` (cm) fitted to the scaled depth
    over the reference and the surrounding empty surface. If the two heights disagree by more than 15%,
    flag `depth_scale_disagrees` (still usable, shown in the UI).
  - **Autofocus changes the focal length.** The C920s capture must lock focus (`v4l2-ctl -c
    focus_automatic_continuous=0 -c focus_absolute=0`, or `focus_auto=0` on older kernels) for both the
    calibration and every later capture. Moving the camera or changing resolution requires a new
    calibration.
- **I4. Depth model.** `depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf` (Hugging Face
  `transformers`). **Small only:** it is Apache-2.0, while Base/Large are CC-BY-NC and not allowed for a
  public deployment. Run it in a new Python worker, `vision/depth/worker.py` (:8791), modelled on the SAM
  worker. One inference per image, upsampled to the exact input size. Output: float32 metres. In R2, the
  depth map is stored as a 16-bit PNG in units of 0.1 mm. Settings version `dav2-metric-small-v1`.
- **I5. Volume (`volume-dav2-v1`).** Per capture, `D(p) = scale · DAv2(p)` in cm.
  - **Plate reference plane:** a robust (median/RANSAC) plane fit to `D` over target-dish-region pixels
    **outside all food masks**. That ring is the plate surface around the food. If fewer than 2% of
    dish pixels are available, fall back to the calibration table plane minus `PLATE_THICKNESS_CM`
    (default 1.5) and flag `plate_plane_from_calibration`.
  - `h(p) = clamp(Z_plane(p) − D(p), 0, MAX_FOOD_HEIGHT_CM=12)`. Clamped pixels flag
    `negative_heights_clipped` or `height_outliers_clipped` when they exceed 5% of the mask.
  - `a(p) = (D(p)/fx)·(D(p)/fy)` cm² footprint.
  - `volume_i = Σ_{p∈mask_i} h(p)·a(p)` cm³, plus `area_i = Σ a(p)`, mean height, and max height.
    Overlaps are counted once (same ownership as pixels).
  - Soup and other liquids in bowls: the bowl floor is hidden, so flag `bowl_volume_unreliable` and use
    the area method for grams (I6).
  - Invalid depth (NaN, out of range, worker down) ⇒ fall back to I6 for that capture and flag
    `depth_unavailable`. Never zero.
- **I6. Area (`area-calibrated-v1`, DAv2 off or as a fallback).** `area_i_cm2 = pixels_i · k`
  (food treated as lying on the base plane).
- **I7. Grams, CO2, water** (derived at read time in `analytics`, like the points):
  - volume method: `grams = volume_cm3 × density_g_per_cm3`. This is a **new column** in
    `menu_waste_factors.csv`, sourced from the FAO/INFOODS Density Database v2 or USDA, with a citation per row.
  - area method: `grams = area_cm2 × weight_g_per_cm2` (existing column).
  - `kg_co2e = grams/1000 × C`, `water_L = grams/1000 × W × 1000 = grams × W` (W is m³/kg).
  - No factor ⇒ `null` (`no_factor`). Unknown food ⇒ `null` (`unknown_item`). Never zero.
  - Relative points and nutrition points stay as they are (nutrition never enters CO2/water).
- **I8. The label.** Next to every food label: overlay JPEG legend rows and dashboard plate/food rows
  show `Ancho Flank Steak · 38 g · 1.1 kg CO2e · 18 L water` (est.), with small cloud/droplet
  icons on the dashboard. The overlay legend uses plain text. Headline cards add **Estimated CO2e** (kg)
  and **Estimated water** (L) totals with coverage ("from 12 of 14 calibrated plates"). Pixels stay in
  the headline.
- **I9. Setting.** Per hall: `depthEnabled` (Depth Anything V2 on/off) and `activeCalibrationId`.
  Calibration always computes the area scale. When the depth worker is reachable it also computes the
  depth scale, so the toggle can be flipped later without recalibrating. The setting is snapshotted onto
  each analysis attempt (`calibrationId`, `physicalMethod`) so history never silently changes.
- **I10. Production shape. SUPERSEDED: the stack runs locally via `deploy/local-up.sh`; the Fly.io notes below are kept only for reference.**
  - `scrap-api` (Node 20): the Express backend, which also serves the built dashboard (`frontend/dist`)
    with SPA fallback. One origin, so there is no CORS between UI and API.
  - `scrap-ml` (Python 3.11, CPU): SAM 2.1 Small (:8790) and DAv2 Metric Indoor Small (:8791) in one
    machine. Weights are baked into the image at build time. It is reachable only on Fly's private
    network (`scrap-ml.internal`), plus a shared-secret header `X-Worker-Token`.
  - **SpacetimeDB → maincloud** (database `scrapsaver`, or a free name if that is taken). Images stay in
    the existing R2 bucket under a `prod/` key prefix (or a new `scrap-images-prod` bucket). Add the prod
    origins to the bucket CORS.
  - Secrets only via `fly secrets set`. **TLS + custom domain** via `fly certs add <domain>` and
    `www.<domain>`, with DNS records at the registrar. Until then: `https://scrap-api.fly.dev`.
  - CI: GitHub Actions deploys both apps on push to `main` after tests pass (`FLY_API_TOKEN` repo secret).
- **I11. Production hardening (backend).**
  - **Reads are public** (the live demo).
  - **Every mutation needs auth**: `Authorization: Bearer $SCRAP_INGEST_TOKEN` for the camera bridge and
    scripts, or an **admin session** for the dashboard. The admin posts `SCRAP_ADMIN_PASSCODE` and gets an
    httpOnly, Secure, SameSite=Strict signed cookie (HMAC with `SESSION_SECRET`, 12 h).
  - Rate limits: a per-IP limit on login, and a cap on Gemini-cost endpoints such as recommendation
    regeneration and captures.
  - `helmet`-style headers, JSON body limits, `/api/health` (liveness) and `/api/ready` (DB, R2 and
    workers reachable), and structured logs with no secrets or signed URLs.
  - Graceful degradation: when the ML worker is down, captures go to `needs_review`/`failed` with a clear
    error, never zero waste.
- **I12. Demo data in prod.** The seed runs once against maincloud (menus, 26-food dinner, demo
  portions, labeled `demo`). Simulated attendance stays labeled.

## 3. Shared contract additions (coordinator → `contracts/types.ts` before fan-out)

Canonical text: `contracts/types.ts` (IT_4 section at the end). Summary:

```ts
export interface CameraIntrinsics {
  cameraModel: 'logitech-c920s' | 'other';
  widthPx: number; heightPx: number;
  fxPx: number; fyPx: number; cxPx: number; cyPx: number;
  source: 'nominal-fov' | 'checkerboard' | 'configured';
}
export type CameraCalibrationFlag =
  | 'reference_not_found' | 'reference_low_confidence' | 'depth_unavailable'
  | 'depth_scale_disagrees' | 'reference_touches_edge';
export interface CalibrationDepth {
  checkpoint: string;              // 'depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf'
  settingsVersion: string;         // 'dav2-metric-small-v1'
  rawReferenceMedianM: number;     // D_ref before correction
  scale: number;                   // Z_cam_cm / (100 * D_ref)
  cameraHeightCmDepth: number;
  tablePlane: { a: number; b: number; c: number };   // Z(x,y)=a·x+b·y+c, cm, pixel coords
  depthObjectId: string;           // 16-bit PNG, 0.1 mm units, in R2
}
export interface CameraCalibration {
  calibrationId: string; hallId: string; cameraId: string;   // cameraId e.g. 'uno-q-c920s-1'
  createdAt: string;
  status: 'processing' | 'succeeded' | 'failed';
  method: 'reference-area-v1';
  imageObjectId: string; overlayObjectId?: string; referenceMaskObjectId?: string;
  widthPx: number; heightPx: number;
  knownAreaCm2: number;            // user input, > 0
  referenceLabel: string;          // e.g. 'credit card'
  referencePixels: number;         // N_ref (integer)
  cm2PerPx: number;                // k
  intrinsics: CameraIntrinsics;
  cameraHeightCmGeometric: number; // f·√k
  depth: CalibrationDepth | null;
  flags: CameraCalibrationFlag[];
  error?: ApiError;
}
export interface MeasurementSettings {          // per hall
  hallId: string; depthEnabled: boolean; activeCalibrationId: string | null;
  plateThicknessCm: number; updatedAt: string;
}
export type PhysicalMethod = 'area-calibrated-v1' | 'volume-dav2-v1';
export type VolumeFlag =
  | 'plate_plane_from_calibration' | 'negative_heights_clipped' | 'height_outliers_clipped'
  | 'bowl_volume_unreliable' | 'depth_invalid' | 'depth_unavailable';
export interface PhysicalEstimate {             // stored on FoodMeasurement.physical (optional)
  calibrationId: string;
  method: PhysicalMethod;
  areaCm2: number;
  volumeCm3: number | null;        // null for area method
  meanHeightMm: number | null; maxHeightMm: number | null;
  depthSettingsVersion?: string;
  plateReference?: 'dish-ring-fit' | 'calibration-plane';
  flags: VolumeFlag[];
}
// Additive fields:
//   FoodMeasurement.physical?: PhysicalEstimate
//   AnalysisAttempt.calibrationId?: string; physicalMethod?: PhysicalMethod; depthObjectId?: string
//   WasteFactor.densityGPerCm3: number | null
//   WasteImpact.grams / kgCo2e / waterLitres: number | null
//   WasteImpact.physicalMethod: PhysicalMethod | 'mixed' | null
//   PerPortion.grams: number | null;  CaptureListItem.items[] + grams/kgCo2e/waterLitres/volumeCm3/areaCm2
//   WasteImpact.physicalUnavailableReason?: 'no_calibration' | 'no_factor' | 'unknown_item'
//                                         | 'incompatible_geometry' | 'no_density'
//   ImpactDashboard.totals: + physicalCoverage { calibratedCaptures, volumeCaptures, analyzedCaptures }
//   image_object association kinds: + 'calibration', 'calibration_overlay', 'depth'
```

**Depth worker API** (`vision/depth/worker.py`, :8791):
`POST /depth {"image_b64"}` → `{widthPx, heightPx, model, checkpoint, device, settingsVersion,
depthF32B64 /* little-endian float32 metres, row-major, widthPx×heightPx */, minM, maxM}`.
`GET /health`. Optional `X-Worker-Token` check when `WORKER_TOKEN` is set (the SAM worker gets the same check).

**HTTP API** (backend; all mutations auth-gated per I11):
| Endpoint | Purpose |
| --- | --- |
| `POST /api/auth/login {passcode}` · `POST /api/auth/logout` · `GET /api/auth/me` | admin session |
| `POST /api/calibrations {hallId, cameraId, imageObjectId, knownAreaCm2, referenceLabel}` | run a calibration on an uploaded (finalized) image → `CameraCalibration` |
| `GET /api/calibrations?hallId` · `GET /api/calibrations/:id` · `GET /api/calibrations/:id/images` | list / detail / signed URLs for photo, reference outline, depth preview |
| `GET /api/settings/measurement?hallId` · `PUT /api/settings/measurement` | `MeasurementSettings` (depth toggle, active calibration, plate thickness) |
| `GET /api/dashboard/impact`, `GET /api/captures` | + grams / kgCo2e / waterLitres / physicalMethod per item, per capture and totals |
| `GET /api/health` · `GET /api/ready` | liveness / readiness |

## 4. Workstreams and ownership

Every agent works in its own git worktree. It commits small verified chunks, then runs
`git fetch origin && git rebase origin/main && <tests> && git push origin HEAD:main`, resolving any
conflicts itself. It never force-pushes and never edits another workstream's paths without a
coordinator handoff. AGENTS.md rules apply. Each commit ends with the `Co-Authored-By` trailer.

| WS | Owns | Deliverables |
| --- | --- | --- |
| **C** coordinator | `IT_4.md`, `AGENTS.md`, `README.md`, `contracts/`, `.env.example`, `contracts/decisions.md` | §3 contracts + I1–I12 decisions before fan-out; AGENTS.md §2/§7 updated for calibrated physical units; final README (prod URL, calibration how-to); tracker |
| **A** factors + analytics | `data/`, `analytics/`, `menu_waste_factors*.{csv,md}`, `menu_nutrition_factors.csv` | `density_g_per_cm3` column for all 26 foods with sources; regenerate `factors.generated.ts`; `computeWasteImpact` adds grams/kgCo2e/waterLitres per I7; totals + physical coverage; per-portion grams; recommendation facts cite estimated CO2/water (labeled) when available; README formula section; hand-calculated unit tests (area method, volume method, missing factor/density, unknown item, mixed calibrated/uncalibrated captures) |
| **V** vision + workers | `vision/` (incl. new `vision/depth/`) | `vision/depth/worker.py` + README (DAv2 Metric Indoor Small, MPS/CPU, `WORKER_TOKEN`; add the token check to the SAM worker too); `vision/src/depthClient.ts`; `vision/src/calibration.ts` (I2/I3: Gemini box of the reference object → SAM → `N_ref`, k, C920s intrinsics helper, geometric height, DAv2 scale + table plane, calibration overlay JPEG); `vision/src/volume.ts` (pure I5/I6 integration over masks + depth + dish region); overlay legend accepts per-bucket suffix text (I8); tests with synthetic depth maps (flat plate + box of known size ⇒ exact volume) and **one live check** on the Mac with a real object of known volume |
| **B** backend + db | `backend/`, `db/` | schema (additive): `camera_calibration`, `measurement_settings`, physical columns on `food_measurement` / `analysis_attempt`, new image association kinds; reducers; calibration + settings endpoints; ingestion runs depth + volume when enabled and stores the depth PNG in R2; impact/captures payloads carry physical numbers and overlay suffixes; **I11 hardening** (auth, sessions, rate limits, headers, `/api/ready`, serve `frontend/dist` with SPA fallback when `SERVE_FRONTEND=1`, `PORT`/`HOST` env, maincloud URI support); tests |
| **U** dashboard | `frontend/`, `UI.md` | Settings → **Camera calibration** panel (known area cm² input with a credit-card preset, Depth Anything V2 toggle, upload a calibration photo or "use latest camera frame", shows the reference outline, cm²/px, camera height geometric vs DAv2, flags, Activate); food labels with grams · kg CO2e · L water chips (I8); headline cards for estimated CO2e + water with coverage; admin login (passcode), with write controls hidden/disabled when logged out; production build (relative `/api`, no dev-only assumptions); mock data first, then the live API; tests |
| **K** capture + E2E + demo | `capture/`, `tests/`, `docs/`, `BRIDGE.md`, `ARDUINO.md`, `CAMERA-GUIDE.md`, `demo.py` | C920s focus lock in `uno_q_camera.py` (+ fixed resolution); `laptop_capture.py --calibrate` and `ingest-inbox --calibrate --known-area-cm2 N` send one calibration frame through upload → `POST /api/calibrations`; the bridge/scripts accept `SCRAP_API_URL` (https) + `SCRAP_INGEST_TOKEN`; `simulate-camera --calibrate` with a fixture calibration photo; E2E for calibrate → capture → volume → dashboard; **demo.py** steps `calibration` and `volume` (and `deploy` that checks the prod URL); docs: calibration walkthrough, known limitations (DAv2 accuracy, bowls, autofocus), verification report with live-vs-fixture split |
| **P** platform / deploy | new `deploy/`, `.dockerignore`, `.github/workflows/deploy.yml`, `fly.*.toml` under `deploy/` | Dockerfiles: `deploy/api.Dockerfile` (multi-stage: build contracts copies, data, vision, analytics, backend, frontend; run backend with `SERVE_FRONTEND=1`) and `deploy/ml.Dockerfile` (python:3.11-slim, CPU torch, sam2 from source, transformers, baked weights, starts both workers); `deploy/fly.api.toml` / `deploy/fly.ml.toml` (health checks, `min_machines_running=1`, ml ≈ shared-cpu-4x / 4 GB, private only); publish the `db/spacetimedb` module to **maincloud** and seed it; R2 prod prefix/bucket + CORS; `fly secrets`; CI deploy workflow; `fly certs` for the custom domain; `docs/deploy.md` runbook (deploy, rollback, rotate secrets, logs); post-deploy smoke script `deploy/smoke.mjs` (health, ready, impact, upload → capture on prod with a test hall that is then hidden) |

**Order**
1. **C** publishes contracts + decisions (gates everyone).
2. **A, V, U, K, P** start in parallel. **B** starts with schema + I11 hardening + endpoint stubs.
   P builds and deploys the *current* app first, which proves the pipeline early.
3. **B** wires V's `calibration`/`volume`/`depthClient` and A's physical impact once they export
   (stubs are allowed earlier).
4. **U** and **K** go live against B. **P** redeploys with the ML image containing DAv2, seeds maincloud,
   and runs the smoke test.
5. The user buys the domain → **P** adds certs + DNS instructions → C verifies `https://<domain>` end to end and
   updates README/AGENTS.

## 5. User actions (blockers the agents cannot do)

1. **Fly.io:** `! brew install flyctl && fly auth login`, with a payment card on the Fly account. The ML machine is
   not free-tier sized.
2. **SpacetimeDB maincloud:** `! spacetime login` (browser), so the module can be published to maincloud.
3. **Domain:** buy it (Cloudflare Registrar is easiest because R2 is already on Cloudflare), then tell the
   coordinator the name. P gives the exact DNS records.
4. **Gemini billing:** must be topped up (BIG-PLAN v2 hit HTTP 402).
5. **CI deploy (optional):** `! fly tokens create deploy | gh secret set FLY_API_TOKEN`.
6. **Calibration photo:** a credit card (or any flat object of measured area) under the C920s for the live
   calibration run.

## 6. Acceptance checks

1. `https://<domain>` (and meanwhile `https://scrap-api.fly.dev`) serves the dashboard over TLS. Reads
   work logged out. Every mutation returns 401 without a token/session.
2. A calibration capture with a known area produces `cm2PerPx`, a geometric camera height and, with DAv2
   on, a depth-derived height and scale. The UI shows both. Values are persisted in SpacetimeDB, and the
   photo, outline and depth map are in R2.
3. With DAv2 **off**, a capture's foods get `areaCm2 = pixels × k`, grams via `weight_g_per_cm2`, and
   kg CO2e + L water. With DAv2 **on**, they get `volumeCm3` from depth + mask, grams via density, and
   CO2/water. Both are labeled estimates, and pixels are unchanged.
4. Synthetic test: a flat plate plus a 5×5×2 cm box ⇒ 50 cm³ ± 1% in `volume.ts` tests. Live test: an
   object of measured volume under the C920s, with the error recorded in `docs/verification-report.md`.
5. The overlay JPEG legend and the dashboard food labels show `g · kg CO2e · L water` next to each food. Headline cards
   show total estimated CO2e and water with calibrated-plate coverage.
6. Missing calibration / density / depth ⇒ `null` + reason, never 0. A mismatched resolution ⇒
   `incompatible_geometry`.
7. `python3 demo.py --simulate --yes` passes, including the new steps. Every package's tests pass. CI deploys on
   push to `main`. `deploy/smoke.mjs` passes against prod.

## 7. Known risks

- DAv2 metric depth at ~40–60 cm on food is unvalidated. The scale correction from the reference fixes
  global scale, not local error, so heights of thin foods (rice spread flat) may be noise-level. That is
  why the area method stays available and is the default until the live check passes.
- CPU inference on Fly: SAM 2.1 Small plus DAv2 Small is a few seconds per capture. That is acceptable for the demo, and
  captures are processed asynchronously.
- maincloud database names are global, so P picks a free one and records it.

## 8. Handoff format (every agent, at the end)

Changed files, commits pushed, contract changes, assumptions, verification (fixture vs live), and
remaining work.

## 9. Status tracker

| WS | State | Last update | Notes |
| --- | --- | --- | --- |
| C | **done** | 2026-10-04 | `d40c771` contracts/decisions; `beda71f` .env.example/README; `5c3a610` volume guard (mean height < 1 mm ⇒ area); demo.py restores hall settings after a simulated synthetic calibration. Final: all suites green, `deploy/local.sh` stack on :8787 from main, smoke 16/16, `demo.py --simulate --yes` 24 PASS / 1 WARN / 0 FAIL |
| A | **done** | 2026-10-04 | `b031707` `b7cd23f` `ca764d5`: density column (26 foods, FAO/INFOODS + USDA, analogues labeled; pizzas + cheese bread null → area method), waste-factors-v3, grams/kgCo2e/waterLitres, coverage, `formatPhysicalLabel`; analytics 74/74, data 39/39 (fixtures). Backend impact test assertion needs B |
| V | **done** | 2026-10-04 | `6fc5d9a` `ea9ebd6` `8afadc5` `369ff6c`; vision 100/100. DAv2 worker live on MPS (~170 ms/1024² warm). Calibration must use the 1024² normalized crop (f ≈ 1289.7 px). **Live on 3 phone photos: DAv2 depth 3–5× too far and food reads at/below the plate ⇒ all foods fell back to area (`depth_invalid`). Volume unvalidated; keep depth off until a C920s known-volume check passes** |
| B | **done** | 2026-10-04 | `05d2fd9` `750c21d` `f33b4f3` `6fcbbcb` `2739f93` `bf2a2ce`; backend 67/67; schema published in place to local `scrap` (no wipe); live prod-mode run on :8797: auth 401s, calibration on K's synthetic card (N_ref 42,516, height 44.8 cm vs 45 designed, `depth_scale_disagrees`), area + volume captures, legend suffix in overlay. Test rows left under `hall-it4-test` |
| U | **done** | 2026-10-04 | `be3636a` `cb31b18` `fea8dfd`; frontend 93/93, build OK. Staff sign-in, calibration panel (browser normalizes to 1024²; DAv2 toggle experimental, off), estimate chips + CO2e/water cards. Live in headless Chrome against `scrap`. Browser calibration upload blocked by R2 CORS (user must apply `deploy/r2-cors.local.json`; the R2 token can't set CORS) |
| K | **done** | 2026-10-04 | `c328260` `e8004fb` `8d091d7` `a22034e` `cf72775` `1c264bb` `53e5324` `27b082e`; capture 53, uno-q 66, tests 22; live calibration E2E 4/4; focus lock verified on the real Uno Q C920 (two v4l2-ctl calls). Board still runs the old camera script (copy per ARDUINO.md §7). No real card calibration yet |
| P | **done** | 2026-10-04 | `f9a7496`: `deploy/local.sh up/down/status/smoke/seed`, `smoke.mjs` 16/16 on test ports (live Gemini+SAM capture on `hall-smoke`), `docs/deploy.md` (tunnel documented only), r2-cors.local.json (not applied). Main checkout still runs the old dev backend on :8787; restart from main after A/V land |

### Final state (2026-10-04)
- Running locally from `main`: SpacetimeDB `scrap` :3000, SAM 2.1 :8790, DAv2 :8791, backend + dashboard :8787 (production mode, auth on). Start/stop: `deploy/local.sh up|down|status|smoke`.
- Tests: data 39, analytics 74, vision 101, capture 53, uno-q 66, backend 67 (+1 opt-in live), frontend 93, tests 22. All pass.
- hall-main: no active calibration, depth off. Physical numbers appear after a real calibration.
- **Open (user):** (1) a real credit-card calibration and a known-volume check under the mounted C920s; DAv2 volume stays experimental until then. (2) Apply `deploy/r2-cors.local.json` to the bucket for browser calibration uploads (the R2 token can't set CORS). (3) Copy the new `uno_q_camera.py` to the board. (4) Domain + Cloudflare Tunnel (`docs/deploy.md`) when wanted.

### Log
- 2026-10-04: plan written. User chose Fly.io and will buy a domain.
- 2026-10-04: coordinator restarted :8787 from main via `deploy/local.sh up` (production mode); smoke 16/16 incl. live Gemini+SAM capture.
- 2026-10-04: V's live check: DAv2 Small doesn't resolve food height on close-up phone photos; area method is the default, depth toggle labeled experimental.
- 2026-10-04: Gemini billing works again (B's live run, no 402).
- 2026-10-04: user: run DAv2 + SAM locally, don't worry about Fly.io. P, B and V redirected.

## 10. Amendment: remove Depth Anything V2, full test, deploy guide (2026-10-04)

| WS | Owns | Task |
| --- | --- | --- |
| **R1** vision + backend + db | `vision/`, `backend/`, `db/` | Delete `vision/depth/`, the depth client, the volume/depth code (keep `computeAreaEstimate`), and the depth part of `runCalibration` and the pipeline. Backend: no depth worker URL, ready check, depth storage, depthEnabled or plateThickness; legacy rows read as area. DB: stop validating and writing depth fields (columns stay, defaults). Tests |
| **R2** data + analytics + frontend | `data/`, `analytics/`, `frontend/`, `UI.md`, factor CSVs + README | Drop the density columns and the volume branch ('mixed', volumeCaptures, no_density). Frontend: remove the toggle, depth height, volume/mixed method text and mocks. Tests |
| **R3** capture + demo + deploy + docs + tests | `capture/`, `demo.py`, `deploy/`, `docs/`, `tests/`, `BRIDGE.md`, `ARDUINO.md`, new root `test-all.sh` | Remove `--depth` flags and the depth service. The demo `volume` step becomes `area`. **`./test-all.sh`** runs every suite, and with `--live` also the stack + smoke + E2E + demo. **`docs/deploy.md`** is a complete step-by-step deploy guide (local stack + Cloudflare Tunnel + custom domain) |
| C | `contracts/`, `IT_4.md`, `AGENTS.md`, `README.md`, `.env.example` | contracts (done first), docs, final verification |

**Status (2026-10-04): done.**
- R1: `6b0e35d` `ac20fdc` `991249f`.
- R2: `e4a8d02` `5f3b410` `1a4efb9` `cd82da5`.
- R3: `94e6145` `5aaeff7` `af84bb6`.
- C: `0ffe459` `c347abe` + README.
- The area comes only from the active calibration (pixels × cm²/px); legacy depth-trial rows are recomputed that way when read.
- `./test-all.sh --install --live` on clean main: **ALL PASSED**, 19 suites in 216 s: data 38, vision 88, analytics 72, capture 53, backend 68 (+1 skip), frontend 95 + build, db, tests 22, python 66, scripts 28, stack, seed, smoke 16, e2e-flow 5, e2e-scrap 8, e2e-calibration 3, demo 21 (+1 skip).
