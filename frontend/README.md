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

First launch shows the 2-step setup (hall name, then menus; meal hours start
from defaults and are edited in Settings);
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

## Dashboard (UI.md, BIG-PLAN v2)

Pixels only, relative impact: there are no grams, kg, litres, cubic meters,
CO2e or dollars anywhere. Top to bottom, all driven by the lookback buttons:

1. One-line "how we measure" note (the AI outlines the leftover food on the
   plate being scanned and counts its pixels; impact points weight pixels by
   each food's density and greenhouse-gas / water footprint; relative, not a
   scale reading).
2. Two headline cards: **Total waste** (Pixels wasted, unit "pixels", "from X
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
