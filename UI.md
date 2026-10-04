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

## WASTE IMPACT (2026-10-03, BIG-PLAN D1-D8)

Pixels wasted stays the measured value. With a plate-size calibration and a
typical weight per area for each food, the dashboard also shows **estimated
grams**, greenhouse gases (kg CO2e), freshwater (litres / cubic meters) and a
**Waste impact** dollar value = $0.19 per kg CO2e + $1.50 per cubic meter of
water. Every one of these is labeled "estimate"; none is a scale reading or
the food's cost. Nutrition lost is shown on its own and is never part of the
impact score. Portions served that are demo numbers are labeled "demo numbers".
On screen, say "the AI outlines the leftover food" rather than mask or
segmentation; "Pixels wasted" is the one technical label kept.

## WRITING RULES (2026-10-03)
- Plain words a chef would use. No technical terms on screen (pixels, baseline, mask, benchmark, CSV as a noun; say "spreadsheet (.csv)").
- Exception: the menu "API" option keeps that word, with a "?" that explains it in plain words.
- No em dashes, no emoji, and none of: leverage, seamless, robust, unlock, elevate, "in today's fast-paced", "at the end of the day", "in conclusion".
- Brief. Cut text before adding it; not every card needs a paragraph.
- Headings that report a finding are full sentences ("Teriyaki Salmon was the most wasted food at dinner."), not labels.
- No filler screens such as a closing "You're all set" card.
- AI-written suggestions pass through the same rules (dashes and emoji are stripped on display).

## FIRST-TIME SETUP (2 steps, shown once)
1. Dining hall names: one box to start, and "Add another location" adds another box (each extra box can be removed). Meal times start from defaults (weekdays and weekends) and are edited in Settings.
2. Add menus: pick a date and "Repeat:" (Never, Every day, Every week, Every other week; repeats ask for an end date), type foods under Breakfast / Lunch / Dinner, or upload a spreadsheet (.csv). Or choose "API" (with a "?" explaining it) to see the address, dining hall codes and an example for sending menus from other software. Then go to the Dashboard.

## LAYOUT
[ Left: Nav ] [ Page ]. There is no right-hand panel; day details live on the Schedule page.

### NAV
- Dashboard
- Schedule
- Menus: add a day's menu (same options as setup step 2); a calendar marks days with "No menu". Menus are saved for the first dining hall.
- Portions served
- Behind the scenes
- Settings

### DASHBOARD
With more than one dining hall, a dropdown next to the "Dashboard" title picks "All dining halls" (every hall added together) or one hall; everything on the page follows it.
Everything follows the lookback buttons at the top: Today, Last 7 days, Last 30 days, Last 90 days (no custom range). Under them, one short line on how waste is measured (AI outlines of visible leftovers, turned into grams with the plate size and a typical weight per food; estimates, not a scale reading).
1. Four headline cards, each marked "estimate" with a "?" explanation:
   - **Total waste**: estimated grams/kg as the big number; under it the measured Pixels wasted, how many plates it covers, and plates not counted.
   - **Greenhouse gases**: kg CO2e.
   - **Freshwater**: litres, or cubic meters with litres under it.
   - **Waste impact**: dollars, with "$0.19 per kg CO2e + $1.50 per m3 water. Not the food cost."
   A line under the cards says when foods have no weight estimate or plates used the standard plate size.
2. **What to try next**: the AI suggestion, labeled "AI" or "Rule-based fallback", each point with the number it is based on, and when it was written.
3. **Foods to target**: finding heading ("X had the most food left per portion."), a table ranked by estimated grams left per portion served, with Pixels wasted per portion, impact per portion, and portions served ("demo numbers" badge when they are demo). Foods that can't be ranked are listed with the reason: no portions entered, no weight estimate for this food, or not on the menu.
4. **Most wasted**: finding heading, foods ranked by estimated total weight as a bar list with greenhouse gases and water on each row; foods with only Pixels wasted listed after with the reason.
5. One chart, one bar per day: estimated food left when the server sends grams, Pixels wasted otherwise.
6. **Plates**: recent plate photos as a grid (time and grams left, or check failed / needs a person to look / being checked / clean plate). Picking one shows the photo and the AI outline image side by side, or one at a time, with each food's Pixels wasted and estimated weight. Expired photo links are renewed once; then "Photo unavailable".
7. **Nutrition lost**: a small, separate card marked "not part of the impact score", in nutrient-days (enough nutrients for one adult for one day).

### SCHEDULE
- Month calendar; special events from Settings show on their dates.
- Clicking a day shows that day's meal times and events, then Breakfast | Lunch | Dinner tabs. Each tab: a finding headline (most wasted food), Pixels wasted, plates scanned, clean plates, plates not counted, food not on the menu (unclassified pixels), meal swipes (simulated), the foods left on plates with their share of the meal's wasted pixels, and a suggestion labeled "written by AI" or "basic rule, AI unavailable".

### BEHIND THE SCENES
- Pick a date and meal. Every scanned plate photo with the AI's labels: food, units left, percent of a serving, and notes (AI estimate, more than a full serving, not on the menu). Clean plates say so. Photo links are temporary and renewed when they expire.

### SETTINGS
- Dining hall names, with "Add another location". At least one is required.
- Meal times: several named sets (e.g. Weekdays, Weekends), each with the days it covers and Breakfast/Lunch/Dinner hours. Warn about days with no set or in two sets (the first set wins).
- Special events: name, date, from, to (e.g. Football game).
- Download the last 30 days as a spreadsheet.

## COLOR AND TYPE (2026-10-03)
- Black and white only, including form controls. Styling comes later.
- Font: "Times New Roman" (Times, serif fallback) everywhere.
- Body text at least 16px; headline card numbers large (40px+).
- Flat: small 4px corners, black borders, no shadows, no fades.
- The Tailwind token names from the earlier palette are kept so components didn't change; every color token is black or white.

## TECH
- React + Tailwind, with colors mapped to Tailwind theme tokens.
- All mock data in one file so it can be swapped for SpacetimeDB queries later.
