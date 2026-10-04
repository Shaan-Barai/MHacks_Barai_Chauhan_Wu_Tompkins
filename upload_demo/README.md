# Upload website (photo check)

A two-page website. The first page has one **Upload a photo** button. After the upload, the visitor
lands on `/results/<id>`, which shows the total food wasted (per food and in total, in pixels) and
four pictures: the original, Gemini's classification boxes, the SAM 2.1 masks and the final counted
result.

```bash
node upload_demo/server.mjs               # http://localhost:8795
HOST=0.0.0.0 node upload_demo/server.mjs  # also reachable from phones on the same Wi-Fi
python3 demo.py --only upload_site        # demo step: starts it, runs the sample bowl, opens the results page
```

It needs `GEMINI_API_KEY` in `.env`, the SAM 2.1 worker on `:8790` (`vision/sam/worker.py`), and a
built `vision/` (`cd vision && npm run build`). There is nothing else to install.

- **Pipeline.** `pipeline.mjs` calls vision's `analyzeCaptureWithMasks`, the same measurement the
  backend uses (Gemini classify + boxes → SAM 2.1 → target-dish clip → pixel count), then renders the
  four pictures.
- **Foods.** Every photo is matched against **every food in the food database** (`loadFoodDatabase`
  in `pipeline.mjs`): the 26 dinner foods in `factors/menu_waste_factors_EastQuad.csv` plus Halal
  Chicken from `factors/menu_waste_factors_halal_bros.csv`. There is no menu choice. Food that matches
  none of them is counted as unclassified. The Try an Image tab in the dashboard uses the same database.
- **Numbers.** Pixels wasted is the measurement: visible leftover-food pixels in AI masks, not grams.
  `POST /api/analyze` still returns each food's relative CO2/water/nutrition points in `summary`
  (used by `demo.py`); the pages don't show them.
- **Storage.** Uploads are analysed in memory. The last 20 results stay in memory so their results
  pages can be reloaded; they are gone when the server restarts. Nothing goes to R2 or SpacetimeDB,
  so demo uploads never mix into a dining hall's dashboard data.
- **Limits.** Uploads must be under 20 MB, and one analysis runs at a time (the SAM worker is a
  single local process). Each upload costs 2 Gemini calls.

**API:** `POST /api/analyze` (image body) → `{ id, summary, images }`; `GET /api/results/<id>` → the same
`{ summary, images }`; `GET /api/foods` lists the food database.

`make-demo-pictures.mjs` uses the same pipeline (with a title bar on each picture) to write
`demo_pictures/`, the halal chicken + rice bowl walkthrough.
