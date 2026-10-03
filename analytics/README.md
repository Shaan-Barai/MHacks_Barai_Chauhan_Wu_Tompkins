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

## Handoff

- **To Agent 5:** import `@scrap/analytics` (or relative `analytics/src`) for summary,
  attendance, and insight payloads matching `contracts/types.ts`.
- **To Agent 7:** use `labels` on `ServiceSummary` for plain-language metric copy.
- **To Agent 8:** unit tests under `analytics/test/` cover hand-calculated aggregate cases.
