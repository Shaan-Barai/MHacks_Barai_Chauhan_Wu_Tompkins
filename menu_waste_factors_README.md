# Waste Impact Factors: Dinner Menu

Two files hold per-food constants for the 26 items on the test dining hall's dinner menu: the 22 dishes on the nutrition sheet, Baked Sweet Potatoes (from an earlier menu), and **Halal Rice, Tomatoes and Lettuce** (added 2026-10-04 for the live demo; see [Added foods](#added-foods-2026-10-04)).

**What the app reports (BIG-PLAN v2, 2026-10-04; IT_4).** The measurement is **Pixels wasted**: leftover-food pixels counted from validated SAM 2.1 masks, only on the dish being scanned. To let a pixel of beef count for more than a pixel of rice, it turns pixels into unitless **relative impact points** using the factors in these files. When the camera has been **calibrated** (IT_4: a reference object of known area gives cm² per pixel), the app also shows **estimated** grams, kg CO2e and litres of water; see [Estimated grams, CO2e and water (IT_4)](#estimated-grams-co2e-and-water-it_4). It never shows dollars.

**`menu_waste_factors_EastQuad.csv`** (feeds the impact points) gives, for each food:
- a weight-per-area constant (`weight_g_per_cm2`), so foods that are heavier per unit of visible area weigh more in the points, and calibrated area turns into estimated grams (IT_4)
- two environmental impact factors per kg of food: carbon (C) and water (W)
- a combined Waste Impact Score per kg, built from C and W only
- the dining hall's allergen list, an ingredient recipe and the label serving size
- Gemini's plain description of what each dish looks like on a plate, used in the classification prompt and as the demo menu description

**`menu_nutrition_factors_EastQuad.csv`** (reported separately, never in the impact points) gives the nutrition lost per kg (O, in nutrient-days), calories per kg and the dining hall's nutrition label. See [Nutrition points](#nutrition-points-reported-separately-not-in-the-score).

Both files are keyed by `station` + `food`. The app matches a menu item to a row by `factorKey = slug(food)`, for example `Ancho Flank Steak` → `ancho-flank-steak`. The typed copies used by the app are generated from these CSVs (`data/scripts/generate-factors.mjs` → `data/src/factors.generated.ts`, version `waste-factors-v4`; v4 removed the v3 density columns), so the CSVs stay the source of truth.

## The factor formula

```
Waste Impact Score (per kg) = s·C + t·W
```

| Factor | Meaning | Unit | Weight | Why this weight |
|---|---|---|---|---|
| **C** | Greenhouse gas emissions to produce the food | kg CO2e per kg | **s = 0.19** per kg CO2e | Social cost of carbon, about $185–190 per tonne (Rennert et al. 2022, *Nature*; EPA 2023) |
| **W** | Freshwater withdrawn to produce the food | m³ per kg | **t = 1.50** per m³ | Replacement cost of water (True Price & Wageningen Economic Research, €1.29/m³) |

C and W are in different units, so the weights put them on one scale. The weights are published prices (dollars per tonne of CO2e, dollars per m³ of water), following the "true cost accounting" approach the UN FAO uses to price food's hidden environmental costs (FAO, *State of Food and Agriculture 2023*). Every weight is a published value, not an opinion. That is why the CSV columns are named in dollars per kg. The app uses the score only to rank foods relative to each other and never shows it as money.

In the CSV, `carbon_usd_per_kg` = 0.19·C and `water_usd_per_kg` = 1.50·W, each rounded to cents. `impact_score_usd_per_kg` is 0.19·C + 1.50·W computed before rounding, then rounded to cents, so it can differ from the sum of the two rounded columns by 0.01.

Nutrition is deliberately **not** part of the score. Wasted food also wastes nutrition, but nutrient-days are a different kind of quantity from emissions and water, and adding them made the score mostly about nutrition (it was the largest factor for every food except beef). The app reports nutrition points as their own number.

## Turning pixels into relative impact points

The app does these steps for every analyzed plate photo. Pixels wasted is the measurement. The points are derived from it at read time (`analytics`, `computeWasteImpact`).

1. **Pixels:** count the pixels in each validated SAM 2.1 leftover-food mask on the scanned dish (see AGENTS.md §7; food on neighboring dishes is excluded).
2. **Base:** `base = pixels / 1000 × weight_g_per_cm2`
3. **Points:**
   - `co2Points = base × C`
   - `waterPoints = base × W`
   - `impactPoints = 0.19 × co2Points + 1.50 × waterPoints` (= base × (0.19·C + 1.50·W), from the unrounded C and W; `impact_score_usd_per_kg` is the same value per kg rounded to cents, for reading the table)
   - `nutritionPoints = base × O` (separate; never added to `impactPoints`)

The points are **unitless and relative**. They compare foods with each other (the same leftover area of steak counts for far more than potatoes), but they are not kilograms, litres or dollars, and a points total is not a physical amount. Points use raw pixels, not the camera calibration, so a pixel is not a fixed area: points are best compared within the same camera setup. Physical estimates come only from the calibrated path below.

Food the classifier could not match to the menu keeps its pixels but has no factor row, so its points are unavailable ("no impact factor"), never zero. The same holds for a menu item without a factor row.

**Example:** a 10,000-pixel leftover of pepperoni pizza (1.0 g/cm², C 16.06, W 1.94, score 5.96)
- Base: 10,000 / 1000 × 1.0 = **10**
- CO2 points: 10 × 16.06 = **160.6**
- Water points: 10 × 1.94 = **19.4**
- Relative impact points: 10 × 5.96 = **59.6**
- Nutrition points (separate, not in the score): 10 × 0.69 = **6.9**

For comparison, the same 10,000 pixels of Ancho Flank Steak (1.2 g/cm², score 27.91) is 12 × 27.91 = **334.9** relative impact points, and of Oven Roasted Garlic Potatoes (1.6 g/cm², score 0.29) is 16 × 0.29 = **4.6**.

**Waste per portion.** To find foods to target, the app divides an item's summed pixels by its summed portions served for the same hall, date, meal and menu version (sum first, then divide), and shows the matching relative impact points per portion beside it. Missing or zero portion counts make the rate unavailable. The demo portion counts are dummy values labeled `demo`.

## Estimated grams, CO2e and water (IT_4)

A camera calibration supplies the conversion AGENTS.md asks for, and it is the **only** source of area: the user lays a flat object of known area (a credit card is 46.21 cm²) where plates sit, and the app counts its mask pixels to get `k = cm² per pixel` for that camera and resolution (`reference-area-v1`). Each food on a calibrated capture then gets a `PhysicalEstimate` with `area_cm2 = pixels × k` (stored by the backend), and `analytics` derives at read time:

```
area_cm2 = pixels × k                                  (camera calibration only; no other area source)
grams    = area_cm2 × weight_g_per_cm2                 (typical food weight per cm² of plate area)
kg_co2e  = grams / 1000 × C
water_L  = grams / 1000 × W × 1000 = grams × W         (W is m³ per kg)
method   = area-calibrated-v1
```

- Unavailable is `null` with a reason, never 0: `no_calibration` (uncalibrated capture), `incompatible_geometry` (different resolution from the calibration), `unknown_item`, `no_factor`.
- Totals add only calibrated plates and say how many ("from 12 of 14 plates (calibrated)"). Grams per portion is Σ grams ÷ Σ portions, and only when every plate of that food was calibrated.
- Everything is labeled **estimated**. Pixels wasted stays the raw measurement and is always shown. Relative points and nutrition points are unchanged, and nutrition never enters CO2 or water.
- Depth Anything V2 volume was tried briefly and removed (2026-10-04, user decision), along with the `density_g_per_cm3` / `density_source` columns (`waste-factors-v4`). Legacy rows stored during that trial (method `volume-dav2-v1`) are read as area estimates; their volume is ignored.

**Worked example 1.** Calibration: a credit card (46.21 cm²) covers 18,500 pixels, so k = 46.21 / 18,500 = 0.0024978 cm²/px. A leftover of Ancho Flank Steak covers 8,000 pixels:
- area = 8,000 × 0.0024978 = **19.98 cm²**
- grams = 19.98 × 1.2 g/cm² = **23.98 g**
- CO2e = 23.98 / 1000 × 131.69 = **3.16 kg CO2e**
- water = 23.98 × 1.925 = **46.2 L**
- label: `Ancho Flank Steak · 24 g · 3.2 kg CO2e · 46 L water (est.)`

**Worked example 2.** Same calibration. A leftover of Sticky Rice covers 10,009 pixels:
- area = 10,009 × 0.0024978 = **25.0 cm²**
- grams = 25.0 × 1.6 g/cm² = **40 g**
- CO2e = 40 / 1000 × 1.78 = **0.0712 kg** (shown as `71 g CO2e`)
- water = 40 × 0.899 = **36.0 L**
- label: `Sticky Rice · 40 g · 71 g CO2e · 36 L water (est.)`

Both plates together: 24 + 40 = **64 g**, 3.16 + 0.07 = **3.2 kg CO2e**, 46.2 + 36.0 = **82 L** water (estimated).

**Bowls and liquids.** Broccoli Cheddar Soup in a bowl: an 80 cm² visible surface gives 80 × 1.5 = **120 g**. The visible area of a liquid says little about how much is left, so treat soup grams as the weakest estimate.

## Columns

### `menu_waste_factors_EastQuad.csv` (impact point inputs)
| Column | Meaning |
|---|---|
| `station`, `food` | Menu station and item name |
| `weight_g_per_cm2` | Estimated grams per cm² of top-down plate area (points, and estimated grams on calibrated plates) |
| `C_kg_co2e_per_kg` | Greenhouse gas emissions per kg of food as served |
| `W_water_m3_per_kg` | Freshwater withdrawals per kg (m³) |
| `carbon_usd_per_kg`, `water_usd_per_kg` | 0.19·C and 1.50·W (priced at the published weights) |
| `impact_score_usd_per_kg` | 0.19·C + 1.50·W, the per-kg factor behind relative impact points |
| `largest_factor` | `carbon` or `water`, whichever contributes more to the score |
| `menu_co2_label` | The dining hall's own CO2 icon (high / medium / low), for comparison |
| `allergens_listed` | The "Contains" list from the dining hall's label |
| `gemini_ingredients` | Gemini's inferred ingredient list, from `gemini_menu_guesses_raw.txt` |
| `gemini_visible_components` | Gemini's description of what the dish looks like on a plate. Used in the classification prompt and as the demo menu description |
| `recipe_kg_per_kg` | Recipe used for C and W: kg of each ingredient per kg of finished dish |
| `label_serving_g` | Serving weight from the dining hall label, useful for checking `weight_g_per_cm2` |
| `notes` | Assumptions specific to that item |

### `menu_nutrition_factors_EastQuad.csv` (reported separately)
| Column | Meaning |
|---|---|
| `station`, `food` | Same keys as the waste file |
| `O_nutrient_days_per_kg` | Nutrition lost per kg (see below); the factor behind nutrition points |
| `kcal_per_kg` | Calories per kg (from the label where available) |
| `nutrient_credit_days` | The nutrient part of O, after the quality multiplier |
| `calorie_credit_days` | The calorie part of O |
| `quality_multiplier` | 1.0 = no excess sugar, saturated fat or sodium; lower = more of them |
| `separate_nutrition_value_usd_per_kg` | O × $9.39 per nutrient-day. A separate valuation for reference only; it is **not** added to the score and the app does not show it |
| `nutrition_source` | Whether O came from the dining hall label or from a recipe estimate |
| `label_*` | The dining hall's nutrition label per serving, exactly as printed |
| `notes` | Nutrition assumptions specific to that item |

## How each factor is calculated

### C and W: environmental impact
- **Source:** Poore & Nemecek (2018), *Science*, the largest meta-analysis of food life-cycle studies (via Our World in Data). Values are global medians covering the full supply chain: land-use change, farming, processing, transport, packaging and retail.
- **Butter and cream** aren't in that dataset, so they are milk's footprint scaled by the butter:milk and cream:milk ratios from Clune et al. (2017), *Journal of Cleaner Production*.
- **Dishes** are the weighted sum of their ingredients (see `recipe_kg_per_kg`), adjusted for cooking. Cooked meat is about 1.35 kg raw per kg cooked.
- **Recipes are checked against the labels.** Each recipe was adjusted so its calories line up with the dining hall's label, most within about 10%. The very low-calorie vegetables are off by a few calories in absolute terms. The labels also corrected three assumptions:
  - The **Chocolate Coconut Cream Pie** and **Golden Cake** are vegan: 0 mg cholesterol, and no milk or eggs listed.
  - The **pepperoni is beef**, not pork. This raises the pepperoni pizza's carbon factor.

### Weight constants (g/cm²)
These are estimates from typical portions. For example, a 14-inch pizza slice covers about 125 cm² and weighs about 110 g, so roughly 1.0 g/cm². A top-down camera can't see how tall food is, so they may be off by 30–50%. In the app they set how much one food's pixels count relative to another's (relative points), and on calibrated captures they turn area into the estimated grams behind the CO2e and water figures, so that error carries straight through to those estimates. They have not yet been checked against food from this dining hall.

**Checking them** needs a known scale: with a fixed camera whose cm² per pixel has been measured, place one labeled serving on a plate (`label_serving_g` gives its weight), count its pixels, convert to cm², and divide grams by cm².

## Nutrition points (reported separately, not in the score)

The app reports nutrition as its own relative number, from `menu_nutrition_factors_EastQuad.csv`: `nutritionPoints = pixels / 1000 × weight_g_per_cm2 × O`. Like the impact points it is unitless (not nutrient-days), and it is never added to `impactPoints`.

### O: lost nutrition, in "nutrient-days"
One **nutrient-day** is enough of 9 key nutrients to cover an adult's daily needs for one day. The 9 nutrients are protein, fiber, vitamins A, C and E, calcium, iron, potassium and magnesium.

```
O = (good-nutrient days × quality multiplier) + calorie credit
```

- **Good-nutrient days** use the 9 "nutrients to encourage" from the Nutrient Rich Foods index (Drewnowski 2009). Each is a % of the Daily Value per 100 g, capped at 100%, then averaged and scaled to per kg.
  - **From the dining hall label:** protein, fiber, vitamins A and C, calcium and iron.
  - **Estimated from the recipe:** vitamin E, potassium and magnesium, which the labels don't show.
- **Quality multiplier** = `1 / (1 + L / 100)`. L is the % of the daily maximum for saturated fat, sugar and sodium in 100 g, all taken from the label. It shrinks the nutrient credit for less healthy foods but can never reach zero.
- **Calorie credit** = 0.1 nutrient-days per 2,000 kcal, using label calories. Even food with few nutrients still feeds someone, so a full day's worth of calories with no nutrients counts as one-tenth of a nutrient-day.

The result is always positive. Desserts get small values (0.39–0.55 per kg; pumpkin pie is 0.97 thanks to its vitamin A). Vegetables get the most: sweet potatoes 1.80, stir fry 1.58, brussels sprouts 1.31. The lowest are Halal Rice (0.23) and sticky rice (0.24).

**Why not use the NRF9.3 index as is?** Its standard formula subtracts sugar, fat and sodium, which can push desserts to zero or below. That would treat wasting dessert as a nutritional gain. This adaptation keeps the penalty as a multiplier instead.

**Optional dollar value.** `separate_nutrition_value_usd_per_kg` = O × $9.39, the cost of a nutritionally adequate day of food (USDA Thrifty Food Plan, May 2026, average adult 20–50). It is kept for reference only; it is not part of the score and the app does not show it.

## Ingredient experiment: Claude's guesses vs. Gemini's
Neither model knows the real recipes, since the dining hall only publishes allergens. To find which ingredient descriptions work better for classification:

1. **Source data:** Gemini was given `dining_hall_menu_labels_EastQuad.pdf` (the original screenshots) and `dining_hall_menu_labels_EastQuad.csv` (the same data transcribed). Neither file contains any of Claude's guesses.
2. **Gemini's guesses:** Gemini filled in `gemini_ingredients` and `gemini_visible_components` from that source data alone (`gemini_menu_guesses_raw.txt`). Baked Sweet Potatoes is not on that sheet, so it has no Gemini guess.
3. **Run both:** the same plate photos went through the same pipeline twice, once with Claude's descriptions in the classification prompt and once with Gemini's. Nothing else changed.
4. **Compare** against hand-labeled plates (`experiment_summary.csv`): Gemini's descriptions scored slightly better overall (36 correct vs 35 over 24 vs 23 scored runs, a lower unknown share and a lower run-to-run disagreement rate, though 3 wrong vs 2). The difference is small, but the app and the demo menu use the Gemini descriptions. Claude's columns were dropped from this file.

## Results at a glance
Scores per kg (`impact_score_usd_per_kg`); the app turns them into relative impact points:
- **Highest:** Ancho Flank Steak, 27.91, where carbon is about 90% of the score.
- **Next:** Cheese Bread (6.95), Pepperoni Pizza (5.96) and Baked Boneless Ham (5.07).
- **Lowest:** Baked Sweet Potatoes, 0.12, then Vegetable Stir Fry Blend (0.21), Lettuce (0.26) and Oven Roasted Garlic Potatoes (0.29).
- **Largest factor:** water for 20 foods, carbon for 6 (the flank steak, pepperoni pizza, the Snickers brownies, the two vegan desserts and the sweet potatoes).
- **Added foods:** Halal Rice 1.66, Tomatoes 0.95, Lettuce 0.26 (water is the largest factor for all three).
- **Nutrition** (separate): highest for the vegetables (sweet potatoes 1.80, stir fry 1.58 nutrient-days per kg), lowest for Halal Rice (0.23) and sticky rice (0.24).

## Added foods (2026-10-04)

Halal Rice, Tomatoes and Lettuce were added to the demo dinner so plates from the halal station and its toppings can be matched. None is on the dining hall's nutrition sheet, so like Baked Sweet Potatoes they have no label, allergen list or Gemini guess, and their menu descriptions are hand-written fallbacks in `data/src/seed/generate.ts`.

| Food | Station | g/cm² | C | W | Score | Recipe and source |
|---|---|---|---|---|---|---|
| Halal Rice | Halal | 1.3 | 1.90 | 0.866 | 1.66 | Yellow long-grain rice: 0.38 kg raw rice per kg cooked (as Sticky Rice), 3% vegetable (soybean) oil, 3% onion, 0.6% salt. Rice, soybean oil and onion from Poore & Nemecek |
| Tomatoes | Salad Bar | 0.8 | 2.09 | 0.370 | 0.95 | Raw tomatoes, Poore & Nemecek global median (includes heated greenhouses, so C is upper-range) |
| Lettuce | Salad Bar | 0.3 | 0.53 | 0.103 | 0.26 | Poore & Nemecek has no lettuce row, so "Other Vegetables" is used. Shredded leaves are airy, hence the low weight per area |

Nutrition (in `menu_nutrition_factors_EastQuad.csv`, separate from the score) uses the same O formula with USDA values per 100 g: Halal Rice 0.23 (unenriched cooked long-grain rice, oil, onion, salt), Tomatoes 0.44 (raw red tomatoes), Lettuce 0.57 (raw romaine and iceberg, 50/50). The method reproduces the existing Baked Sweet Potatoes row (O 1.80). The densities are estimates like the others: Halal Rice is looser than Sticky Rice (1.6), and a layer of diced tomato is about 0.8 g/cm².

## Caveats
- **Relative impact points are not physical quantities.** They are pixels weighted by the weight-per-area constants and the factors, so they rank foods against each other but are not kg, litres or dollars. Pixel area also depends on the camera distance and plate size. Accurate pixel counting does not guarantee accurate segmentation.
- **Estimated grams, CO2e and water are estimates, not weighings.** They stack the calibration (a reference area at table level; food sitting higher on a plate looks slightly larger), the AI mask, a g/cm² constant (30–50% uncertain) and global-median C and W factors. Use them to see orders of magnitude, not to audit a single plate.
- **Beef uses the global median for beef-herd cattle.** US beef typically comes in lower, so treat the steak's carbon number as upper-range.
- **The flank steak's label matches raw steak,** so its label nutrients were multiplied by 1.35 to reflect cooked meat.
- **Ingredient lists are inferred, not published.** They're consistent with each dish's allergens and nutrition label, but the dining hall only publishes allergens.
- **Label vitamin and mineral percentages are used as printed.** The dining hall's labels may use older Daily Value references.
- **Baked Sweet Potatoes has no label,** so its nutrition is estimated from USDA ingredient values.
- **Soup is the weakest weight estimate.** It's liquid in a bowl, so its visible area says little about how much is left.
- **Cooking energy at the dining hall is not included.**

## References
- **Primary:** Conrad, Z., Niles, M.T., Neher, D.A., Roy, E.D., Tichenor, N.E. & Jahns, L. (2018). Relationship between food waste, diet quality, and environmental sustainability. *PLoS ONE* 13(4): e0195405.
- Poore, J. & Nemecek, T. (2018). Reducing food's environmental impacts through producers and consumers. *Science* 360(6392).
- Spiker, M.L., Hiza, H.A.B., Siddiqi, S.M. & Neff, R.A. (2017). Wasted food, wasted nutrients: nutrient loss from wasted food in the United States and comparison to gaps in dietary intake. *Journal of the Academy of Nutrition and Dietetics*.
- Drewnowski, A. (2009). Defining nutrient density: development and validation of the Nutrient Rich Foods index. *Journal of the American College of Nutrition* 28(4).
- Clune, S., Crossin, E. & Verghese, K. (2017). Systematic review of greenhouse gas emissions for different fresh food categories. *Journal of Cleaner Production* 140.
- FAO (2023). *The State of Food and Agriculture 2023: Revealing the true cost of food to transform agrifood systems.*
- Rennert, K. et al. (2022). Comprehensive evidence implies a higher social cost of CO2. *Nature*.
- USDA Food and Nutrition Service (2026). Official USDA Thrifty Food Plan: U.S. Average, May 2026.
- True Price & Wageningen Economic Research (2021). True price of water estimate, as reported by *Resource*.
- Dining hall nutrition labels and allergen lists for the test menu (October 2026).

## Common-foods fallback (`menu_waste_factors_500.csv`)

`menu_waste_factors_500.csv` lists 500 common dining-hall foods with the same columns. The hall's own
table (`menu_waste_factors_EastQuad.csv`) always wins. A menu item that table doesn't cover gets its
weight, C and W from the 500-food table when its name matches exactly (`factorKey = slug(name)`, e.g.
`Scrambled Eggs` → `scrambled-eggs`). The dashboard marks those foods "factors: common foods table".
The fallback has no nutrition rows. A food in neither table has no impact factor (shown as such, never 0).

All factor CSVs (East Quad, Halal Bros, the 500 common foods) follow the same column rules, checked for
every row by `data/test/factors.test.ts`: `carbon_usd_per_kg = 0.19·C` and `water_usd_per_kg = 1.50·W`
rounded half up to cents, `impact_score_usd_per_kg` = the unrounded 0.19·C + 1.50·W rounded half up,
and `largest_factor` = the larger of the two. When the 500-food table arrived (2026-10-04), 52 of its
derived cells were 1 cent off that rule; they were recomputed from C and W (C and W unchanged), as was
one half-cent cell in the Halal Bros table (Diced Tomatoes water, 0.555 → 0.56).

## Halal Bros table (`menu_waste_factors_halal_bros.csv`)

Four foods from Halal Bros 2 Go (810 S State St, Ann Arbor): Halal Chicken, Yellow Rice, Diced Tomatoes and Shredded Lettuce. The restaurant describes its chicken over rice as seasoned basmati rice topped with marinated chicken, lettuce, tomatoes, and white, green and red sauces. It publishes no nutrition or portion weights, so the nutrition labels in this file are **made-up test values** and the g/cm² values are unverified estimates.

The app looks this table up after East Quad and before the 500-food fallback (`table: 'halal-bros'`), so a menu item named exactly like a row gets its factors, including estimated grams on calibrated plates. The sauces have no row: leftover sauce counts as unclassified pixels with no grams.
