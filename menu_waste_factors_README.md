# Waste Impact Factors: Dinner Menu

Two files hold per-food constants for the 26 items on the test dining hall's dinner menu: the 22 dishes on the nutrition sheet, Baked Sweet Potatoes (from an earlier menu), and **Halal Rice, Tomatoes and Lettuce** (added 2026-10-04 for the live demo; see [Added foods](#added-foods-2026-10-04)).

**What the app reports (BIG-PLAN v2, 2026-10-04; IT_4).** The measurement is **Pixels wasted**: leftover-food pixels counted from validated SAM 2.1 masks, only on the dish being scanned. To let a pixel of beef count for more than a pixel of rice, it turns pixels into unitless **relative impact points** using the factors in these files. When the camera has been **calibrated** (IT_4: a reference object of known area, optionally Depth Anything V2 depth), the app also shows **estimated** grams, kg CO2e and litres of water; see [Estimated grams, CO2e and water (IT_4)](#estimated-grams-co2e-and-water-it_4). It never shows dollars.

**`menu_waste_factors.csv`** (feeds the impact points) gives, for each food:
- a density constant (`weight_g_per_cm2`), so foods that are heavier per unit of visible area weigh more in the points
- a bulk density as served (`density_g_per_cm3`) with its source (`density_source`), used for grams when depth gives a volume (IT_4)
- two environmental impact factors per kg of food: carbon (C) and water (W)
- a combined Waste Impact Score per kg, built from C and W only
- the dining hall's allergen list, an ingredient recipe and the label serving size
- Gemini's plain description of what each dish looks like on a plate, used in the classification prompt and as the demo menu description

**`menu_nutrition_factors.csv`** (reported separately, never in the impact points) gives the nutrition lost per kg (O, in nutrient-days), calories per kg and the dining hall's nutrition label. See [Nutrition points](#nutrition-points-reported-separately-not-in-the-score).

Both files are keyed by `station` + `food`. The app matches a menu item to a row by `factorKey = slug(food)`, for example `Ancho Flank Steak` → `ancho-flank-steak`. The typed copies used by the app are generated from these CSVs (`data/scripts/generate-factors.mjs` → `data/src/factors.generated.ts`, version `waste-factors-v3`; v3 added the density columns), so the CSVs stay the source of truth.

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
   - `impactPoints = base × impact_score_usd_per_kg` (= base × (0.19·C + 1.50·W))
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

A camera calibration supplies the conversion AGENTS.md asks for: the user lays a flat object of known area (a credit card is 46.21 cm²) where plates sit, and the app counts its mask pixels to get `k = cm² per pixel` for that camera and resolution. Each food on a calibrated capture then gets a `PhysicalEstimate` (stored by the backend), and `analytics` derives at read time:

```
area method   (area-calibrated-v1):  area_cm2 = pixels × k
                                     grams    = area_cm2 × weight_g_per_cm2
volume method (volume-dav2-v1):      volume_cm3 = Σ height × footprint over the mask (Depth Anything V2)
                                     grams      = volume_cm3 × density_g_per_cm3
kg_co2e  = grams / 1000 × C
water_L  = grams / 1000 × W × 1000 = grams × W        (W is m³ per kg)
```

- The volume method falls back to the area method (and is reported as `area-calibrated-v1`) when the food has **no density** (the three pizzas and Cheese Bread) or the volume is flagged `bowl_volume_unreliable` (soup in a bowl: the floor is hidden), `depth_invalid` or `depth_unavailable`.
- Unavailable is `null` with a reason, never 0: `no_calibration` (uncalibrated capture), `incompatible_geometry` (different resolution from the calibration), `unknown_item`, `no_factor`, `no_density`.
- Totals add only calibrated plates and say how many ("from 12 of 14 calibrated plates"). Grams per portion is Σ grams ÷ Σ portions, and only when every plate of that food was calibrated.
- Everything is labeled **estimated**. Pixels wasted stays the raw measurement and is always shown. Relative points and nutrition points are unchanged, and nutrition never enters CO2 or water.

**Worked example, area method** (DAv2 off). Calibration: a credit card (46.21 cm²) covers 18,500 pixels, so k = 46.21 / 18,500 = 0.0024978 cm²/px. A leftover of Ancho Flank Steak covers 8,000 pixels:
- area = 8,000 × 0.0024978 = **19.98 cm²**
- grams = 19.98 × 1.2 g/cm² = **23.98 g**
- CO2e = 23.98 / 1000 × 131.69 = **3.16 kg CO2e**
- water = 23.98 × 1.925 = **46.2 L**
- label: `Ancho Flank Steak · 24 g · 3.2 kg CO2e · 46 L water (est.)`

**Worked example, volume method** (DAv2 on). A mound of Sticky Rice has a depth-derived volume of **50 cm³** over a 40 cm² footprint:
- grams = 50 × 0.73 g/cm³ = **36.5 g** (the area method would have said 40 × 1.6 = 64 g; the mound is thinner than the "typical portion" the area constant assumes)
- CO2e = 36.5 / 1000 × 1.78 = **0.065 kg** (shown as `65 g CO2e`)
- water = 36.5 × 0.899 = **32.8 L**
- label: `Sticky Rice · 37 g · 65 g CO2e · 33 L water (est.)`

The same soup bowl measured as 200 cm³ but flagged `bowl_volume_unreliable` with an 80 cm² footprint uses the area method: 80 × 1.5 = **120 g**, not 200 × 1.05 = 210 g.

### Density sources (`density_g_per_cm3`)

The volume from depth is the envelope of the food as it sits on the plate, air gaps included, so the right constant is the **bulk density as served** (grams per cm³ of heaped food), which is what household-measure (cup) densities give. Each row's `density_source` cites the entry used. Sources are the **FAO/INFOODS Density Database v2.0 (2012)** (whose entries come from USDA FNDDS 4.1, Stumbo & Weiss 2011 [S&W], the Kenya child nutrition project database [KEN], R. Charrondière's own measurements [RC] and others) and **USDA SR Legacy** household weights (grams per US cup of 236.6 mL, or per piece of stated dimensions).

| Food | g/cm³ | Source entry | Match |
|---|---|---|---|
| Broccoli Cheddar Soup | 1.05 | FAO/INFOODS "Cheddar cheese soup" 1.046 [S&W] | direct (but bowls usually use the area method) |
| Baked Boneless Ham | 0.70 | FAO/INFOODS "Pork, medium, with bone, boiled" 0.70 [KEN] | analogue: cooked pork pieces |
| Oven Roasted Garlic Potatoes | 0.59 | FAO/INFOODS "Potato, english, boiled" 0.59 [KEN] | analogue: roasted chunks |
| Baked Sweet Potatoes | 0.65 | FAO/INFOODS "Sweet potato, boiled" 0.65 [KEN] | analogue |
| Roasted Cauliflower | 0.45 | FAO/INFOODS "Cauliflower, boiled" 0.45 [RC] | analogue: roasted |
| Michigan Farmers 4 Bean Stew | 1.07 | FAO/INFOODS "Stew, beans/ peas + vegetables" 1.07 [KEN] | direct |
| Farro | 0.73 | FAO/INFOODS "Rice, white, boiled" 0.73 [RC] | analogue: cooked whole grain (no farro entry) |
| Shaved Brussel Sprouts | 0.37 | USDA SR 11098 "Brussels sprouts, raw": 1 cup = 88 g | analogue: shaved, lightly cooked |
| Vegetable Cannelloni | 1.04 | FAO/INFOODS "Lasagna" 1.042 [S&W] | analogue: baked filled pasta |
| Panzanella Salad | 0.56 | composite of recipe components (tomato 0.76 USDA; cucumber/pepper 0.51, bread 0.29, olive oil 0.918, onion 0.55 FAO/INFOODS) | estimate (mass-weighted harmonic mean) |
| Ancho Flank Steak | 0.70 | FAO/INFOODS "Pork, medium, with bone, boiled" 0.70 [KEN] | analogue: cooked meat pieces (only raw beef, 0.96, is listed) |
| Sticky Rice | 0.73 | FAO/INFOODS "Rice, white, boiled" 0.73 [RC] | direct |
| Vegetable Stir Fry Blend | 0.68 | FAO/INFOODS "Stew, vegetable" 0.68 [KEN] | analogue: cooked mixed vegetables |
| Halal Rice | 0.70 | FAO/INFOODS "Rice, boiled with fat" 0.70 [KEN] | direct |
| Tomatoes | 0.76 | USDA SR 11529 "Tomatoes, red, ripe, raw": 1 cup chopped or sliced = 180 g | direct |
| Lettuce | 0.30 | USDA SR 11252 "Lettuce, iceberg, raw": 1 cup shredded = 72 g | direct |
| Cheese Bread, Pepperoni Pizza, Cheese Pizza, Chicken Broccoli Alfredo Pizza | blank | no FAO/INFOODS or USDA volume entry; airy crust under solid melted cheese has no defensible single analogue | area method (`weight_g_per_cm2` is anchored on slice weight ÷ area) |
| Chocolate Coconut Cream Pie | 0.78 | composite: filling 70% at 1.06 ("Yoghurt, plain", set-gel analogue), crust 20% at 0.47 ("Biscuits" 0.41–0.53), topping 10% at 0.496 ("Cream, whipped") | estimate |
| Pumpkin Pie | 0.85 | composite: custard 80% at 1.07 ("Milk, evaporated", analogue), crust 20% at 0.47 ("Biscuits") | estimate |
| Snickers Brownies with Peanuts | 0.52 | USDA SR 18151 "Cookies, brownies, commercially prepared": 1 square 2.75 × 2.75 × 0.875 in (108.4 cm³) = 56 g | direct |
| Peppermint White Chocolate Blondie | 0.52 | same brownie entry | analogue |
| Golden Cake with Chocolate Frosting | 0.42 | FAO/INFOODS "Cake" 0.415 [S&W] | direct |
| Strawberry Shortcake Bar | 0.42 | FAO/INFOODS "Cake" 0.415 [S&W] | analogue: crumb-topped cake bar |

Composites use `1/ρ = Σ (wᵢ/ρᵢ) / Σ wᵢ` over the recipe weights; this ignores oil or sauce filling the gaps between pieces, so it leans low. The test-only rows in `menu_waste_factors_halal_bros.csv` use the same entries (Halal Chicken: cooked meat pieces 0.70; Yellow Rice 0.70; Diced Tomatoes 0.76; Shredded Lettuce 0.30).

## Columns

### `menu_waste_factors.csv` (impact point inputs)
| Column | Meaning |
|---|---|
| `station`, `food` | Menu station and item name |
| `weight_g_per_cm2` | Estimated grams per cm² of top-down plate area (points, and grams for the area method) |
| `density_g_per_cm3` | Bulk density as served, g/cm³ (grams for the Depth Anything V2 volume method); blank = none sourced, so the area method is used |
| `density_source` | The FAO/INFOODS Density Database v2.0 or USDA SR Legacy entry behind `density_g_per_cm3`, whether it is an analogue or composite, or why it is blank |
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

### `menu_nutrition_factors.csv` (reported separately)
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
These are estimates from typical portions. For example, a 14-inch pizza slice covers about 125 cm² and weighs about 110 g, so roughly 1.0 g/cm². A top-down camera can't see how tall food is, so they may be off by 30–50%. In the app they only set how much one food's pixels count relative to another's.

**Checking them** needs a known scale: with a fixed camera whose cm² per pixel has been measured, place one labeled serving on a plate (`label_serving_g` gives its weight), count its pixels, convert to cm², and divide grams by cm².

## Nutrition points (reported separately, not in the score)

The app reports nutrition as its own relative number, from `menu_nutrition_factors.csv`: `nutritionPoints = pixels / 1000 × weight_g_per_cm2 × O`. Like the impact points it is unitless (not nutrient-days), and it is never added to `impactPoints`.

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

1. **Source data:** Gemini was given `dining_hall_menu_labels.pdf` (the original screenshots) and `dining_hall_menu_labels.csv` (the same data transcribed). Neither file contains any of Claude's guesses.
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
| Lettuce | Salad Bar | 0.3 | 0.53 | 0.103 | 0.26 | Poore & Nemecek has no lettuce row, so "Other Vegetables" is used. Shredded leaves are airy, hence the low density |

Nutrition (in `menu_nutrition_factors.csv`, separate from the score) uses the same O formula with USDA values per 100 g: Halal Rice 0.23 (unenriched cooked long-grain rice, oil, onion, salt), Tomatoes 0.44 (raw red tomatoes), Lettuce 0.57 (raw romaine and iceberg, 50/50). The method reproduces the existing Baked Sweet Potatoes row (O 1.80). The densities are estimates like the others: Halal Rice is looser than Sticky Rice (1.6), and a layer of diced tomato is about 0.8 g/cm².

## Caveats
- **Relative impact points are not physical quantities.** They are pixels weighted by the density constants and the factors, so they rank foods against each other but are not kg, litres or dollars. Pixel area also depends on the camera distance and plate size. Accurate pixel counting does not guarantee accurate segmentation.
- **Estimated grams, CO2e and water are estimates, not weighings.** They stack the calibration (a reference area, and DAv2 depth, whose local error on thin food can be large), the AI mask, a density or g/cm² constant (30–50% uncertain) and global-median C and W factors. Use them to see orders of magnitude, not to audit a single plate.
- **Beef uses the global median for beef-herd cattle.** US beef typically comes in lower, so treat the steak's carbon number as upper-range.
- **The flank steak's label matches raw steak,** so its label nutrients were multiplied by 1.35 to reflect cooked meat.
- **Ingredient lists are inferred, not published.** They're consistent with each dish's allergens and nutrition label, but the dining hall only publishes allergens.
- **Label vitamin and mineral percentages are used as printed.** The dining hall's labels may use older Daily Value references.
- **Baked Sweet Potatoes has no label,** so its nutrition is estimated from USDA ingredient values.
- **Soup is the weakest density estimate.** It's liquid in a bowl, so its visible area says little about how much is left.
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
