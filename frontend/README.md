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

Reads are public; changes need **staff sign-in** (IT_4 I11): the nav's
"Staff sign-in" posts the passcode to `POST /api/auth/login` and the backend
sets an httpOnly session cookie (`GET /api/auth/me`, `POST /api/auth/logout`).
Signed out, write controls are hidden or disabled with a "Sign in to change
this." hint; any 401 from a change opens the sign-in dialog. In mock mode the
passcode is `scrapsaver` (shown in the dialog). A backend whose `/api/auth/me`
says `authRequired: false` (or has no auth route) leaves editing open.

First launch for signed-in staff shows the 2-step setup (hall name, then menus; meal hours start
from defaults and are edited in Settings; visitors skip it);
completion is persisted to `localStorage` (`scrap.hallSettings.v1`). To see
setup again, clear site data or run
`localStorage.clear()` in the console.

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
  the 26 dinner foods and factors from `menu_waste_factors.csv` (points =
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
  46.21 cm²), Depth Anything V2 toggle (`PUT /api/settings/measurement`
  `depthEnabled`), calibration photo upload (`POST /api/images/uploads`
  with `associationKind: 'calibration'` -> PUT -> finalize ->
  `POST /api/calibrations`), result with the reference outline
  (`GET /api/calibrations/:id/images`), cm²/px, camera height from the photo
  vs Depth Anything V2, flags in plain words, Activate, history, plate
  thickness. Processing calibrations are polled every 2 s.
- **Food labels**: `38 g · 1.1 kg CO2e · 18 L water est.` chips with inline
  SVG cloud/droplet icons, rounded like analytics' overlay label (whole
  grams; CO2e and litres to 2 significant digits; CO2e in g below 0.1 kg).
  Missing = a muted reason or nothing, never 0.
- **Headline cards**: Estimated CO2e and Estimated water with calibrated-plate
  coverage and method (area / depth volume / mixed).
- **Mock data**: days over 20 days ago are uncalibrated, days 3-20 ago use
  the area method, the last 3 days depth volume (so Today = volume, 7 days =
  mixed, 30 days = partly calibrated, 90 days = mostly uncalibrated); a
  no-density food, a no-factor food, unknown food, a demo photo at another
  picture size, and four past calibrations (active, heights disagree, no depth
  + card at the edge, failed).

## Dashboard (UI.md, BIG-PLAN v2 + IT_4)

Pixels are the measurement; impact and nutrition are relative points;
grams, kg CO2e and litres of water are labeled estimates from calibrated
plates only. Top to bottom, all driven by the lookback buttons:

1. One-line "how we measure" note (the AI outlines the leftover food on the
   plate being scanned and counts its pixels; impact points weight pixels by
   each food's density and greenhouse-gas / water footprint; relative, not a
   scale reading).
2. Four headline cards (IT_4 added Estimated CO2e and Estimated water between these two): **Total waste** (Pixels wasted, unit "pixels", "from X
   of Y plates scanned", plates not counted) and **Relative impact**
   ("relative points" badge: impactPoints with co2Points and waterPoints
   under it; the "?" tip gives points = pixels/1000 x density x factor and
   0.19 x CO2 + 1.50 x water). Missing points say "Not available", never 0.
3. **What to try next**: recommendation text + bullets with their supporting
   metric, "AI" / "Rule-based fallback" badge, generated time.
4. **Foods to target** (Pixels wasted per portion, impact points per portion,
   portions served + "demo numbers" badge) beside **Most wasted** (bar list by
   pixels with each food's impact / greenhouse-gas / water points).
   Unrankable foods are listed with the reason.
5. Daily chart: Pixels wasted per day.
6. **Plates** gallery: thumbnail grid of recent captures (pixels wasted per
   plate); a note when `coverage.capturesWithNeighborFoodExcluded > 0` ("Food
   on neighboring plates was left out of N plates"); opening one shows the
   photo and the AI outline image side by side or one at a time, plus a
   per-food Pixels wasted table. Failed / needs-review / processing / clean
   plates are explained. Expired or broken links are renewed once via
   `/api/captures/:id/images`, then "Photo unavailable".
7. **Nutrition lost**: separate dashed card, relative nutrition points, "not
   part of the impact score".

Schedule, Menus, Portions served, Behind the scenes, and Settings pages are
unchanged.

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
- There is no right-hand panel; day details live on the Schedule page.
