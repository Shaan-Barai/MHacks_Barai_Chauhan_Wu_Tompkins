# vision/depth — Depth Anything V2 metric-depth worker (IT_4 I4)

Local HTTP service for the optional volume stage:
**SAM masks + Depth Anything V2 depth + camera calibration → estimated food volume**
([IT_4.md](../../IT_4.md) §2 I3–I5). The TypeScript side calls it through
`createDepthWorkerClient()` (`vision/src/depthClient.ts`), used by
`runCalibration()` and the `physical` stage of `analyzeCaptureWithMasks()`.

- Model: **`depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf`** via Hugging Face
  `transformers`, loaded once.
- **License: Small only.** The Small checkpoint is Apache-2.0. The Base and Large
  Depth Anything V2 checkpoints are **CC-BY-NC-4.0 (non-commercial)** and must not be used. The
  worker refuses to start with a model id that is not a Small checkpoint.
- Device: MPS → CUDA → CPU (first that loads and passes a warm-up inference).

## Run (team Mac, shared venv)

The worker runs from the same venv as the SAM worker, `/Users/mike/mhacks/.venv`, on Apple Silicon (MPS).

```bash
# one-time: install into the shared venv (the SAM worker pins agree)
/Users/mike/mhacks/.venv/bin/pip install -r vision/depth/requirements.txt

# start (from the repo root); the first start downloads ~100 MB of weights into ~/.cache/huggingface
/Users/mike/mhacks/.venv/bin/python vision/depth/worker.py           # http://127.0.0.1:8791

# keep it running after the shell exits
nohup /Users/mike/mhacks/.venv/bin/python vision/depth/worker.py > /tmp/depth_worker.log 2>&1 &

curl -s http://127.0.0.1:8791/health
# {"ok": true, "model": "Depth-Anything-V2-Metric-Indoor-Small-hf", "checkpoint": "depth-anything/...",
#  "device": "mps", "settingsVersion": "dav2-metric-small-v1", "tokenRequired": false}
```

Both workers together (SAM :8790 + depth :8791) are started by `deploy/local-up.sh` (workstream P).

| Env | Default | Meaning |
| --- | --- | --- |
| `DEPTH_PORT` | `8791` | Port |
| `WORKER_HOST` (or `DEPTH_HOST`) | `127.0.0.1` | Bind address. Keep it local. An address containing `:` binds IPv6 (e.g. `::`) |
| `WORKER_TOKEN` | _unset_ | When set, `POST /depth` requires header `X-Worker-Token: <token>` (constant-time compare). Missing or wrong ⇒ **401**. `/health` stays open: it returns no image data |
| `DEPTH_MODEL_ID` | `depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf` | Must be a Small checkpoint |
| `DEPTH_DEVICE` | auto (`mps` → `cuda` → `cpu`) | Force a device. A forced non-CPU device still falls back to CPU if it fails at startup |
| `DEPTH_WORKER_URL` (backend) | `http://127.0.0.1:8791` | Where `createDepthWorkerClient()` finds the worker |
| `DEPTH_TIMEOUT_MS` (backend) | `60000` | Client timeout |

The SAM worker reads the same `WORKER_TOKEN` and `WORKER_HOST`. Both TypeScript clients send
`X-Worker-Token` when `WORKER_TOKEN` is set in the backend's environment.

## Interface

`POST /depth` `{"image_b64": "<jpeg/png bytes>"}` →

```json
{ "widthPx": 1024, "heightPx": 1024, "model": "...", "checkpoint": "...", "device": "mps",
  "settingsVersion": "dav2-metric-small-v1", "elapsedMs": 170,
  "depthF32B64": "<little-endian float32 metres, row-major, widthPx × heightPx>",
  "minM": 0.62, "maxM": 1.50 }
```

- One inference per image. The prediction is upsampled with **bicubic** interpolation
  (`align_corners=False`) to the exact input size. Negative bicubic overshoot is clamped to 0.
  The output is checked for size and finiteness before it is sent.
- The image is decoded **without EXIF rotation**, exactly like the SAM worker, so depth aligns
  pixel for pixel with SAM masks of the same bytes. The pipeline sends the normalized 1024² capture.
- Requests are serialized (one lock). Limits: 25 MB body, 4096² pixels (a raw 24 MP phone photo
  is rejected with 400, so normalize first). Errors: 400 bad input, 401 token, 413 body size,
  500 model failure (the worker keeps serving).

**Settings `dav2-metric-small-v1`:** processor defaults (short side resized to 518, a multiple of
14, aspect kept, ImageNet normalization), fp32, bicubic upsampling to the input size, clamp ≥ 0.

**Storage:** the backend stores depth maps as `depth-png16-v1`: a 16-bit greyscale PNG of the
**raw** DAv2 depth in 0.1 mm units (`round(m × 10000)`, clamped to 1..65535, max 6.55 m). 0 means
no valid depth. Encode and decode with `encodeDepthPng16` / `decodeDepthPng16`. The calibration
`scale` is stored separately and never baked into the PNG.

## Measured on the team MacBook (M1 Max, MPS), 2026-10-04

transformers 5.18.0, torch 2.14.1, Python 3.14.6. ~10 s first load (download + warm-up),
**~170 ms per 1024² image** warm (540 ms first request). These are single-machine observations,
not benchmarks.

## Accuracy (live, 2026-10-04): not validated for food volume

On three `test2/` phone photos (an iPhone held about 22–30 cm above the plate), DAv2 Metric Indoor Small:

- reported camera distances of **90–108 cm**, which is 3–5× the geometric value. The calibration
  `scale` corrects only that global factor;
- placed most leftover food **at or below** the surrounding plate surface, so it does not resolve
  centimetre-scale food relief at this range.

So `volume.ts` falls back to the calibrated area for such foods (flags `negative_heights_clipped` +
`depth_invalid`). The volume method stays off by default (`depthEnabled: false`). Before enabling
it, validate on C920s frames with an object of known volume. See `vision/README.md` "IT_4 live check".
