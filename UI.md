Web dashboard called **ScrapSaver** that helps dining hall managers and chefs track food left on plates. The users are busy, non-technical kitchen staff. Keep screens simple, numbers big, and words plain. If a feature isn't listed here, leave it out.

## MEASUREMENT (v2, 2026-10-04, BIG-PLAN §7)

**Pixels wasted** (unit: **pixels**) is the measurement and the headline
number. Gemini classifies the food first and marks the dish being scanned;
a segmentation stage outlines the leftover food; application code counts the
foreground pixels. Only the scanned (target) dish counts: food on a
neighboring plate in the same photo is dropped and drawn in the outline image
as "Other dish (not counted)". Totals count overlapping food pixels once.
There is no plate-size calibration, so there are **no grams, kg, litres,
cubic meters, CO2e or dollars** anywhere on screen.

**Relative impact points** let foods be compared by what their waste costs
the planet: `points = pixels / 1000 x weight_g_per_cm2 x factor`.
Greenhouse-gas points use the food's kg CO2e/kg, water points its m3/kg, and
the impact score is `0.19 x greenhouse-gas points + 1.50 x water points`.
Points are unitless and always labeled "relative points". Nutrition points
(same formula with nutrient-days/kg) are shown on their own and are never part
of the impact score. Portions served that are demo numbers are labeled "demo
numbers". On screen, say "the AI outlines the leftover food" rather than mask
or segmentation.

## WRITING RULES (2026-10-03)
- Plain words a chef would use. No technical terms on screen (API, baseline, mask, benchmark, CSV as a noun; say "spreadsheet (.csv)"). "Pixels wasted" with its unit "pixels", and "relative points", are the technical words kept.
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
Everything follows the lookback buttons at the top: Today, Last 7 days, Last 30 days, Last 90 days (no custom range). Under them, one short line on how waste is measured: the AI outlines the leftover food on the plate being scanned and counts its pixels; impact points weight those pixels by each food's typical density and its greenhouse-gas and water footprint; they are relative, not a scale reading.
1. Two headline cards, each with a "?" explanation:
   - **Total waste**: Pixels wasted as the big number with the unit "pixels", "from X of Y plates scanned", and plates not counted.
   - **Relative impact** ("relative points" badge): the impact score in points, with greenhouse-gas points and water points under it, and "Relative points: they compare foods with each other, not kg or litres." The "?" gives the formula (pixels / 1,000 x food density x factor; 0.19 x greenhouse-gas + 1.50 x water). "Not available" instead of 0 when no food has factors.
   A line under the cards says when foods have no impact data (their pixels count in Total waste but not in the points).
2. **What to try next**: the AI suggestion, labeled "AI" or "Rule-based fallback", each point with the number it is based on (pixels per portion, pixels, relative points), and when it was written.
3. **Foods to target**: finding heading ("X had the most food left per portion."), a table ranked by **Pixels wasted per portion** served (summed pixels / summed portions), with impact per portion in relative points and portions served ("demo numbers" badge when they are demo). A food with no impact data still ranks by pixels and says "No impact data for this food". Foods that can't be ranked are listed with the reason: no portions entered, no portions served, or not on the menu.
4. **Most wasted**: finding heading, every food ranked by total Pixels wasted as a bar list, each row with its impact points (and the greenhouse-gas and water points), or why it has none.
5. One chart, one bar per day: Pixels wasted.
6. **Plates**: recent plate photos as a grid (time and pixels wasted, or check failed / needs a person to look / being checked / clean plate). When food on neighboring plates was left out of some plates, a short note says "Food on neighboring plates was left out of N plates". Picking one shows the photo and the AI outline image (the outline image marks a neighboring dish's food as "Other dish (not counted)") side by side or one at a time, with each food's Pixels wasted. Expired photo links are renewed once; then "Photo unavailable".
7. **Nutrition lost**: a small, separate card marked "relative points" and "not part of the impact score", in nutrition points with the top foods.

### SCHEDULE
- Month calendar; special events from Settings show on their dates.
- Clicking a day shows that day's meal times and events, then Breakfast | Lunch | Dinner tabs. Each tab: a finding headline (most wasted food), Pixels wasted, plates scanned, clean plates, plates not counted, food not on the menu (unclassified pixels), meal swipes (simulated), the foods left on plates with their share of the meal's wasted pixels, and a suggestion labeled "written by AI" or "basic rule, AI unavailable".

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
- Body text at least 16px; headline card numbers large (40px+).
- Flat: small 4px corners, black borders, no shadows, no fades.
- The Tailwind token names from the earlier palette are kept so components didn't change; every color token is black or white.

## TECH
- React + Tailwind, with colors mapped to Tailwind theme tokens.
- All mock data in one file so it can be swapped for SpacetimeDB queries later.
