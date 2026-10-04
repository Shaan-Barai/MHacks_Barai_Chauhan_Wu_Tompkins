Web dashboard called **ScrapSaver** that helps dining hall managers and chefs track food left on plates. The users are busy, non-technical kitchen staff. Keep screens simple, numbers big, and words plain. If a feature isn't listed here, leave it out.

## CURRENT MEASUREMENT CONTEXT (2026-10-03)

Use **Pixels wasted** as the primary metric, with units **pixels**. Gemini
classifies the food first; a subsequent segmentation stage produces masks;
application code counts foreground pixels. Totals count overlapping food
pixels once and use compatible normalized image geometry. This replaces
primary servings, serving percentages, piece counts, guessed pixel areas, and
the legacy "waste units" conversion. A percentage share of total wasted pixels
is a breakdown statistic, not percentage of food originally served. Camera
placement/conveyor work is deferred. See `contracts/measurement.md`; runtime
and dashboard migration remain separate implementation work.

## WRITING RULES (2026-10-03)
- Plain words a chef would use. No technical terms on screen (API, pixels, baseline, mask, benchmark, CSV as a noun; say "spreadsheet (.csv)").
- No em dashes, no emoji, and none of: leverage, seamless, robust, unlock, elevate, "in today's fast-paced", "at the end of the day", "in conclusion".
- Brief. Cut text before adding it; not every card needs a paragraph.
- Headings that report a finding are full sentences ("Teriyaki Salmon was the most wasted food at dinner."), not labels.
- No filler screens such as a closing "You're all set" card.
- AI-written suggestions pass through the same rules (dashes and emoji are stripped on display).

## FIRST-TIME SETUP (2 steps, shown once)
1. Dining hall name. Meal times start from defaults (weekdays and weekends) and are edited in Settings.
2. Add menus: pick a date, type foods under Breakfast / Lunch / Dinner, or upload a spreadsheet (.csv). Then go to the Dashboard.

## LAYOUT
[ Left: Nav ] [ Page ]. There is no right-hand panel; day details live on the Schedule page.

### NAV
- Dashboard
- Schedule
- Menus: add a day's menu; a calendar marks days with "No menu".
- Portions served
- Behind the scenes
- Settings

### DASHBOARD
- Three summary cards: Today, This week, This month. Each shows waste units, the average percent of a serving left per plate (clean plates count as 0%, a food left above a full serving counts as 100%), how many plates that averages, and the change from the same days before.
- One chart, one bar per day. Lookback buttons only: Today, Last 7 days, Last 30 days, Last 90 days. No weekly/monthly grouping and no custom date range.

### SCHEDULE
- Month calendar; special events from Settings show on their dates.
- Clicking a day shows that day's meal times and events, then Breakfast | Lunch | Dinner tabs. Each tab: a finding headline (most wasted food), waste units, plates scanned, foods not counted, meal swipes (simulated), the foods left on plates with their share of the meal's waste, and a suggestion labeled "written by AI" or "basic rule, AI unavailable".

### BEHIND THE SCENES
- Pick a date and meal. Every scanned plate photo with the AI's labels: food, units left, percent of a serving, and notes (AI estimate, more than a full serving, not on the menu). Clean plates say so. Photo links are temporary and renewed when they expire.

### SETTINGS
- Hall name.
- Meal times: several named sets (e.g. Weekdays, Weekends), each with the days it covers and Breakfast/Lunch/Dinner hours. Warn about days with no set or in two sets (the first set wins).
- Special events: name, date, from, to (e.g. Football game).
- Download the last 30 days as a spreadsheet.

## COLOR AND TYPE (2026-10-03)
- Black and white only, including form controls. Styling comes later.
- Font: "Times New Roman" (Times, serif fallback) everywhere.
- Body text at least 16px; summary card numbers large (40px+).
- Flat: small 4px corners, black borders, no shadows, no fades.
- The Tailwind token names from the earlier palette are kept so components didn't change; every color token is black or white.

## TECH
- React + Tailwind, with colors mapped to Tailwind theme tokens.
- All mock data in one file so it can be swapped for SpacetimeDB queries later.
