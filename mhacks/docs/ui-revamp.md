# Scrap Saver UI revision

The dashboard uses Times New Roman with black and white styling. Technical setup language, emojis, em dashes, the right sidebar, and the closing filler are removed. Page headlines state what the screen shows. The last dashboard section provides a downloadable daily report; the chart includes its data source.

## Behavior

- Dashboard plots daily averages only. Lookbacks are one day, 7, 30, or 90 days, ending on the chosen date. Missing dates are blank, not zero.
- Today, week, and month mean the fixture's last date, trailing 7 days, and trailing 30 days. Available-day counts disclose limited coverage.
- Each eligible nonempty plate contributes `100 * sum(remainingAreaPx) / sum(baselineAreaPx)`. Confirmed successful clean plates contribute 0%. The displayed metric is the arithmetic mean across eligible plates, not the average of daily means.
- Failed, review, incomplete, invalid, above-baseline, and contradictory empty-plate readings are excluded from the plate average. A clean plate without measurements creates no menu servings or invented baseline. Existing serving area-weighted `wastePercent` remains a separate analytics result.
- Schedule contains a calendar. Selecting a day and meal changes the recommendations and supporting plate/food counts together. Missing data gives an actionable empty state. Suggestions remain labeled demo suggestions; no live Gemini request is made.
- Food rankings use menu display names. Legacy item IDs with a food slug after `+` have a readable fallback; joins and stored IDs are unchanged.
- Settings support recurring schedules with selected weekdays and named events on specific dates. Each can have additional meals. An event replaces that date's recurring hours. Overlapping recurring days, duplicate dated events, invalid dates, and reversed times cannot be saved.
- Hall/settings and manually entered menus persist locally. No backend settings or menu persistence is implemented. New local menus do not rewrite historical fixture calculations. Historical captures retain their original meal membership when hours change.

## Changed files and interfaces

- `frontend/App.tsx`, `main.tsx`, `helpers.ts`, `styles.css`, `index.html`, `tsconfig.json`: dashboard, calendar, schedules, menu editing, local persistence, readable names, loading/retry state, and simple styling.
- `analytics/demo.ts`: `Summary` adds `averagePlateWastePercent`, `averagedPlates`, `cleanPlates`, and `excludedPlates`; `groupTrend` takes services only and always groups by local date. Suggestions are shorter.
- `contracts/schedule.ts`: browser-local meal-time, recurring schedule, event, and hall-settings contracts. `contracts/decisions.md` records the product choices and sequential ownership.
- `scripts/build-ui.mjs` and `serve-ui.mjs`: bundle plain CSS, preserve `/styles.css` compatibility with the existing preview, and serve only built assets. External font access is removed from the server policy.
- `tests/integration/demo.test.ts`: hand-calculated plate averages, missing coverage, readable names, schedule precedence, validation, and reload contracts. Root README links this handoff and the startup commands.

## Verification

- 14 focused integration tests passed, including `(50% + 10% + 0%) / 3 = 20%`; the separate area-weighted result remains 14% in that example.
- Root, frontend, and SpacetimeDB TypeScript checks passed; the static preview build passed.
- Browser checks: daily graph at 1 and 30 days, day selection with no readings, meal-specific rankings, a football game with two time slots, settings surviving refresh, and 390-pixel calendar/settings layouts without page overflow. The temporary test event was removed after verification.
- Data remains synthetic, with stable simulated attendance. No live camera, Gemini, R2, or application database persistence was tested by this UI assignment.

The preview can be rebuilt using `npm run build:ui`. Existing servers read the rebuilt assets; no provider setup is needed. Public-link lifecycle and provider integration remain outside this assignment.
