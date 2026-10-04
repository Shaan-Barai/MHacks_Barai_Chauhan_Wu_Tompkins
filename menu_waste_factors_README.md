# Waste Impact Factors: Dinner Menu

Two files hold per-food constants for the 23 items on the test dining hall's dinner menu: the 22 dishes on the nutrition sheet plus Baked Sweet Potatoes, which appeared on an earlier menu.

**What the app reports (BIG-PLAN v2, 2026-10-04).** The measurement is **Pixels wasted**: leftover-food pixels counted from validated SAM 2.1 masks, only on the dish being scanned. The app has no plate-size calibration and shows no grams, kg CO2e, litres or dollars. To let a pixel of beef count for more than a pixel of rice, it turns pixels into unitless **relative impact points** using the factors in these files.

**`menu_waste_factors.csv`** (feeds the impact points) gives, for each food:
- a density constant (`weight_g_per_cm2`), so foods that are heavier per unit of visible area weigh more in the points
- two environmental impact factors per kg of food: carbon (C) and water (W)
- a combined Waste Impact Score per kg, built from C and W only
- the dining hall's allergen list, an ingredient recipe and the label serving size
- Gemini's plain description of what each dish looks like on a plate, used in the classification prompt and as the demo menu description

**`menu_nutrition_factors.csv`** (reported separately, never in the impact points) gives the nutrition lost per kg (O, in nutrient-days), calories per kg and the dining hall's nutrition label. See [Nutrition lost](#nutrition-lost-not-part-of-the-score).

Both files are keyed by `station` + `food`. The app matches a menu item to a row by `factorKey = slug(food)`, for example `Ancho Flank Steak` → `ancho-flank-steak`. The typed copies used by the app are generated from these CSVs (`data/scripts/generate-factors.mjs` → `data/src/factors.generated.ts`, version `waste-factors-v2`), so the CSVs stay the source of truth.

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

The points are **unitless and relative**. They compare foods with each other (the same leftover area of steak counts for far more than potatoes), but they are not kilograms, litres or dollars, and a points total is not a physical amount. Since the app has no plate-size calibration, a pixel is not a fixed area: plates and photos differ, so points are best compared within the same camera setup.

Food the classifier could not match to the menu keeps its pixels but has no factor row, so its points are unavailable ("no impact factor"), never zero. The same holds for a menu item without a factor row.

**Example:** a 10,000-pixel leftover of pepperoni pizza (1.0 g/cm², C 16.06, W 1.94, score 5.96)
- Base: 10,000 / 1000 × 1.0 = **10**
- CO2 points: 10 × 16.06 = **160.6**
- Water points: 10 × 1.94 = **19.4**
- Relative impact points: 10 × 5.96 = **59.6**
- Nutrition points (separate, not in the score): 10 × 0.69 = **6.9**

For comparison, the same 10,000 pixels of Ancho Flank Steak (1.2 g/cm², score 27.91) is 12 × 27.91 = **334.9** relative impact points, and of Oven Roasted Garlic Potatoes (1.6 g/cm², score 0.29) is 16 × 0.29 = **4.6**.

**Waste per portion.** To find foods to target, the app divides an item's summed pixels by its summed portions served for the same hall, date, meal and menu version (sum first, then divide), and shows the matching relative impact points per portion beside it. Missing or zero portion counts make the rate unavailable. The demo portion counts are dummy values labeled `demo`.

**Physical units later.** A fixed camera at a fixed height would give a constant cm² per pixel. Measuring it once (for example with a reference card of known size) would turn pixels into cm², and then `grams = cm² × weight_g_per_cm2` and `kg × C`, `kg × W` would give real kg CO2e and m³ of water. The app does not do this today.

## Columns

### `menu_waste_factors.csv` (impact point inputs)
| Column | Meaning |
|---|---|
| `station`, `food` | Menu station and item name |
| `weight_g_per_cm2` | Estimated grams per cm² of top-down plate area |
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

## Nutrition lost (not part of the score)

The app reports nutrition lost as its own relative number, **nutrition points**, from `menu_nutrition_factors.csv`: `nutritionPoints = pixels / 1000 × weight_g_per_cm2 × O`. Like the impact points it is unitless (not nutrient-days), and it is never added to `impactPoints`.

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

The result is always positive. Desserts get small values (0.39–0.55 per kg; pumpkin pie is 0.97 thanks to its vitamin A). Vegetables get the most: sweet potatoes 1.80, stir fry 1.58, brussels sprouts 1.31. The lowest is sticky rice at 0.24.

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
- **Lowest:** Baked Sweet Potatoes, 0.12, then Vegetable Stir Fry Blend (0.21) and Oven Roasted Garlic Potatoes (0.29).
- **Largest factor:** water for 17 foods, carbon for 6 (the flank steak, pepperoni pizza, the Snickers brownies, the two vegan desserts and the sweet potatoes).
- **Nutrition** (separate): highest for the vegetables (sweet potatoes 1.80, stir fry 1.58 nutrient-days per kg), lowest for sticky rice (0.24).

## Caveats
- **Relative impact points are not physical quantities.** They are pixels weighted by the density constants and the factors, so they rank foods against each other but are not kg, litres or dollars. Pixel area also depends on the camera distance and plate size, which the app does not calibrate. Accurate pixel counting does not guarantee accurate segmentation.
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
