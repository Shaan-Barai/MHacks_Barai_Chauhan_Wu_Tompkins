# data — menus, classification vocabulary, reference portions (Agent 2)

Pure, dependency-free validation helpers (AGENTS.md §5 Agent 2, 2.1–2.3, 2.5).
No I/O, no database, no network — Agent 5's backend calls these from its
upload endpoints, Agent 4 consumes the vocabulary, Agents 6/8 consume the seed.
Entity shapes come **verbatim** from `contracts/types.ts`.

Self-contained Node 20+ / TypeScript package; dependencies live in
`data/package.json` only.

## Run

```bash
cd data
npm install
npm test        # build + node --test
npm run seed    # regenerate seed/demo-seed.json (deterministic, byte-identical)
npm run factors # regenerate src/factors.generated.ts from the root factor CSVs
```

## Menu upload formats (UI.md setup step 2 — "Upload menus myself")

Both formats support several days at once and produce the same output:
contract-exact `MenuBundle` records (`{ service: MealService, items: MenuItem[] }`,
the exact body of the backend's `POST /api/menus`), one per hall/date/meal.

### 1. Typed/JSON bundle — `parseMenuUpload(input)`

```json
{
  "hallId": "hall-main",
  "hallTimezone": "America/Detroit",
  "days": [
    {
      "date": "2026-10-03",
      "breakfast": ["Scrambled Eggs", { "name": "Hash Browns", "category": "side" }],
      "lunch": [{ "name": "Tomato Soup", "category": "soup", "description": "Creamy tomato soup" }]
    },
    { "date": "2026-10-04", "dinner": ["Baked Ziti"] }
  ]
}
```

Items are plain names or `{ name, category?, description? }`. A day may carry
any subset of breakfast/lunch/dinner but not none. Duplicate dates, duplicate
items (after slugging), empty names, bad dates, and unknown timezones are
rejected.

### 2. CSV — `parseMenuCsv(csvText, { hallId, hallTimezone })`

```csv
date,meal,item_name,category,description
2026-10-01,breakfast,Scrambled Eggs,entree,"Plain scrambled eggs, standard scoop"
2026-10-01,lunch,Tomato Soup,soup,
2026-10-02,dinner,Baked Ziti,,
```

- Header row required; columns located **by name**, so order is flexible.
  `date` (YYYY-MM-DD), `meal` (Breakfast/Lunch/Dinner, any case), `item_name`
  required; `category`, `description` optional (omit the column or leave cells empty).
- RFC-4180 quoting (commas/quotes/newlines in quotes, `""` escapes), LF or
  CRLF, blank lines skipped, UTF-8 BOM tolerated, 1 MB cap.
- Any malformed row fails the whole upload with its **line number** — no
  silently partial menus. The CSV carries no hall info; the caller supplies it.

All failures throw `DataValidationError` carrying the shared `ApiError`
envelope (`{ code, message, details?, retryable: false }`) with stable
SCREAMING_SNAKE codes and staff-readable messages.

Menu text is untrusted input (working rule 8): validated, whitespace-
normalized, length-capped (name 200 / category 100 / description 2000 chars,
200 items per meal), and treated purely as data.

## Deterministic ID scheme

IDs are pure functions of hall + local service date + meal (+ item name), so
re-parsing the same upload always yields the same IDs; records join by ID,
never display name.

| Record | Pattern | Example |
| --- | --- | --- |
| MealService | `svc_<hallId>_<date>_<meal>` | `svc_hall-main_2026-10-03_lunch` |
| Menu | `menu_<hallId>_<date>_<meal>` | `menu_hall-main_2026-10-03_lunch` |
| MenuItem | `item_<hallId>_<date>_<meal>_<name-slug>` | `item_hall-main_2026-10-03_lunch_tomato-soup` |
| ReferencePortion | `base_<itemId minus "item_">_v<version>` | `base_hall-main_2026-10-03_lunch_tomato-soup_v2` |

Slugs: lowercase, accents stripped, non-alphanumerics collapsed to `-`
("Mac \"n\" Cheese" → `mac-n-cheese`). `_` separates ID fields, so hall IDs
are restricted to `[a-z0-9-]`. Two different names slugging to the same slug
in one meal are rejected with a rename hint rather than silently merged.

**Deviation from `contracts/samples.json`:** the sample `menuId` is scoped per
hall+date, but `MenuItem` joins to its menu by `menuId` alone and each meal
has different items — a date-scoped menuId cannot resolve per-service item
lists unambiguously. This package scopes `menuId` per hall+date+**meal**
(flagged for Agent 1 to reconcile in contracts; `menuId` is an opaque string
in the contract, so consumers are unaffected).

## Timezones

`serviceDate` is the **local** calendar date in `hallTimezone` (validated
IANA name); all timestamps elsewhere are UTC ISO 8601.
`localServiceDate(utcIsoTimestamp, hallTimezone)` is the rule for deciding
which service date a UTC capture belongs to.

## Classification vocabulary (2.2)

```ts
const lookup = findVocabulary(bundles, 'hall-main', '2026-10-03', 'lunch');
if (!lookup.found) {/* explicit absence: lookup.reason, lookup.serviceId */}
lookup.vocabulary.items;   // the ONLY itemIds a classifier may return
lookup.vocabulary.unknown; // the separate unknown/non-menu result (itemId: null)
```

Classification categories come only from the applicable daily menu. Anything
else is the separate `UNKNOWN_RESULT` (`FoodMeasurement.itemId = null`) —
never an invented item. A missing menu is `{ found: false, reason }`, not an
empty vocabulary. `isAllowedClassification(vocab, itemId)` validates Gemini
output (null = unknown is always allowed).

## Reference portions (2.3) and §7.3 geometry

- `validateReferencePortion(record)` — contract-exact checks:
  `expectedAreaPx` finite and > 0 (§7 rule 1 — the waste denominator),
  positive integer `baselineVersion`, geometry in the shared
  `topdown-normalized-v1` space, `source` one of `reference_photo` /
  `manual_area` / `gemini_estimate` (the three stay distinguishable;
  `reference_photo` requires `referenceImageObjectId`).
- `createReferencePortion(existingForItem, input)` — revisions mint a **new**
  `baselineVersion` (+1) and `baselineId`; existing baselines are never
  mutated, so analyses that froze an older version keep resolving it (2.5).
- `resolveReferencePortion(refs, itemId)` — latest version, or an **explicit
  absence** `{ found: false, qualityFlag: 'missing_baseline', reason }`.
  Missing references are never a zero area.
- `checkGeometryCompatibility(observation, reference)` — §7.3: same
  coordinate space, same normalized dimensions, matching plate shape, plate
  diameter within ±5% (configurable). It **reports** mismatches
  (`{ compatible: false, reasons }` → flag `incompatible_geometry`, group
  separately) instead of throwing, including foreign coordinate spaces.

## Menu revisions (2.5)

`planMenuRevision(existingBundle, incomingBundle)` →
`create` | `unchanged` (identical items, any order — idempotent re-upload) |
`revise` (same serviceId/menuId, `menuVersion + 1`). A different hall, date,
or meal is a `SERVICE_MISMATCH` error, never a rewrite. Stored history stays
valid because `AnalysisAttempt` freezes the `menuVersion` it used.

## Waste and nutrition factors (BIG-PLAN D1, D4)

`menu_waste_factors.csv` and `menu_nutrition_factors.csv` (repo root) are the
source of truth. `scripts/generate-factors.mjs` (`npm run factors`) turns them
into `src/factors.generated.ts`; a test fails when the committed module drifts
from the CSVs, and checks `impactUsdPerKg = 0.19*C + 1.50*W` (no nutrition).

| Export | Meaning |
| --- | --- |
| `WASTE_FACTORS: WasteFactor[]` | One contract `WasteFactor` per waste-CSV row (23 dinner foods) |
| `NUTRITION_FACTORS: NutritionFactor[]` | Nutrient-days and kcal per kg, reported separately, never in the score |
| `WASTE_FACTOR_MENU_TEXT` | Gemini visible components/ingredients, allergens, label serving per row |
| `factorKeyFor(displayName)` | `slug(displayName)`: lowercase ASCII, non-alphanumerics -> `-`, trimmed (same as `slugifyName`) |
| `findWasteFactor(name)` / `findNutritionFactor(name)` / `findFactorMenuText(name)` | Lookup by slug; `null` = no factor (show "no impact factor", never zero) |
| `WASTE_FACTORS_VERSION` | `'waste-factors-v2'`, stamped on every derived impact |

## Demo seed — `seed/demo-seed.json`

**DEMO DATA.** 3 days (2026-10-01…03) × 3 meals for `hall-main`
(America/Detroit), 99 items, each with one `manual_area` reference portion in
the shared 1024×1024 `topdown-normalized-v1` geometry (round plate, 900 px
diameter — matching `contracts/samples.json`).

- Breakfast and lunch are fictional menus (5 items each).
- **Every dinner is the test hall's 26-food menu** from `menu_waste_factors.csv`
  (BIG-PLAN D6): `displayName` = CSV `food`, `category` = station,
  `description` = `gemini_visible_components` (Baked Sweet Potatoes has no
  Gemini text, so it uses the earlier hand-written description). Item IDs are
  `item_hall-main_<date>_dinner_<factorKey>`, so `factorKeyFor(displayName)`
  matches the factor table.
- **`portionsServed`**: one `PortionsServed` snapshot row per dinner item
  (69 rows), `source: 'demo'`. Counts are dummy values from a seeded hash
  (`demo-portions-v1`): entrées 120–260, sides 70–170, soup 60–140, desserts
  40–110. `portionsLabel` marks them as DEMO. They pass `parsePortionsServed`
  (which now accepts the `demo` source).

Provenance: menus invented by Agent 2; expected areas hand-assigned per
category (entree ≈ 52 k px, side ≈ 26 k px, soup ≈ 44 k px, …, ±10 %
deterministic per-name jitter) to sit plausibly next to the contract sample
(scrambled eggs = 48 000 px). They are **not measured portions**. The file is
generated deterministically by `src/seed/generate.ts` (`npm run seed`
reproduces it byte-identically); tests assert the checked-in file matches the
generator and validates against this package's own validators.

Shape: `{ label, demo: true, provenance, hallId, hallTimezone, coordinateSpace, menus: MenuBundle[], referencePortions: ReferencePortion[], portionsServed: PortionsServed[], portionsLabel }` —
directly loadable by backend fixtures (`POST /api/menus` /
`/api/reference-portions` bodies), analytics, and integration tests.

## Assumptions (working rule 5)

- `menuId` scoped per hall+date+meal (see deviation note above) — raised to
  Agent 1 for `contracts/samples.json` reconciliation.
- Item identity is per menu: the same dish on two days has two itemIds
  (cross-day comparisons can group by `displayName`/slug in analytics — a
  deliberate Agent 6 concern, not an ID concern).
- Re-slugging collisions and >200-item meals are upload errors, not warnings.
- CSV is capped at 1 MB; larger uploads should be split by week.
- Hall configuration (which halls exist, their timezones) is not owned here;
  parsers take hallId/hallTimezone as caller-supplied context.
