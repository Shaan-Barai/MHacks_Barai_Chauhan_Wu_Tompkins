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

`src/wasteImpact.ts`, pure. **Pixels wasted** is the measurement and the headline unit. Points are never kg,
litres or dollars. Estimated grams / kg CO2e / litres exist only for camera-calibrated captures (IT_4, next section).

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

## Estimated grams, kg CO2e and water (IT_4 I7/I8)

`src/physical.ts` + `src/wasteImpact.ts`, pure. Derived at read time from the measurement's stored
`FoodMeasurement.physical` (`PhysicalEstimate`) and the factor row; **always labeled estimates**; Pixels wasted is
unchanged. Missing is `null` with `physicalUnavailableReason`, never 0.

The area comes **only** from the camera calibration: `areaCm2 = pixels × cm2PerPx` of the active
calibration (`reference-area-v1`, known-area reference), stored by the backend on the measurement. Analytics never
derives an area any other way; a measurement without a usable `physical` gets `null` + `no_calibration`.

```text
grams       = areaCm2 × weightGPerCm2        (typical food weight per cm², menu_waste_factors_EastQuad.csv)
kgCo2e      = grams / 1000 × C
waterLitres = grams × W                       (W is m³/kg)
physicalMethod = 'area-calibrated-v1'
```

Reasons, in precedence order: `unknown_item` (unclassified food) → `no_calibration` / `incompatible_geometry` (no
usable estimate on the capture; the second is passed by the caller for a resolution mismatch; an estimate with a
non-finite or negative area counts as absent) → `no_factor` (no usable weight per cm², C or W).

Legacy: rows stored during the brief (removed) Depth Anything V2 trial carry method `'volume-dav2-v1'` and
volume/height fields. Any stored estimate with a finite `areaCm2 ≥ 0` is read as the area method and the volume is
ignored (`usablePhysical`, `LEGACY_VOLUME_METHOD`). A legacy attempt snapshot `physicalMethod: 'volume-dav2-v1'` just
means "calibrated".

API for the backend (names and signatures are stable):

| Export | Use |
| --- | --- |
| `computeWasteImpact(pixels, factor, nutrition, { unknownItem?, physical?, physicalUnavailableReason? })` | `WasteImpact` incl. `grams`, `kgCo2e`, `waterLitres`, `physicalMethod`, `physicalUnavailableReason` |
| `selectImpactMeasurements({ ..., capturePhysical? })` | copies each eligible `FoodMeasurement.physical` onto the output; `capturePhysical: Map<eventId, { physicalMethod: PhysicalMethod \| null, unavailableReason? }>` is the counted attempt's snapshot (`AnalysisAttempt.physicalMethod`; `null` + `'incompatible_geometry'` strips estimates). Returns `physicalCoverage` |
| `buildImpactDashboard({ ..., physicalCoverage? })` | pass `selected.physicalCoverage` (it sees calibrated clean plates). `totals.grams/kgCo2e/waterLitres` sum **calibrated measurements only**; `totals.physicalMethod` is `'area-calibrated-v1'` or `null`; `totals.physicalCoverage = { calibratedCaptures, analyzedCaptures }` |
| `captureItemPhysical({ physical, factor, unknownItem?, captureReason? })` | gallery row: `{ grams, kgCo2e, waterLitres, areaCm2, physicalMethod, physicalUnavailableReason? }` for `CaptureListItem.items[]` (area shown even for unknown food) |
| `formatPhysicalLabel({ grams, kgCo2e, waterLitres }, { estimated = true })` | overlay/label suffix `"38 g · 1.1 kg CO2e · 18 L water (est.)"`, or `null` when grams are unavailable. Rounding: whole grams; CO2e 2 significant digits, in g below 0.1 kg; litres 2 significant digits (`formatGrams`, `formatCo2e`, `formatWaterLitres`) |
| `computePhysicalAmounts`, `physicalImpactCoverage`, `usablePhysical`, `AREA_METHOD`, `LEGACY_VOLUME_METHOD` | lower-level helpers |

Totals and per portion: sums include only calibrated measurements (like points). `perPortion.grams = Σ grams ÷ Σ
portions` only when **every** measurement in the row has grams; a food seen on both calibrated and uncalibrated
plates gets `null`, since partial grams over all portions would understate the rate. When calibrated captures exist
but none has a calibrated measurement (all clean plates), the physical totals are a measured 0.

Worked examples (the unit tests in `test/physical.test.ts`):
- Area: Ancho Flank Steak, 20 cm² × 1.2 g/cm² = **24 g** → 24/1000 × 131.69 = **3.16 kg CO2e**, 24 × 1.925 = **46.2 L**.
- Area: Sticky Rice, 25 cm² × 1.6 g/cm² = **40 g** → 40/1000 × 1.78 = **0.0712 kg CO2e** (71 g), 40 × 0.899 = **36 L**.
- Totals for both: **64 g**, 3.16056 + 0.0712 = **3.2 kg CO2e**, 46.2 + 35.96 = **82 L**.
- Per portion across two services (sum then divide): 40 g / 5 portions and 8 g / 2 portions → 48 ÷ 7 = **6.86 g**,
  not the mean of the rates (6).
- Legacy `volume-dav2-v1` row (50 cm³, 40 cm²) for Sticky Rice → area: 40 × 1.6 = **64 g** (the volume is ignored).

## AI recommendation (BIG-PLAN D8, v2)

`src/recommendation.ts`: `recommendationFacts(dashboard)` produces compact facts plus `allowedMetrics`, the exact metric
strings the dashboard shows, e.g. `Ancho Flank Steak: 1,750 pixels wasted per portion`,
`Ancho Flank Steak: 10,500 pixels wasted in total`, `Ancho Flank Steak: 352 relative impact points`.
`buildRecommendationPrompt(facts)` asks for JSON. `generateRecommendation(gateway | null, dashboard, now)` validates the
model output: 2–4 bullets, each citing an allowed metric; no causal claims, no markdown, no physical units (kg, grams,
litres, dollars, CO2e) and no bare "points" (always "relative impact points"). Otherwise it returns
`fallbackRecommendation(dashboard, now)` (`source: 'fallback'`). `inputVersion = impact-rec-v2|waste-factors-v4|<facts hash>`.

IT_4: when `totals.physicalCoverage.calibratedCaptures > 0` and estimates exist, `facts.estimated` adds the estimated
totals (grams, kg CO2e, litres, plate coverage, method) and the top 3 foods by kg CO2e, with metric strings such as
`Estimated total: 3.2 kg CO2e (2 of 3 plates calibrated)`, `Estimated total: 82 L water (2 of 3 plates calibrated)`,
`Ancho Flank Steak: estimated 3.2 kg CO2e and 46 L water`. The prompt and system instruction then allow kg / g / litres
/ CO2e only in a sentence that says "estimated" (money is never allowed), and the fallback cites the estimated totals
(`Calibrated plates (2 of 3): an estimated 3.2 kg CO2e and 82 L water.`) plus a bullet on the top CO2e food. That prompt
is versioned `impact-rec-v3-physical` (`recommendationPromptVersion(facts)`); without calibrated plates the facts,
prompt and version are exactly v2.

## Handoff

- **To Agent 5:** import `@scrap/analytics` (or relative `analytics/src`) for summary,
  attendance, and insight payloads matching `contracts/types.ts`.
- **To Agent 7:** use `labels` on `ServiceSummary` for plain-language metric copy.
- **To Agent 8:** unit tests under `analytics/test/` cover hand-calculated aggregate cases.
