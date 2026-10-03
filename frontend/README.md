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
npm test          # vitest (data-access layer, severity bands, grouping, cards)
```

First launch shows the 3-step setup (hall name + meal hours, menus, done);
completion is persisted to `localStorage` (`scrap.hallSettings.v1`). To see
setup again, clear site data or run
`localStorage.clear()` in the console.

## Where the data comes from

- **`src/data/api.ts`** — the only module components import. It forwards to
  `liveApi.ts` by default, or to `mockApi.ts` when `VITE_USE_MOCK=1` (and
  always in unit tests).
- **`src/data/liveApi.ts`** — `fetch` calls to the backend's
  `/api/menus*` and `/api/dashboard/{daily,cards,meal}` endpoints
  (backend/README.md). `npm run dev` proxies `/api` to `http://localhost:8787`
  (`VITE_PROXY_TARGET` to change; `VITE_API_URL` for a non-proxied base).
  The UI shows **Pixels wasted** exactly as the backend counts them
  (foreground pixels in AI-generated leftover-food masks; no scaling). All
  shares, totals, and exclusions are computed server-side by `analytics/`.
- **`src/data/mockApi.ts` + `mockData.ts`** — the deterministic demo data
  (seeded PRNG), for offline demos: `VITE_USE_MOCK=1 npm run dev`.
- Menus saved in the UI go to `POST /api/menus/upload` in live mode
  (localStorage only in mock mode).

## Implemented (UI.md)

- 3-step first-time setup, shown once: hall name + editable meal hours;
  "Connect a menu API" (URL/key + mock Test connection) and "Upload menus
  myself" (date, items per meal typed or via CSV, several days at once);
  "You're all set" → Dashboard.
- Three columns: Basil nav (Dashboard/Menus/Settings, cream text) · Oat
  dashboard · Cream right panel with Linen left border.
- Dashboard middle: date picker (presets + from/to; same day = single date,
  default last 30 days), three summary cards (Today / This week / This month,
  Fraunces 44px numbers, ↑/↓ vs the previous same-length period — Basil when
  waste fell, Tomato when it rose), and ONE main chart (Blueberry SVG bars,
  Daily/Weekly/Monthly toggle above it, hover **and keyboard-focus** tooltip
  with exact value + date). Nothing else in the middle column.
- Right panel: "Yesterday, [date]" (or the picked single date);
  Breakfast/Lunch/Dinner tabs; per meal a big waste total, plates scanned,
  meal swipes (simulated badge + tooltip), "Most wasted" with units, share of
  meal waste and a one-line Gemini-styled tip labeled AI-generated, then the
  next 4 items with Sage/Squash/Tomato severity dots (<10% / 10–25% / >25%).
  "Left out of totals" shows plates/items excluded from the numbers (failed,
  needs review, unknown food, above-baseline) — never shown as zero waste; a
  meal whose estimates were all excluded says so. Rule-based tips are labeled
  "rule-based (AI unavailable)".
- Menus page: the same two menu options + a month calendar; days missing a
  menu highlighted in Squash (click to prefill the editor).
- Settings: hall name, meal times, client-side CSV export (last 30 days, one
  labeled row per item/meal/day).
- States & a11y: friendly empty states ("No menu for this day yet. Add one in
  Menus."-style), loading states that keep the previous chart frame, visible
  focus outlines, labeled controls, units + explanatory tooltips on every
  metric, sr-only direction text on deltas.

## Deferred / out of scope here

- Live SpacetimeDB subscriptions — the dashboard re-fetches through the
  backend API on navigation instead.
- The menu-API connector is a mock ("Test connection" succeeds without a
  network call) as UI.md specifies.
- Gemini calls from the browser: never — tips come from mock data and are
  labeled AI-generated (Agent 7 boundary; no keys in the client).
- Reference-portion management, image display, capture upload UI: not in
  UI.md's dashboard scope.

## Assumptions (recorded per AGENTS.md §3.5)

- "Waste units" = observed estimated leftover area (contracts/README.md); the
  mock pre-scales it (≈1 unit per 1,000 px²) to keep demo numbers friendly.
  The tooltip explains the estimate in plain language.
- "Meal swipes" in UI.md maps to the contract's simulated attendance and is
  labeled `simulated` in the UI.
- Summary-card comparisons use the same-length window immediately before the
  card's window (e.g. week-to-date vs the previous week's same days).
- The right panel defaults to lunch selected and stays visible on all pages.
