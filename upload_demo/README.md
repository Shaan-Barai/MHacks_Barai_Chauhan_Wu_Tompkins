# Upload website (photo check)

A one-page website where anyone uploads a food photo and sees every pipeline stage. For each food
found, it shows the database's carbon, water and nutrition factors.

```bash
node upload_demo/server.mjs               # http://localhost:8795
HOST=0.0.0.0 node upload_demo/server.mjs  # also reachable from phones on the same Wi-Fi
python3 demo.py --only upload_site        # demo step: starts it, runs the sample bowl, opens it
```

It needs `GEMINI_API_KEY` in `.env`, the SAM 2.1 worker on `:8790` (`vision/sam/worker.py`), and a
built `vision/` (`cd vision && npm run build`). There is nothing else to install.

- **Pipeline.** `pipeline.mjs` calls vision's `analyzeCaptureWithMasks`, the same measurement the
  backend uses (Gemini classify + boxes → SAM 2.1 → target-dish clip → pixel count). It then renders
  four step pictures: original, Gemini boxes, raw SAM masks, and the final counted overlay.
- **Food database.** 27 foods: the 26-food dinner table (`menu_waste_factors.csv` +
  `menu_nutrition_factors.csv`) plus Halal Chicken from `menu_waste_factors_halal_bros.csv`. The
  other Halal Bros rows duplicate Halal Rice, Tomatoes and Lettuce, so they are not added. Visitors
  can match against all 27 foods or only Halal Chicken + Halal Rice.
- **Numbers.** Pixels wasted is the measurement. CO2, water and nutrition **points** are relative
  (unitless) and are never shown as kg or litres. A phone photo has no camera calibration, so this
  site shows no grams.
- **Storage.** Uploads are analysed in memory and discarded. Nothing goes to R2 or SpacetimeDB,
  so demo uploads never mix into a dining hall's dashboard data.
- **Limits.** Uploads must be under 20 MB, and one analysis runs at a time (the SAM worker is a
  single local process). Each upload costs 2 Gemini calls.

`make-demo-pictures.mjs` uses the same pipeline to write `demo_pictures/`, the halal
chicken + rice bowl walkthrough.
