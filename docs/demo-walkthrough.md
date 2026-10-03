# Demo walkthrough

Audience: dining-hall staff or hackathon judges. Goal: show the full Scrap loop without implying live grams, cost, or swipe attendance.

## Before you start

1. Complete [environment-setup.md](environment-setup.md) and the root README setup (SpacetimeDB, backend, frontend running; demo data seeded and replayed).
2. Captures are **replays** of AI-generated synthetic plates (`capture/fixtures/replay/`) — do not imply a live conveyor.
3. Keep the copy honest: **Pixels wasted** = pixels counted inside AI-drawn masks of leftover food (not grams or servings), and **simulated attendance**. Start the SAM worker before the backend.

## Script (≈5 minutes)

### 1. Context (30s)

> Scrap watches finished plates on the way to dish return. Gemini matches the food to today's menu and estimates leftover area in pixels against an uneaten reference serving; we store the results and surface suggestions. Numbers are prototype AI estimates, not weighed food.

### 2. Menus (1 min)

1. Open **Menus**. The calendar shows Oct 1–3 saved (demo seed) and missing days highlighted in Squash.
2. Click a highlighted day, type a few items under Lunch, **Save this day** — the day turns white. The menu is validated by the backend and stored in SpacetimeDB.

### 3. Capture (1 min)

Run `cd capture && npm run replay` (or show its earlier output). Each plate is normalized, uploaded to object storage, finalized, and submitted; the backend sends it to Gemini with that meal's menu and reference portions. Point out:

- SpacetimeDB holds only the image **reference** (`spacetime sql --server local scrap "SELECT object_key, state FROM image_object"` — private table, owner token required) — never bytes.
- Running replay again says **already ingested**: the same dish is never counted twice.

### 4. Dashboard (1.5 min)

1. **Dashboard → Today**. Summary cards and the chart show today's observed leftover area.
2. Right panel → **Dinner**: Pixels wasted, plates scanned, plates **left out of totals** (failed or partial segmentation), unclassified food pixels, and meal swipes with the **simulated** badge.
3. **Most wasted** item with its share of the meal's waste.

### 5. Suggestion (1 min)

Read the **Gemini tip** under Most wasted. It cites the numbers on screen, mentions limited coverage, and calls it an observed pattern. If Gemini is unavailable the box is labeled **rule-based (AI unavailable)** instead.

### 6. Failure honesty (30s)

Switch to **Yesterday → Lunch**: one plate was scanned, but every estimate was left out, so the panel says so instead of showing zero waste.

## After the demo

Record anything that diverged in [verification-report.md](verification-report.md). Coordinate fixes with the owning agent; Agent 8 does not edit feature modules.
