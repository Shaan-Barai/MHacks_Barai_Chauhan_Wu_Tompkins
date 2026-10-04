# How ScrapSaver stores its data

ScrapSaver keeps data in **two places**:

| Place | What it holds | Analogy |
| --- | --- | --- |
| **SpacetimeDB** (the database) | Small text-and-number records: menus, which plates were scanned, what the AI found, how many pixels of each food were left, portions served | A filing cabinet of index cards |
| **Cloudflare R2** (the image bucket) | The actual pictures: each plate photo, the AI's mask for each food, and the colored "segmented" image | A photo album |

The database never stores pictures. It stores an **address** for each picture (its R2 "object key", like `captures/2026-10-03/cap_123_ab12cd.jpg`). When the dashboard wants to show a picture, the backend gives it a short-lived link to that address in R2.

## The journey of one plate

```text
1. Camera on the Arduino Uno Q takes a photo
2. The laptop copies it into images/arduino-inbox/
3. The bridge decides "is this a new dish?" (so a plate is counted once)
4. Photo is uploaded to R2                       → R2: captures/...jpg
5. Database gets an image_object card for it     → SpacetimeDB: image_object
6. Database gets a capture_event card            → SpacetimeDB: capture_event
7. Gemini names each food and draws a box around it
8. SAM traces the exact outline (mask) of each food
9. Masks + colored overlay are uploaded to R2    → R2: masks/...png, overlays/...jpg
10. Database records what was found               → analysis_attempt, food_measurement,
                                                    capture_count, segmentation_region,
                                                    attempt_calibration
11. Dashboard adds it all up (grams, CO2, water, $ per portion) when you open it
```

## The tables, one by one

Think of each table as a stack of cards, one card per thing.

### What the dining hall serves

| Table | One card = | Key facts on the card |
| --- | --- | --- |
| `meal_service` | one meal at one hall on one day (e.g. hall-main, Oct 3, dinner) | hall, local date, meal, which menu, menu version |
| `menu_item` | one food on that menu (e.g. "Ancho Flank Steak") | name, station, a short description of how it looks (helps Gemini recognize it) |
| `portions_served` | how many portions of one food were served at one meal | count, and where the number came from: `manual`, `csv`, or `demo` (the current numbers are **demo** numbers) |
| `attendance` | how many people ate at one meal | count. Always labeled **simulated** for now |
| `reference_portion` | optional: how big one untouched serving looks, in pixels | used only for side comparisons; not needed for the main numbers |

### What the camera saw

| Table | One card = | Key facts on the card |
| --- | --- | --- |
| `image_object` | one picture stored in R2 | its R2 address, size, type, and **what it belongs to**: `capture` (the plate photo), `mask` (one food's outline), `overlay` (the colored segmented image), or `reference` |
| `capture_event` | one physical dish that went past the camera | when, which meal, which photo (`image_object`), where it came from (`camera`, `replay`), and its status: `pending` → `processing` → `succeeded` / `needs_review` / `failed` |

### What the AI found

| Table | One card = | Key facts on the card |
| --- | --- | --- |
| `analysis_attempt` | one try at analyzing a dish (retries make new cards, never duplicate dishes) | which AI model and prompt version, which menu version, success or failure |
| `segmentation_region` | one food box Gemini drew on the photo | the food it thinks it is (or unknown), the box, and the id of SAM's mask picture in R2 |
| `food_measurement` | one food's leftover amount on one dish | the food (or unknown), **pixels wasted** counted from the mask (column `remainingAreaPx`, with the mask's provenance in `maskCountJson`), quality flags |
| `capture_count` | the whole-plate total for one attempt | total pixels wasted on the plate (overlaps counted once), which SAM model/settings were used |
| `attempt_calibration` | the "ruler" for one attempt | how wide the plate looked in pixels (plate = 26.7 cm), so each pixel = so many cm²; plus the id of the colored overlay picture |
| `insight` | one saved AI suggestion | the advice text, the numbers it was based on, and whether it came from Gemini or the rule-based fallback |

## How the cards connect

```text
meal_service ──< menu_item            (a meal has many foods)
meal_service ──< portions_served      (portions per food per meal)
meal_service ──< capture_event        (a meal has many scanned dishes)
capture_event ── image_object         (the plate photo, in R2)
capture_event ──< analysis_attempt    (one or more tries)
analysis_attempt ──< segmentation_region ── image_object (mask, in R2)
analysis_attempt ──< food_measurement ── menu_item       (which food)
analysis_attempt ── capture_count                         (plate total)
analysis_attempt ── attempt_calibration ── image_object   (overlay, in R2)
```

Cards point at each other by **id** (like `svc_hall-main_2026-10-03_dinner` or `item_hall-main_2026-10-03_dinner_ancho-flank-steak`), never by food name.

## What is *not* stored, and why

The dashboard's grams, CO2, water and dollar numbers are **not** saved in the database. They are worked out fresh each time from three stored things:

1. **Pixels wasted** for a food (from `food_measurement`)
2. **The ruler** for that photo (from `attempt_calibration`)
3. **That food's factors** (from `menu_waste_factors.csv`: grams per cm², CO2 per kg, water per kg)

```text
cm²    = pixels × cm² per pixel                 (the ruler)
grams  = cm² × grams per cm²                    (the food's weight factor)
CO2e   = kg × kg CO2e per kg
water  = kg × m³ water per kg
impact = kg × (0.19 × CO2e per kg + 1.50 × m³ water per kg)   dollars
waste per portion = grams wasted ÷ portions served
```

Nutrition lost (from `menu_nutrition_factors.csv`) is shown separately and is **not** part of the impact score.

Because these numbers are calculated, fixing a factor in the CSV updates every past result without touching the database. All of them are **estimates**: the AI's outline can be off, a top-down photo can't see how tall food is, and the weight factors are typical values.

## R2 folders

| Folder | Contents |
| --- | --- |
| `captures/<date>/` | plate photos (1024 × 1024 JPEG, as uploaded by the bridge) |
| `masks/<date>/` | one black-and-white PNG per food outline (white = food) |
| `overlays/<date>/` | the colored segmented image with a legend, one per analysis attempt |
| `references/<date>/` | optional reference-serving photos |

The bucket is private. Links the dashboard gets expire after a short time and are renewed automatically.

## Who can see what

Tables marked public (`meal_service`, `menu_item`, `capture_event`, `food_measurement`, `portions_served`, `attendance`, `insight`, `reference_portion`) can be read by any SpacetimeDB subscriber. The others (`image_object`, `analysis_attempt`, `capture_count`, `segmentation_region`, `attempt_calibration`) are private: only the backend reads them, using the owner token in `.env`. The R2 credentials never leave the backend.

## Local databases

- `scrap`: the original local database. Left untouched by the BIG-PLAN work.
- `scrap-bigplan`: the database for this version (it has the new `attempt_calibration` table). Start the backend with `SPACETIMEDB_MODULE=scrap-bigplan`.
