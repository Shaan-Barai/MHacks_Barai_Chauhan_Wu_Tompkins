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
npm test          # vitest (data layer, formatting, dashboard sections, gallery, recommendation)
```

First launch shows the 3-step setup (hall name + meal hours, menus, done);
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
  Dashboard endpoints (BIG-PLAN D2-D8, shapes in `contracts/types.ts`, local
  copy in `src/data/types.ts`):
  - `GET /api/dashboard/impact?hallId&start&end` -> `ImpactDashboard`
  - `GET /api/recommendation?hallId&start&end` -> `Recommendation`
  - `GET /api/captures?hallId&start&end` -> `CaptureListItem[]` (bare array or `{ captures }`)
  - `GET /api/captures/:eventId/images` -> `CaptureImages` (short-lived links)
  - `GET /api/dashboard/daily` for the chart (uses `grams` per day when the
    backend sends it, otherwise Pixels wasted)
  All totals, grams, CO2e, water, impact $ and rankings are computed
  server-side by `analytics/`; components only format them.
- **`src/data/mockApi.ts` + `mockData.ts`**: deterministic demo data (seeded
  PRNG) for offline demos: `VITE_USE_MOCK=1 npm run dev`. The impact demo uses
  the 23 dinner foods and factors from `menu_waste_factors.csv`, seeded demo
  portions, one menu item with no factor, one food with no portions entered, an
  unknown-food bucket, and recent plates with generated SVG photo / outline
  images (data URLs, nothing large committed).

## Dashboard (UI.md)

Top to bottom, all driven by the lookback buttons:

1. One-line "how we measure" note (AI outlines of visible leftovers -> grams via
   plate size + per-food weight; estimates, not a scale reading).
2. Four headline cards, each marked "estimate": **Total waste** (est. g/kg,
   with measured Pixels wasted and plate coverage under it), **Greenhouse
   gases** (kg CO2e), **Freshwater** (L or m3 + litres), **Waste impact** ($,
   0.19 x CO2e + 1.50 x water, explained in the "?" tip). Unavailable values say
   "Not available", never 0.
3. **What to try next**: recommendation text + bullets with their supporting
   metric, "AI" / "Rule-based fallback" badge, generated time.
4. **Foods to target** (grams per portion, with pixels and $ per portion,
   portions served + "demo numbers" badge) beside **Most wasted** (bar list by
   est. grams with CO2e and water). Unrankable foods are listed with the reason.
5. Daily chart (grams when supplied, pixels otherwise).
6. **Plates** gallery: thumbnail grid of recent captures; opening one shows the
   photo and the AI outline image side by side or one at a time, plus a
   per-food table (Pixels wasted, est. grams). Failed / needs-review /
   processing / clean plates are explained. Expired or broken links are
   renewed once via `/api/captures/:id/images`, then "Photo unavailable".
7. **Nutrition lost**: separate dashed card, "not part of the impact score".

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
  unscaled in pixels; the legacy "waste units" conversion is gone. Mock values
  are shaped like mask pixel counts. The tooltip explains it in plain language.
- "Meal swipes" in UI.md maps to the contract's simulated attendance and is
  labeled `simulated` in the UI.
- Summary-card comparisons use the same-length window immediately before the
  card's window (e.g. week-to-date vs the previous week's same days).
- The right panel defaults to lunch selected and stays visible on all pages.
