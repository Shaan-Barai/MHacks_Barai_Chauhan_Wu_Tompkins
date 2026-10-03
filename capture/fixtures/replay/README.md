# Demo replay captures (labeled replay data)

Synthetic top-down plate photos for the Scrap demo, replayed through the real
upload → finalize → ingest flow with `npm run replay` (source label `replay`).

- **Provenance:** every image in `images/` was generated on 2026-10-03 with
  Google's `gemini-3.1-flash-image` model from text prompts describing a plate
  of leftovers drawn from the demo-seed menu (`data/seed/demo-seed.json`).
  They are **AI-generated, not photos of real diners or a real dining hall**,
  contain no people or personal data, and were downscaled to 1024×1024 JPEG.
- **Manifests:** one per meal service (`demo-<date>-<meal>.json`), matching
  the demo-seed service IDs. `dinner-1003-empty.jpg` is a deliberately clean
  plate (valid capture, no per-item measurements).
- Waste numbers produced from these images are live Gemini **estimates** of
  synthetic images — useful for exercising the pipeline, not evidence of
  real-world accuracy.
