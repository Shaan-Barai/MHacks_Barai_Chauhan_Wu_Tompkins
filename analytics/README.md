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

## Waste impact and waste per portion (BIG-PLAN D2, D3, D5)

`src/wasteImpact.ts`, pure. Grams and impact are labeled **estimates**; Pixels wasted stays the raw measurement.

- `computeWasteImpact(pixels, calibration, factor, nutrition, { unknownItem? })` returns a contract `WasteImpact`:
  `cm² = px × cm2PerPx`, `g = cm² × weightGPerCm2`, then `kg × C`, `kg × W` and `kg × impactUsdPerKg` (0.19·C + 1.50·W).
  `nutrientDaysLost = kg × nutrientDaysPerKg` is reported separately and never added to `impactUsd`.
  The `unavailableReason` precedence is `unknown_item` (area kept), then `no_calibration`, then `no_factor` (area kept).
- `sumImpacts(list)`: `pixels` sums every input. Each estimate field sums only the inputs that have it, and is null only when no input has it.
  Unavailable inputs are never counted as zero. `impactCoverage(list)` counts them by reason.
- `buildImpactDashboard(input)` returns the contract `ImpactDashboard`. It has one row per food seen in the window. A food served on several days is grouped by factorKey, and its `itemId` is the latest one.
  The unknown-food row has `itemId: null`. Per portion is computed as Σ grams ÷ Σ portions over the (service, menuVersion, item) snapshots that contributed measurements.
  A missing or ambiguous snapshot makes `portionsServed` null. A zero count makes `perPortion` null. Gram/$ rates require every photo in the row to have grams.
  `targets` holds named foods ordered by grams per portion. `mostWasted` holds all rows ordered by total grams, then pixels.
  Factor tables come in through `factors: { findWasteFactor, findNutritionFactor }` (from `scrap-data`).
- `selectImpactMeasurements({ services, captures, measurements, menuItems })` chooses eligible mask measurements with `validMaskCount` and returns the capture counts.

## AI recommendation (BIG-PLAN D8)

`src/recommendation.ts`: `recommendationFacts(dashboard)` produces compact facts plus `allowedMetrics`, the exact metric strings the dashboard shows, e.g.
`Ancho Flank Steak: 5.2 g wasted per portion`. `buildRecommendationPrompt(facts)` asks for JSON.
`generateRecommendation(gateway | null, dashboard, now)` validates the model output. It requires 2–4 bullets, each citing an allowed metric, with no causal claims and no markdown.
Otherwise it returns `fallbackRecommendation(dashboard, now)` (`source: 'fallback'`). `inputVersion = impact-rec-v1|waste-factors-v2|<facts hash>`.

## Handoff

- **To Agent 5:** import `@scrap/analytics` (or relative `analytics/src`) for summary,
  attendance, and insight payloads matching `contracts/types.ts`.
- **To Agent 7:** use `labels` on `ServiceSummary` for plain-language metric copy.
- **To Agent 8:** unit tests under `analytics/test/` cover hand-calculated aggregate cases.
