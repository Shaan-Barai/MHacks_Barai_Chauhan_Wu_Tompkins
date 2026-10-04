Web dashboard called **ScrapSaver** that helps dining hall managers and chefs track food left on plates. The users are busy, non-technical kitchen staff. Keep screens simple, numbers big, and words plain. If a feature isn't listed here, leave it out.

## MEASUREMENT (v2, 2026-10-04, BIG-PLAN §7)

**Pixels wasted** (unit: **pixels**) is the measurement and the headline
number. Gemini classifies the food first and marks the dish being scanned;
a segmentation stage outlines the leftover food; application code counts the
foreground pixels. Only the scanned (target) dish counts: food on a
neighboring plate in the same photo is dropped and drawn in the outline image
as "Other dish (not counted)". Totals count overlapping food pixels once.
There is no plate-size calibration.

**Estimated grams, CO2e and water (IT_4, 2026-10-04).** A camera calibration
(a flat object of known area, by default a credit card, 46.21 cm²) turns
pixels into cm² per pixel; it is the only source of food area. Each food's
typical weight per cm² then gives grams, and its footprint per kilogram gives
kg CO2e and litres of water. (Depth Anything V2 volume was tried and removed,
2026-10-04.) These are always labeled
**estimates** ("est.", "estimate" badge) and appear only for plates scanned
with a calibrated camera. Missing estimates are never shown as 0: say
nothing, or a muted reason ("not calibrated", "no estimate for this food",
"photo size differs from the calibration"). Pixels wasted stay the
measurement and the first headline. No dollars anywhere.

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

## STAFF SIGN-IN (IT_4)
- Everyone can read every page. Changes need staff sign-in: "Staff sign-in" at the bottom of the nav opens a small dialog with one "Staff passcode" field. Signed in, the nav says "Signed in as staff" with "Sign out".
- Signed out, write controls are hidden or disabled with a dashed box: "Sign in to change this." and a "Staff sign-in" button. This covers adding menus, portions served (form and sheet upload), Settings (hall, meal times, events) and camera calibration.
- If a change is refused because the sign-in ended, the dialog opens with "Sign in to save this change."
- First-time setup is shown to signed-in staff only; visitors see the dashboard with the default meal times.

## LAYOUT
[ Left: Nav ] [ Page ]. There is no right-hand panel; day details live on the Schedule page.
Each page has its own address (/, /schedule, /menus, /portions, /behind-the-scenes, /settings). Any other address shows "We couldn't find that page." with "Go to the dashboard".

### NAV
- Dashboard
- Schedule
- Menus: add a day's menu; a calendar marks days with "No menu".
- Portions served
- Behind the scenes
- Settings
- Admin

### DASHBOARD
Everything follows the lookback buttons at the top: Today, Last 7 days, Last 30 days, Last 90 days (no custom range). Under them, one short line on how waste is measured: the AI outlines the leftover food on the plate being scanned and counts its pixels; impact points weight those pixels by each food's typical weight per cm² and its greenhouse-gas and water footprint; they are relative, not a scale reading.
1. Four headline cards, each with a "?" explanation, Total waste first:
   - **Total waste**: Pixels wasted as the big number with the unit "pixels", "from X of Y plates scanned", and plates not counted.
   - **Relative impact** ("relative points" badge): the impact score in points, with greenhouse-gas points and water points under it, and "Relative points: they compare foods with each other, not kg or litres." The "?" gives the formula (pixels / 1,000 x the food's typical weight per cm² x factor; 0.19 x greenhouse-gas + 1.50 x water). "Not available" instead of 0 when no food has factors.
   - **Estimated CO2e** (cloud icon, "estimate" badge): kg CO2e, "Greenhouse gases from the food left on plates, about X kg of food", "From 12 of 14 plates (calibrated)". No method line. The "?" says: "An estimate, not a scale reading. The camera calibration (a reference object of known area) turns pixels into square centimetres. Each food's typical weight per cm² turns that into grams, and its footprint per kilogram gives CO2e and water. Only plates scanned with a calibrated camera count here. Pixels wasted stay the measurement."
   - **Estimated water** (droplet icon, "estimate" badge): litres, same coverage and method lines.
   - With no calibrated plates in the days: "Not available" and "No plates in these days were scanned with a calibrated camera. Calibrate the camera in Settings."
   A line under the cards says when foods have no impact data (their pixels count in Total waste but not in the points or estimates).
   **Food labels.** Wherever a food is listed (Most wasted, Foods to target, the plate viewer, Schedule day details) its name is followed by chips `38 g · 1.1 kg CO2e · 18 L water` and "est.", with small cloud and droplet icons. Rounding matches the AI outline image's legend: whole grams, CO2e and water to 2 significant digits, CO2e in g below 0.1 kg. A "?" says: "Estimated, not weighed. The area comes from the camera calibration (a reference object of known area gives the size of each pixel), and grams from the food's typical weight per cm². CO2e and water come from each food's footprint per kilogram. Pixels are the measurement." Foods to target also shows "about N g est." per portion when every plate of that food was calibrated.
2. **What to try next**: the AI suggestion, labeled "AI" or "Rule-based fallback", each point with the number it is based on (pixels per portion, pixels, relative points), and when it was written.
3. **Foods to target**: finding heading ("X had the most food left per portion."), a table ranked by **Pixels wasted per portion** served (summed pixels / summed portions), with impact per portion in relative points and portions served ("demo numbers" badge when they are demo). A food with no impact data still ranks by pixels and says "No impact data for this food". Foods that can't be ranked are listed with the reason: no portions entered, no portions served, or not on the menu.
4. **Most wasted**: finding heading, every food ranked by total Pixels wasted as a bar list, each row with its impact points (and the greenhouse-gas and water points), or why it has none.
5. One chart, one bar per day: Pixels wasted.
6. **Plates**: recent plates as a grid. Each tile shows the AI outline image when there is one (badge "AI outline"), otherwise the photo; analyzed plates come first, and the newest analyzed plate opens side by side without a click (time and pixels wasted, or check failed / needs a person to look / being checked / clean plate). When food on neighboring plates was left out of some plates, a short note says "Food on neighboring plates was left out of N plates". Picking one shows the photo and the AI outline image (the outline image marks a neighboring dish's food as "Other dish (not counted)") side by side or one at a time, with each food's Pixels wasted and, for calibrated plates, an "Estimated amount" column with the chips and "Estimated from the camera calibration (area) and each food's typical weight per cm² (grams)." An uncalibrated plate keeps two columns and says why it has no grams, CO2e or water. Expired photo links are renewed once; then "Photo unavailable".
7. **Nutrition lost**: a small, separate card marked "relative points" and "not part of the impact score", in nutrition points with the top foods.

### SCHEDULE
- Month calendar; special events from Settings show on their dates.
- Clicking a day shows that day's meal times and events, then Breakfast | Lunch | Dinner tabs. Each tab: a finding headline (most wasted food), Pixels wasted, plates scanned, clean plates, plates not counted, food not on the menu (unclassified pixels), meal swipes (simulated), the foods left on plates with their share of the meal's wasted pixels, and a suggestion labeled "written by AI" or "basic rule, AI unavailable".

### BEHIND THE SCENES
- Pick a date and meal. Every scanned plate photo with the AI's labels: food, units left, percent of a serving, and notes (AI estimate, more than a full serving, not on the menu). Clean plates say so. Photo links are temporary and renewed when they expire.

### ADMIN (2026-10-04)
- Staff only (signed out: just a "Sign in" button). Choose which plates the dashboard shows. Lookback buttons, filter All / Shown / Hidden with counts, "Show all listed" / "Hide all listed", and a grid of plates (AI outline image or photo, time and meal, pixels or status) with a Shown/Hidden toggle. Hidden plates are dimmed here and left out of every dashboard number, chart and gallery; nothing is deleted.

### SETTINGS
- Signed out: a "Sign in to change this." box at the top; fields are disabled; calibration results and history are still readable.
- Hall name.
- Meal times: several named sets (e.g. Weekdays, Weekends), each with the days it covers and Breakfast/Lunch/Dinner hours. Warn about days with no set or in two sets (the first set wins).
- Special events: name, date, from, to (e.g. Football game).
- Download the last 30 days as a spreadsheet.
- **Camera calibration** (IT_4):
  - One line on why: calibration lets ScrapSaver estimate grams, CO2e and water from the pixels it counts; the reference object of known area gives the area of each pixel, and each food's typical weight per cm² turns that area into grams; pixels stay the measurement.
  - "How to calibrate": 1. Lock the camera in place and keep its focus fixed. 2. Lay a credit card (or another flat object you have measured) flat where the plates go. 3. Take the photo with the mounted camera at its usual position, then upload it below. 4. Don't move the camera afterwards. If it moves, or its picture size changes, calibrate again.
  - "New calibration": Known area (cm²), a "Credit card (46.21 cm²)" button, "What is it?" (e.g. credit card), the calibration photo (JPEG/PNG/WebP; "It must come from the mounted camera that scans the plates, at its usual position."; the browser crops it to the same 1024 x 1024 centre square as plate photos), "Calibrate". While it runs: "Uploading the photo and measuring the credit card. This can take up to a minute."
  - The result: the photo with the reference outlined by the AI; Reference (credit card, 46.21 cm²), In the photo (N pixels), Scale (cm² per pixel), Camera height from the photo (C920s lens and the reference size; a setup check, it does not change the estimates), Picture size (1024 x 1024); "Check this" with the reference flags in plain words (not found, unsure outline, touches the edge; flags the dashboard doesn't know are not shown); "Activate" when it is not the active one ("New plates use the active calibration. Plates already scanned keep the one they were measured with.").
  - "Past calibrations": date, reference, cm² per pixel, status, the active one marked "Active", a "Show" button each.

## COLOR AND TYPE (2026-10-03)
- Black and white only, including form controls. Styling comes later. Icons are small inline SVG line drawings (no icon fonts or CDNs).
- Font: "Times New Roman" (Times, serif fallback) everywhere.
- Body text at least 16px; headline card numbers large (40px+).
- Flat: small 4px corners, black borders, no shadows, no fades.
- The Tailwind token names from the earlier palette are kept so components didn't change; every color token is black or white.

## TECH
- React + Tailwind, with colors mapped to Tailwind theme tokens.
- All mock data in one file so it can be swapped for SpacetimeDB queries later.
