# frontend — Scrap dashboard

Owner: Agent 7. The beginner-friendly dining-manager dashboard specified in
`UI.md` (exact scope: if a feature isn't listed there, it's left out), built
against `contracts/` and the shapes of Agent 5's GET endpoints
(`backend/README.md`). Self-contained Vite + React 18 + TypeScript + Tailwind
package — no root files touched.

## Run

```bash
cd frontend
npm install
npm run dev       # http://localhost:5173 — live data via the backend (start it first)
VITE_USE_MOCK=1 npm run dev   # demo data only, no backend needed
npm run build     # tsc -b + vite build (must pass)
npm test          # vitest (data layer, formatting, dashboard page and sections, gallery, recommendation)
```

Pages (2026-10-04 redesign: Helvetica, no subtitles or helper text, no
visible "Loading" text): `/` landing (ScrapSaver + Get started),
`/dashboard`, `/statistics` (`/schedule` redirects here), `/menus`,
`/portions`, `/behind-the-scenes`, `/settings`. `/admin` is unlisted.

There is no staff sign-in in the UI: every editor is shown. A backend run
without `SCRAP_ADMIN_PASSCODE` is open, so saves just work. When the backend
sets a passcode, a save that comes back 401 opens a small passcode prompt
(`POST /api/auth/login`, httpOnly cookie), and `/admin` unlocks inline with
the same passcode. In mock mode the passcode is `scrapsaver`. Meal times
start from defaults (`scrap.hallSettings.v1` in `localStorage`) and are
edited in Settings; there is no first-run wizard.

## Where the data comes from

- **`src/data/api.ts`**: the only module components import. It forwards to
  `liveApi.ts` by default, or to `mockApi.ts` when `VITE_USE_MOCK=1` (and
  always in unit tests).
- **`src/data/liveApi.ts`**: `fetch` calls to the backend (backend/README.md).
  `npm run dev` proxies `/api` to `http://localhost:8787`
  (`VITE_PROXY_TARGET` to change; `VITE_API_URL` for a non-proxied base).
  Dashboard endpoints (BIG-PLAN v2 §7, shapes in `contracts/types.ts`, local
  copy in `src/data/types.ts`):
  - `GET /api/dashboard/impact?hallId&start&end` -> `ImpactDashboard`
  - `GET /api/recommendation?hallId&start&end` -> `Recommendation`
  - `GET /api/captures?hallId&start&end` -> `CaptureListItem[]` (bare array or `{ captures }`)
  - `GET /api/captures/:eventId/images` -> `CaptureImages` (short-lived links)
  - `GET /api/dashboard/daily` for the chart (Pixels wasted per day)
  All totals, relative points and rankings are computed server-side by
  `analytics/`; components only format them.
- **`src/data/mockApi.ts` + `mockData.ts`**: deterministic demo data (seeded
  PRNG) for offline demos: `VITE_USE_MOCK=1 npm run dev`. The impact demo uses
  the 26 dinner foods and factors from `menu_waste_factors_EastQuad.csv` (points =
  pixels/1000 x weight_g_per_cm2 x factor), seeded demo portions, one menu item
  with no factor, one food with no portions entered, an unknown-food bucket,
  and recent plates with generated SVG photo / outline images (data URLs,
  nothing large committed); one plate per dinner shows a neighboring dish
  outlined as "Other dish (not counted)".

## Production build

`npm run build` writes `dist/`; the backend serves it with an SPA fallback
(`SERVE_FRONTEND=1`), so the dashboard and `/api` share one origin and the
data layer uses relative `/api` URLs (`VITE_API_URL` only for a separate API
origin). Pages have their own paths (`/`, `/schedule`, `/menus`, `/portions`,
`/behind-the-scenes`, `/settings`); any other path shows a 404 page.

## Camera calibration and estimates (IT_4)

- **Settings -> Camera calibration**: known area in cm² (credit-card preset
  46.21 cm²), reference label, calibration photo upload:
  the browser normalizes it like a capture (`topdown-normalized-v1`: centre
  square, 1024 x 1024 JPEG q90, `src/lib/normalizePhoto.ts`), then
  `POST /api/images/uploads` with `associationKind: 'calibration'` and a new
  `cal_<id>` as `associationId` -> PUT -> finalize -> `POST /api/calibrations`.
  The browser PUT goes straight to object storage, so the bucket's CORS must
  allow PUT from the dashboard origin; result with the reference outline
  (`GET /api/calibrations/:id/images`), cm²/px, camera height from the photo,
  `reference_*` flags in plain words (unknown legacy flags are hidden),
  Activate (`PUT /api/settings/measurement` `{ hallId, activeCalibrationId }`),
  history. Processing calibrations are polled every 2 s. Area comes only from
  the calibration; grams = area x the food's typical weight per cm². Depth
  Anything V2 (toggle, depth height, plate thickness, volume) was removed
  2026-10-04.
- **Food labels**: `38 g · 1.1 kg CO2e · 18 L water` chips with inline
  SVG cloud/droplet icons, rounded like analytics' overlay label (whole
  grams; CO2e and litres to 2 significant digits; CO2e in g below 0.1 kg).
  Missing = a muted reason or nothing, never 0.
- **Headline cards**: Estimated CO2e and Estimated water with "From X of Y
  plates (calibrated)"; no method breakdown.
- **Mock data**: days over 20 days ago are uncalibrated, the last 20 days use
  the calibrated area (so Today and 7 days are fully calibrated, 30 days
  partly, 90 days mostly uncalibrated); a no-factor food, unknown food, a demo
  photo at another picture size, and four past 1024 x 1024 calibrations
  (active card at 30,730 px = 0.0015 cm²/px and 50.0 cm, an older card, an
  index card at the edge, failed).

## Dashboard and Statistics

Pixels wasted stay the stored measurement (shown on Behind the scenes); the
dashboard leads with estimated carbon emissions. Grams, kg CO2e and litres
of water come from calibrated plates only and show "—" when unavailable
(never 0). They are not marked "est." in the UI (product owner, 2026-10-04).

- **Dashboard** (Today / This week): cards for Carbon emissions, Water, Food
  wasted (estimates) and Plates scanned; **Carbon emissions by day** chart
  (`GET /api/dashboard/impact/daily`; "Today" charts the last 7 days). No
  camera button: take photos with `npm run take-photo` in backend/.
- **Statistics** (Last 30 / Last 90 days): the same cards and chart,
  **Recommendations** (AI or rule-based fallback badge, each bullet with its
  supporting number, Ask again), **Foods to target** (pixels per portion,
  impact points per portion, portions served, "Demo portions" badge), **Most
  wasted foods** (per portion / total pixels / impact points). Nutrition lost
  was removed from the UI (2026-10-04); the API still returns nutrition points.
- **Behind the scenes** (Today / This week / Last 30 days): the plates
  gallery. Opening a plate shows the photo and AI outlines side by side with
  a per-food Pixels wasted table; expired links are renewed once.

## Deferred / out of scope here

- Live SpacetimeDB subscriptions — the dashboard re-fetches through the
  backend API on navigation instead.
- The menu-API connector is a mock ("Test connection" succeeds without a
  network call) as UI.md specifies.
- Gemini calls from the browser: never — tips come from mock data and are
  labeled AI-generated (Agent 7 boundary; no keys in the client).
- Reference-portion management and a capture upload UI: not in
  UI.md's dashboard scope.

## Assumptions (recorded per AGENTS.md §3.5)

- The primary metric is **Pixels wasted** (contracts/measurement.md), shown
  unscaled in pixels; there is no plate-size calibration (BIG-PLAN v2), so
  pixels are never turned into grams. Impact and nutrition are unitless
  relative points. Mock values are shaped like mask pixel counts. The
  tooltips explain both in plain language.
- "Meal swipes" in UI.md maps to the contract's simulated attendance and is
  labeled `simulated` in the UI.
- Summary-card comparisons use the same-length window immediately before the
  card's window (e.g. week-to-date vs the previous week's same days).
