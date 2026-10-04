# analytics

Owner: **Agent 6** — aggregates, simulated attendance, AI suggestions.

Pure TypeScript library consumed by Agent 5's backend. No HTTP routes here.
Build against `contracts/`; Gemini transport stays in Agent 4's gateway.

## Package

```bash
cd analytics
npm install
npm test
```

## Public API

| Export | Role |
| --- | --- |
| `summarizeService` | Service totals, item comparisons, exclusion counts, attendance-normalized leftover area |
| `buildWasteTrend` | Ordered trend points across services |
| `computeDataVersion` | Stable fingerprint for suggestion cache keys |
| `generateAttendance` / `AttendanceCache` | Reproducible simulated attendance (300–1200 default) |
| `generateInsight` / `InsightCache` | Grounded suggestions via Agent 4 `generateText`, with rule-based fallback |
| `summarizePortionBenchmarks` | Validated observed item pixels / actual portions served; legacy areas cannot enter |
| `generatePortionInsight` / `portionDataVersion` | Recommendation ranking and cache invalidation using per-portion rates |

The dashboard now uses the per-portion recommendation path. `generateInsight`
and the baseline formulas below remain legacy APIs; they do not establish the
new mask-derived benchmark. See [the portion guide](../docs/portions-served.md).

## Formulas (AGENTS.md §7)

```
overall_waste_percent = 100 * sum(remainingAreaPx) / sum(baselineAreaPx)   # eligible only
leftover_per_attendee = observedRemainingAreaPx / attendance.count
```

Excluded from ordinary aggregates (counted, never treated as zero waste):

- captures not in `succeeded` state
- unknown / non-menu items (`itemId === null`)
- missing or non-positive baselines
- `above_baseline` (flag or raw fraction > 1)
- incompatible coordinate spaces

## Attendance

- Source is always `simulated`.
- One value per hall/date/service; persist it — do not re-roll on dashboard reads.
- Bounds: `ATTENDANCE_MIN` / `ATTENDANCE_MAX` (default 300–1200) or explicit `min`/`max`.
- Seed: explicit `seed`, else `ATTENDANCE_SEED|hall|service|date`, else `hall|service|date`.

## Suggestions

Pass Agent 4's `GeminiGateway` (duck-typed `TextGateway`) into `generateInsight`.
On missing gateway or provider failure, returns `source: 'fallback_rules'` text that
still cites the top leftover item, AI-estimate labeling, limited coverage, and
simulated attendance. Cache by `dataVersion` and regenerate when aggregates change.

## Waste impact in pixels and relative impact points (BIG-PLAN v2, V1/V2)

`src/wasteImpact.ts`, pure. **Pixels wasted** is the measurement and the headline unit. There is no plate
calibration and there are no grams, kg CO2e, litres or dollars anywhere in the app.

- `computeWasteImpact(pixels, factor, nutrition, { unknownItem? })` returns a contract `WasteImpact`.
  With `base = pixels / 1000 × weightGPerCm2`: `co2Points = base × C`, `waterPoints = base × W`,
  `impactPoints = base × impactUsdPerKg` (0.19·C + 1.50·W), and `nutritionPoints = base × nutrientDaysPerKg`,
  which is separate and never added to `impactPoints`. Points are **unitless and relative**: they compare foods with
  each other (beef outweighs rice for the same pixels) and are never kg, litres or dollars. Always label them
  "relative impact points". Unknown food → points null with `unavailableReason: 'unknown_item'`; no factor row →
  null with `'no_factor'`. Missing is never 0; a measured clean mask (0 px) scores 0.
- `sumImpacts(list)`: `pixels` sums every input. Each points field sums only the inputs that have it, and is null
  only when no input has it, so a total's points cover the foods with a factor while its pixels cover everything.
  `impactCoverage(list)` counts `withPoints` and the unavailable inputs by reason.
- `buildImpactDashboard(input)` returns the contract `ImpactDashboard`. One row per food seen in the window; a food
  served on several days is grouped by factorKey and its `itemId` is the latest one. The unknown-food row has
  `itemId: null`. Per portion is sum-then-divide: Σ pixels ÷ Σ portions over the (service, menuVersion, item)
  snapshots that contributed measurements (`perPortion = { pixels, impactPoints }`). A missing or ambiguous snapshot
  makes `portionsServed` null; a zero count makes `perPortion` null. `targets` holds named foods ranked by pixels per
  portion (no rate last); `mostWasted` holds all rows ranked by total pixels. `coverage.capturesWithNeighborFoodExcluded`
  counts entries of `attemptQualityFlags` (eventId → counted attempt's flags) carrying
  `NEIGHBOR_FOOD_EXCLUDED_FLAG` (`'neighbor_food_excluded'`, set by vision's target-dish counting).
  `labels = { relativeImpact: true, demoPortions }`. Factor tables come in through
  `factors: { findWasteFactor, findNutritionFactor }` (from `scrap-data`).
- `selectImpactMeasurements({ services, captures, measurements, menuItems })` chooses eligible mask measurements with
  `validMaskCount` and returns the capture counts. Pass `attemptMenuVersions` (eventId → the menuVersion the counted
  attempt froze) so a capture analyzed before a menu revision is validated against, and paired with the portions of, its
  own version; `menuItems` should then include the superseded items too.

Worked example (pepperoni pizza, 10,000 px, 1.0 g/cm², C 16.06, W 1.94, score 5.96): base 10 → 160.6 CO2 points,
19.4 water points, 59.6 relative impact points, 6.9 nutrition points (separate).

## AI recommendation (BIG-PLAN D8, v2)

`src/recommendation.ts`: `recommendationFacts(dashboard)` produces compact facts plus `allowedMetrics`, the exact metric
strings the dashboard shows, e.g. `Ancho Flank Steak: 1,750 pixels wasted per portion`,
`Ancho Flank Steak: 10,500 pixels wasted in total`, `Ancho Flank Steak: 352 relative impact points`.
`buildRecommendationPrompt(facts)` asks for JSON. `generateRecommendation(gateway | null, dashboard, now)` validates the
model output: 2–4 bullets, each citing an allowed metric; no causal claims, no markdown, no physical units (kg, grams,
litres, dollars, CO2e) and no bare "points" (always "relative impact points"). Otherwise it returns
`fallbackRecommendation(dashboard, now)` (`source: 'fallback'`). `inputVersion = impact-rec-v2|waste-factors-v2|<facts hash>`.

## Handoff

- **To Agent 5:** import `@scrap/analytics` (or relative `analytics/src`) for summary,
  attendance, and insight payloads matching `contracts/types.ts`.
- **To Agent 7:** use `labels` on `ServiceSummary` for plain-language metric copy.
- **To Agent 8:** unit tests under `analytics/test/` cover hand-calculated aggregate cases.
