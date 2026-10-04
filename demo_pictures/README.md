# Demo pictures: halal chicken + rice bowl

Every stage of the ScrapSaver pipeline on one real leftover tray, a halal chicken + rice bowl
photographed by the Uno Q camera on 2026-10-04 ([`0_input_photo.jpg`](0_input_photo.jpg), 1920×1080).
Gemini was given exactly two labels: **Halal Chicken** and **Halal Rice**.

| Step | File | What it shows |
|---|---|---|
| 0 | [`0_input_photo.jpg`](0_input_photo.jpg) | The camera's raw photo, unchanged. |
| 1 | [`1_original.jpg`](1_original.jpg) | The photo as analysed: EXIF-rotated and scaled to 1024×576 (long side 1024 px). Nothing is cropped. |
| 2 | [`2_gemini_boxes.jpg`](2_gemini_boxes.jpg) | Gemini (`gemini-3.5-flash`, prompt `scrap-localize-v4`) labels each piece and boxes it: 14 Halal Chicken (red) and 7 Halal Rice (green) on the tray. The dashed amber box is the target dish. 3 grey dashed boxes are rice grains on the table, which are not counted. |
| 3 | [`3_sam_segmentation.jpg`](3_sam_segmentation.jpg) | Raw Meta SAM 2.1 (`sam2.1-hiera-small`) output: one mask per Gemini box (one colour each), off-dish masks in grey, and the edge of SAM's tray mask in amber. This is before overlaps are resolved and before the dish clip. |
| 4 | [`4_final_result.jpg`](4_final_result.jpg) | Final count: overlapping masks are resolved so each pixel is counted once, and masks are clipped to the tray (cyan outline). The legend shows **Pixels wasted** per food and relative CO2 points. |

## Result

| Food | Pixels wasted | kg CO2e per kg (database) | Water m³ per kg | CO2 points | Water points |
|---|---:|---:|---:|---:|---:|
| Halal Rice | 111,502 | 1.90 | 0.866 | 275.4 | 125.5 |
| Halal Chicken | 31,992 | 12.16 | 0.812 | 466.8 | 31.2 |
| **Total** | **143,494** | | | **742.2** | **156.7** |

Rice covers 3.5× more pixels than chicken. Chicken still accounts for more CO2 points, because its
carbon factor is 6.4× higher per kg. Another 533 px of food lay off the tray and was not counted.

Full details are in [`results.json`](results.json): every box (Gemini 0–1000 yxyx and pixel xyxy),
SAM score and mask pixels, quality flags, and model and prompt versions.

**How to read these numbers.** Pixels wasted counts visible leftover-food pixels in AI-generated
masks. It is not grams or servings. Points are unitless and only compare foods with each other:
`base = pixels / 1000 × g/cm²`, then `CO2 points = base × C` and `water points = base × W`, using the
factors in `menu_waste_factors.csv` and `menu_waste_factors_halal_bros.csv` (Halal Chicken). See
`menu_waste_factors_README.md`.

**Known limitation visible here.** SAM's rice mask at the lower right includes some bare, reflective
foil between rice grains. Counting is exact, but the mask is an AI estimate.

## Regenerate

```bash
node upload_demo/make-demo-pictures.mjs [photo]   # needs GEMINI_API_KEY (.env) + SAM worker on :8790
```

This is a live run (2 Gemini calls), so box counts and pixels vary slightly between runs.
