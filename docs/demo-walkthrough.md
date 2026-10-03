# Demo walkthrough

Audience: dining-hall staff or hackathon judges. Goal: show the full Scrap loop without implying live grams, cost, or swipe attendance.

## Before you start

1. Complete [environment-setup.md](environment-setup.md).
2. Prefer **replay** captures labeled as such — do not imply a live conveyor unless hardware is connected.
3. Keep the dashboard copy honest: **AI-estimated leftover area (pixels)** and **simulated attendance**.

## Script (≈5 minutes)

### 1. Context (30s)

> Scrap watches finished plates on the way to dish return. We estimate leftover food as pixel area against an uneaten reference serving, store results, and surface suggestions. Numbers are prototype AI estimates, not weighed food.

### 2. Menu + reference (1 min)

1. Open the dashboard setup / Menus flow.
2. Upload the sample lunch menu for `hall-main` / `2026-10-03` / lunch.
3. Confirm Scrambled Eggs has a reference portion (`expectedAreaPx = 48000` in the vertical-slice fixture).

### 3. Capture / replay (1 min)

1. Replay fixture capture `cap_01J9ABCD` (or upload the matching labeled image).
2. Confirm the image lands in **external object storage** and SpacetimeDB only stores the object reference (`provider` / `container` / `objectKey`).
3. Confirm processing reaches `succeeded` (or an explicit `needs_review` / `failed` with a plain-language error).

### 4. Results (1.5 min)

On the overview:

- Overall observed waste ≈ **31%** for the vertical-slice single-item case (14880 / 48000).
- Top item: Scrambled Eggs.
- Attendance shows **simulated** (example fixture count `742`).
- Per-attendee leftover area is labeled as **observed leftover area per simulated attendee**.

### 5. Suggestion (1 min)

Open Insights and read the grounded recommendation. Point at the supporting metrics (top item share, analyzed vs excluded captures). If Gemini is unavailable, show the labeled **fallback** suggestion state instead of inventing causation.

### 6. Failure honesty (30s)

Optionally open a failed/invalid analysis fixture and show that exclusions are counted — failed plates are **not** zero waste.

## Fixture IDs used in this script

- Scenario: `vertical-slice` → `tests/fixtures/scenarios/vertical-slice.json`
- Contract samples: `contracts/samples.json`

## After the demo

Record anything that diverged from fixtures in [verification-report.md](verification-report.md). Coordinate fixes with the owning agent; Agent 8 does not edit feature modules.
