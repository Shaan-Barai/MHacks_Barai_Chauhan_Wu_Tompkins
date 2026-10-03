Web dashboard called "Scrap" (placeholder name) that helps dining hall and cafeteria managers track plate food waste. The user is a busy, non-technical dining manager. Keep it to one main screen with big numbers, plain language, and as few clicks as possible. If a feature isn't listed here, leave it out.

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

## FIRST-TIME SETUP (3 steps, shown once)
1. Dining hall name and meal times (Breakfast / Lunch / Dinner, with editable default hours).
2. Add menus. Offer two big buttons:
   • "Connect a menu API": fields for API URL and key, plus a "Test connection" button (mock success).
   • "Upload menus myself": pick a date, then add items under Breakfast / Lunch / Dinner (type item names or upload a CSV). Allow adding several days at once.
3. "You're all set" screen, then go to the Dashboard.

## LAYOUT: THREE COLUMNS
[ Left: Nav ] [ Middle: Dashboard ] [ Right: Yesterday's Details ]

### LEFT: NAV (narrow)
- Dashboard
- Menus: the same two options as setup step 2, plus a calendar showing which days have a menu. Highlight days missing a menu in Squash.
- Settings: hall name, meal times, export CSV

### MIDDLE: DASHBOARD
- Top bar: date picker that accepts a single date or a date range. Default: last 30 days.
- Three summary cards in a row:
  • Today's waste
  • This week's waste
  • This month's waste
  Each card shows Pixels wasted in pixels and a small ↑/↓ vs the previous period (Basil if waste went down, Tomato if it went up).
- One main chart: waste (y-axis) vs date (x-axis), following the selected date range. Put a small toggle above it for Daily / Weekly / Monthly grouping. Hovering shows the exact value and date.
- Nothing else goes in the middle column.

### RIGHT: YESTERDAY'S DETAILS
- Header: "Yesterday, [date]". If the manager picks a single date in the date picker, this panel shows that date instead.
- Tabs: Breakfast | Lunch | Dinner
- Each tab shows:
  • Total waste for that meal (big number), plates scanned, and meal swipes
  • "Most wasted": the top item, with its counted pixels and share of that meal's wasted pixels, plus a one-line tip from Gemini (e.g., "Scrambled eggs made up 31% of breakfast's wasted pixels. Review the serving scoop size.")
  • A short ranked list of the next 4 most wasted items, each with a severity color dot

## SEVERITY COLORS (for items)
Based on the item's share of that meal's total waste:
- Low (<10%): Sage
- Medium (10–25%): Squash
- High (>25%): Tomato

## COLOR PALETTE: "Kitchen Garden"
--bg:           #F6F1E7  /* Oat: page background */
--surface:      #FFFDF8  /* Cream: cards, right panel */
--border:       #E4DCCB  /* Linen: dividers, card borders */
--ink:          #1F2A24  /* Charcoal Herb: primary text */
--ink-muted:    #6B7368  /* Thyme: labels, secondary text */
--primary:      #2F5D46  /* Basil: nav background, buttons, active tab */
--primary-soft: #DCE8DA  /* Basil tint: hover, selected states */
--low:          #8FB38A  /* Sage */
--medium:       #E8A93B  /* Squash */
--high:         #D9573B  /* Tomato */
--info:         #2E4A7D  /* Blueberry: chart bars/line */

## VISUAL STYLE
- Fonts: "Inter" for UI text, "Fraunces" for big numbers and page titles.
- Body text at least 16px; summary card numbers large (40px+).
- Rounded corners (12px cards, 8px buttons), soft shadows, generous whitespace.
- Left nav in Basil with cream text. Middle on Oat. Right panel on Cream with a Linen left border.
- Friendly empty states, e.g., "No menu for this day yet. Add one in Menus."

## TECH
- React + Tailwind, with the palette mapped to Tailwind theme tokens.
- All mock data in one file so it can be swapped for SpacetimeDB queries later.
