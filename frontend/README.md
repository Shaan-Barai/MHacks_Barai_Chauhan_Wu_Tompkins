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
npm run dev       # http://localhost:5173
npm run build     # tsc -b + vite build (must pass)
npm test          # vitest (data-access layer, severity bands, grouping, cards)
```

First launch shows the 3-step setup (hall name + meal hours, menus, done);
completion is persisted to `localStorage` (`scrap.hallSettings.v1`). To see
setup again, clear site data or run
`localStorage.clear()` in the console.

## Where the data lives — and how to swap it for the backend

- **`src/data/mockData.ts` — ALL demo data.** Deterministic (seeded PRNG keyed
  by date/meal/item), so the demo is repeatable. Waste figures are mock
  AI-style estimates of leftover food area ("waste units", explained via
  tooltips in the UI); attendance/meal swipes are **simulated** and labeled as
  such everywhere, per AGENTS.md §3.7/§7.
- **`src/data/api.ts` — the swap seam.** Components only import from here.
  Each function documents the backend endpoint it stands in for
  (`GET /api/menus`, `POST /api/menus`, `GET /api/dashboard/summary`, …).
  To go live, replace the function bodies with `fetch()` calls (or SpacetimeDB
  subscriptions) and delete `mockData.ts`; `src/data/types.ts` already mirrors
  `contracts/types.ts` conventions (meal labels, local service dates, item
  IDs, simulated-attendance labeling).
- Manager-uploaded menus currently persist to `localStorage`
  (`scrap.userMenus.v1`) and win over mock menus — they become
  `POST /api/menus` later.

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
- Menus page: the same two menu options + a month calendar; days missing a
  menu highlighted in Squash (click to prefill the editor).
- Settings: hall name, meal times, client-side CSV export (last 30 days, one
  labeled row per item/meal/day).
- States & a11y: friendly empty states ("No menu for this day yet. Add one in
  Menus."-style), loading states that keep the previous chart frame, visible
  focus outlines, labeled controls, units + explanatory tooltips on every
  metric, sr-only direction text on deltas.

## Deferred / out of scope here

- Real backend/SpacetimeDB wiring (the `api.ts` seam above) and live
  subscriptions — blocked on integration; mock mode is the demo path.
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
