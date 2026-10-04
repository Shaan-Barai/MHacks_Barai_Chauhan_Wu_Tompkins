# Waste Impact Score: Dinner Menu Factors

`menu_waste_factors.csv` holds per-food constants for the 23 items on the test dining hall's dinner menu: the 22 dishes on the nutrition sheet plus Baked Sweet Potatoes, which appeared on an earlier menu. For each food it gives:
- a weight constant, to turn leftover pixels into grams
- three impact factors per kg wasted: carbon (C), water (W) and lost nutrition (O)
- a combined Waste Impact Score in dollars per kg
- the dining hall's own nutrition label, allergen list and an ingredient list
- a plain description of what each dish looks like on a plate, for the Gemini prompt

## The formula

```
Waste Impact Score ($ per kg) = s·C + t·W + e·O
```

| Factor | Meaning | Unit | Weight | Why this weight |
|---|---|---|---|---|
| **C** | Greenhouse gas emissions to produce the food | kg CO2e per kg | **s = $0.19** per kg CO2e | Social cost of carbon, about $185–190 per tonne (Rennert et al. 2022, *Nature*; EPA 2023) |
| **W** | Freshwater withdrawn to produce the food | m³ per kg | **t = $1.50** per m³ | Replacement cost of water (True Price & Wageningen Economic Research, €1.29/m³) |
| **O** | Nutrition lost when the food is thrown away | nutrient-days per kg | **e = $9.39** per nutrient-day | Cost of a nutritionally adequate day of food (USDA Thrifty Food Plan, May 2026, average adult 20–50) |

C, W and O are in different units, so the weights convert each one to dollars. This follows the "true cost accounting" approach the UN FAO uses to put a price on food's hidden environmental and health costs (FAO, *State of Food and Agriculture 2023*). Every weight is a published value, not an opinion.

## Turning pixels into impact

1. **Calibrate the camera once.** Measure the plate's diameter in pixels. With a 26.7 cm (10.5") plate spanning 600 px, each pixel is 26.7 / 600 = 0.0445 cm wide, or about 0.002 cm². Keep the camera height fixed after this.
2. **Area:** `cm² = leftover pixels × cm² per pixel`
3. **Weight:** `grams = cm² × weight_g_per_cm2`
4. **Impact:** `kg wasted × each factor`, or `kg wasted × impact_score_usd_per_kg`

**Example:** a 10,000-pixel leftover of pepperoni pizza
- 10,000 × 0.002 = 20 cm² → 20 × 1.0 g/cm² = **20 g**
- Carbon: 0.020 × 16.06 = **0.32 kg CO2e**
- Water: 0.020 × 1.94 = **0.039 m³** (39 L)
- Nutrition: 0.020 × 0.69 = **0.014 nutrient-days**
- Score: 0.020 × $12.46 = **$0.25**

## Columns

**Scores**
| Column | Meaning |
|---|---|
| `station`, `food` | Menu station and item name |
| `weight_g_per_cm2` | Estimated grams per cm² of top-down plate area |
| `C_kg_co2e_per_kg` | Greenhouse gas emissions per kg of food as served |
| `W_water_m3_per_kg` | Freshwater withdrawals per kg (m³) |
| `O_nutrient_days_per_kg` | Nutrition lost per kg wasted (see below) |
| `kcal_per_kg` | Calories per kg (from the label where available) |
| `nutrient_credit_days` | The nutrient part of O, after the quality multiplier |
| `calorie_credit_days` | The calorie part of O |
| `quality_multiplier` | 1.0 = no excess sugar, saturated fat or sodium; lower = more of them |
| `carbon_usd_per_kg`, `water_usd_per_kg`, `nutrition_usd_per_kg` | Each factor converted to dollars |
| `impact_score_usd_per_kg` | Total of the three dollar amounts |
| `largest_factor` | Which of the three contributes most |
| `menu_co2_label` | The dining hall's own CO2 icon (high / medium / low), for comparison |

**Ingredients and sources**
| Column | Meaning |
|---|---|
| `nutrition_source` | Whether O came from the dining hall label or from a recipe estimate |
| `allergens_listed` | The "Contains" list from the dining hall's label |
| `claude_ingredients` | Claude's inferred ingredient list. The dining hall only publishes allergens, so the rest is inferred from the dish name, allergens and nutrition label |
| `claude_visible_components` | Claude's description of what the dish looks like on a plate, for the Gemini prompt |
| `gemini_ingredients`, `gemini_visible_components` | Blank, to be filled with Gemini's own inferences for the comparison experiment |
| `claude_recipe_kg_per_kg` | Recipe used for C and W: kg of each ingredient per kg of finished dish |
| `label_*` | The dining hall's nutrition label per serving, exactly as printed |
| `notes` | Assumptions specific to that item |

## How each factor is calculated

### C and W: environmental impact
- **Source:** Poore & Nemecek (2018), *Science*, the largest meta-analysis of food life-cycle studies (via Our World in Data). Values are global medians covering the full supply chain: land-use change, farming, processing, transport, packaging and retail.
- **Butter and cream** aren't in that dataset, so they are milk's footprint scaled by the butter:milk and cream:milk ratios from Clune et al. (2017), *Journal of Cleaner Production*.
- **Dishes** are the weighted sum of their ingredients (see `recipe_kg_per_kg`), adjusted for cooking. Cooked meat is about 1.35 kg raw per kg cooked.
- **Recipes are checked against the labels.** Each recipe was adjusted so its calories line up with the dining hall's label, most within about 10%. The very low-calorie vegetables are off by a few calories in absolute terms. The labels also corrected three assumptions:
  - The **Chocolate Coconut Cream Pie** and **Golden Cake** are vegan: 0 mg cholesterol, and no milk or eggs listed.
  - The **pepperoni is beef**, not pork. This raises the pepperoni pizza's carbon factor.

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

### Weight constants (g/cm²)
These are estimates from typical portions. For example, a 14-inch pizza slice covers about 125 cm² and weighs about 110 g, so roughly 1.0 g/cm². A top-down camera can't see how tall food is, so they may be off by 30–50%.

**Calibrate them** by placing one labeled serving on a plate (`label_serving_g` gives its weight), counting its pixels, and dividing grams by cm².

## Ingredient experiment: Claude's guesses vs. Gemini's
Neither model knows the real recipes, since the dining hall only publishes allergens. To find which ingredient descriptions work better for classification:

1. **Source data:** give Gemini `dining_hall_menu_labels.pdf` (the original screenshots) and `dining_hall_menu_labels.csv` (the same data transcribed). Neither file contains any of Claude's guesses.
2. **Gemini's guesses:** have Gemini fill in `gemini_ingredients` and `gemini_visible_components` from that source data alone.
3. **Run both:** run the same plate photos through the same pipeline twice, once with the `claude_` columns in the classification prompt and once with the `gemini_` columns. Change nothing else.
4. **Compare** against plates you've labeled by hand.

## Results at a glance
- **Highest:** Ancho Flank Steak, $37.77/kg, where carbon is about two-thirds of the score.
- **Next:** Baked Sweet Potatoes ($16.98), Cheese Bread ($15.56) and Vegetable Stir Fry ($15.08).
- **Lowest:** Sticky Rice, $3.97/kg.
- **Largest factor:** nutrition for every food except beef, where carbon dominates.

## Caveats
- **Beef uses the global median for beef-herd cattle.** US beef typically comes in lower, so treat the steak's carbon number as upper-range.
- **The flank steak's label matches raw steak,** so its label nutrients were multiplied by 1.35 to reflect cooked meat.
- **Ingredient lists are inferred, not published.** They're consistent with each dish's allergens and nutrition label, but the dining hall only publishes allergens.
- **Label vitamin and mineral percentages are used as printed.** The dining hall's labels may use older Daily Value references.
- **Baked Sweet Potatoes has no label,** so its nutrition is estimated from USDA ingredient values.
- **Soup is the weakest weight estimate.** It's liquid in a bowl, so its area says little about its weight.
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
