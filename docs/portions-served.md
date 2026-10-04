# Portions served and pixels wasted per portion

The **Portions served** screen accepts total portions actually handed out for
each food during a selected meal. Include seconds, use a consistent portion
size, and keep prepared quantities and attendance separate.

1. Save the meal menu in **Menu Schedule**.
2. Open **Portions served** and select the date and meal for your configured hall.
3. Enter each food's served count, or download the CSV template, fill it in,
   and upload it. Leave an unknown count blank. Use 0 only when none were served.
4. Save. This replaces the selected meal's counts; repeated saves/imports do
   not add to the counts. CSV imports replace the snapshot too: omitted/blank
   items become missing. Validation errors leave the previous snapshot intact.
5. Read the benchmark and recommendation. Each row shows portions, validated
   observed wasted pixels, pixels/portion, and missing-data reasons.

```text
pixels wasted per portion = observed validated item pixels / actual portions served
```

For example, Food A with 200,000 wasted pixels and 1,000 portions has **200
pixels/portion**. Food B with 100,000 pixels and 100 portions has **1,000
pixels/portion**. B ranks higher for recommendations despite its smaller total.
The stored totals and counts remain available beside the rate.

This controls for the recorded serving volume. It cannot prove dislike or
another cause. AI masks may be inaccurate, and dividing a sample of returned
dishes by full-meal portions understates waste when capture coverage is limited.
Show capture/measurement coverage and compare services only with similar coverage,
image geometry, and portion definitions. Across compatible reporting windows,
sum pixels and portions first, then divide; do not average per-meal rates.

## Availability and current limitation

Missing/zero counts, missing item masks, old menu versions, unresolved item
attribution, or incompatible image geometries make a rate unavailable. A
validated item mask with 0 food pixels and a positive served count gives 0
pixels/portion. An item absent from a plate is not an inferred zero. Unknown
food has no named-item served count and is not ranked. Missing/exceeded
uneaten baselines do not exclude an otherwise valid mask count.

**SAM inference is still pending.** Current live Gemini outputs and mock demo
areas are legacy estimates. They never become a mask-derived per-portion
benchmark. Portion counts can be saved now, and the downstream calculator is
ready for validated mask records. New mock counts are labeled **demo** and
saved in the browser; live counts are persisted through the backend.

## API and storage handoff

- `GET /api/portions-served?hallId=…&serviceId=…`: current menu and counts.
- `PUT /api/portions-served?hallId=…&serviceId=…`: full count snapshot:
  `{serviceId, menuVersion, entries: [{itemId, count: integer | null}]}`.
- `POST /api/portions-served/csv?hallId=…&serviceId=…`, `Content-Type: text/csv`:
  `service_id,menu_version,item_id,portions_served`. Stable IDs/version come from
  the downloaded template; an older/different service is rejected.
- `GET /api/portions-served/benchmark?hallId=…&serviceId=…`: ranked benchmark rows,
  raw pixel totals, served counts/sources, coverage/exclusions, and unavailable reasons.
- `GET /api/dashboard/meal`: includes `portionBenchmark` and its cached
  recommendation. Every item's inputs enter the cache key; corrections trigger
  recalculation. Missing comparable data produces setup guidance, not a guessed rate.

`PortionsServed` persists in SpacetimeDB's `portions_served` table using one
transactional snapshot reducer, or in the existing JSON repository for offline
runs. Earlier menu versions are retained and excluded from the current denominator.
The database follows the official [table](https://spacetimedb.com/docs/tables/)
and [transactional reducer](https://spacetimedb.com/docs/functions/reducers/)
patterns. The module adds a table and optional mask-provenance column. Schema
publication is a separate, authorized setup step; this request does not publish
or migrate a running database.

Mask-count records carry durable external mask IDs, compatible geometry, menu
version, separate classification/segmentation versions, processing version, and
validated exclusive attribution. Vision must validate actual masks, count in
code, and resolve overlap before producing these records. SpacetimeDB receives
small metadata only, never mask bytes. Serving-system integrations, mask
inference, full geometry-group selection, and live provider validation remain open.

## Verification

Focused checks live in `data/test/portionsServed.test.ts`,
`analytics/test/portions.test.ts`, `backend/test/portions.test.ts`, and
`frontend/src/pages/PortionsPage.test.tsx` / `frontend/src/data/portions.test.ts`.
They use synthetic count/provenance fixtures, not live SAM/Gemini measurements.
The arithmetic case above, unavailable states, stale/invalid imports,
replacement semantics, JSON restart persistence, cache correction, and accessible
entry/error states are covered. Run the corresponding package's `npm test`;
build the frontend and type-check the database module before integration.

Verified on October 3, 2026:

- Data package: **30 passed**. Analytics: **34 passed**. Frontend: **26 passed**.
- Backend: **24 passed**, including local HTTP snapshot/correction and mask
  metadata ingestion checks. The live SpacetimeDB round-trip test was skipped.
- Frontend production build, database type check, and `spacetime build` passed.
  Database publication/migration was not performed in this assignment.
- Browser demo: entered and saved synthetic 400/600 counts, saw their **demo**
  labels, and confirmed that legacy areas leave the benchmark unavailable.
  The mobile and desktop layouts were inspected; the layout stacks below the
  desktop breakpoint so the new form remains usable in narrow windows.
- No live SAM, serving-system, or new Gemini recommendation test was run.

The handoff spans shared entity/measurement contracts and recorded decisions;
portion parsing in `data/`; the table/reducer in `db/spacetimedb/`; repository,
ingestion, and dashboard/API changes in `backend/`; benchmark/recommendation
functions in `analytics/`; and the entry, benchmark, data-access, and responsive
layout changes in `frontend/`. The focused tests are listed above. No packages
were added. Remaining work is live schema rollout, vision producing validated
exclusive mask counts, and selecting any existing-system source for served counts.
