# vision/sam — SAM 2.1 segmentation worker (Agent 4)

Local HTTP service for the segmentation stage of
**Gemini classification + boxes + target dish → SAM 2.1 masks → target-dish clip → counted Pixels wasted**
([MVP_AI.md](../../docs/plans/MVP_AI.md), [measurement contract](../../contracts/measurement.md)).
The TypeScript side (`vision/src/maskPipeline.ts`) calls it through
`createSamWorkerClient()`; the backend selects it automatically when
`GEMINI_API_KEY` is set.

## Setup

Python ≥ 3.10 with PyTorch ≥ 2.5.1 and Meta's `sam2` package from
[facebookresearch/sam2](https://github.com/facebookresearch/sam2) (installed
from source). Checkpoints download from Hugging Face on first start.

```bash
# from the repo root; .venv/ is gitignored
python3 -m venv .venv
SAM2_BUILD_CUDA=0 .venv/bin/pip install -r vision/sam/requirements.txt   # pinned; sam2 from git @ 2b90b9f
.venv/bin/python vision/sam/worker.py        # http://127.0.0.1:8790
curl -s http://127.0.0.1:8790/health          # {"ok": true, "model": "sam2.1-hiera-small", ...}
```

`requirements.txt` pins the versions verified on the team Mac and installs
`sam2` from source at commit `2b90b9f5ceec907a1c18123530e92e794ad901a4`. The
existing Mac setup instead uses an editable clone at that commit
(`git clone https://github.com/facebookresearch/sam2 ../sam2 && (cd ../sam2 &&
git checkout 2b90b9f && SAM2_BUILD_CUDA=0 ../mhacks/.venv/bin/pip install -e .)`).
Both give `codeRevision` `sam2@2b90b9f` (the editable clone reports the git
revision; a non-editable install reports the package version). The SAM
worker was re-verified with `huggingface_hub` 1.33.0 (2026-10-04).

`huggingface_hub` is required by `SAM2ImagePredictor.from_pretrained` but is
not installed by `sam2` itself. To keep the worker running after the shell
exits (the backend and live E2E tests share it):

```bash
nohup .venv/bin/python vision/sam/worker.py > /tmp/sam_worker.log 2>&1 &
```

**Setup verified 2026-10-04** on the team MacBook (Apple Silicon, MPS):
Homebrew Python 3.14.6, torch 2.14.1, torchvision 0.29.1, `sam2@2b90b9f`
(clone at `/Users/mike/sam2`), venv at `/Users/mike/mhacks/.venv`. The first
start downloads the Small checkpoint (~28 s load). Python 3.14 prints a
harmless `torch.jit.script` FutureWarning.

| Env | Default | Meaning |
| --- | --- | --- |
| `SAM_MODEL_ID` | `facebook/sam2.1-hiera-small` | Checkpoint (MVP default: SAM 2.1 Small) |
| `SAM_DEVICE` | `mps` if available, else `cpu` | Falls back to CPU if MPS fails at startup |
| `WORKER_HOST` (or `SAM_HOST`) / `SAM_PORT` | `127.0.0.1` / `8790` | Bind address (local only); an address with `:` binds IPv6 |
| `WORKER_TOKEN` | _unset_ | When set, `POST /segment` requires `X-Worker-Token: <token>`; missing/wrong ⇒ 401. `/health` stays open. The backend client sends it from its own `WORKER_TOKEN` |
| `SAM_WORKER_URL` (backend) | `http://127.0.0.1:8790` | Where the backend finds the worker |

## Interface

`POST /segment` `{ "image_b64": "<jpeg/png>", "boxes": [[x0, y0, x1, y1], ...] }`
→ `{ widthPx, heightPx, model, checkpoint, codeRevision, device, settingsVersion, elapsedMs, results: [{ maskPngB64, score, foregroundPx }] }`

- Boxes are **pixel XYXY on the supplied image**. Gemini's `[ymin, xmin,
  ymax, xmax]` 0–1000 boxes are converted by the caller
  (`vision/src/masks.ts` `geminiBoxToPixels`); reversed, empty, or
  out-of-image boxes are rejected with 400.
- One image embedding per request; requests are serialized (one lock), so
  concurrent captures never reuse each other's embedding.
- Masks: lossless 8-bit PNG at the image's exact size, **255 = food, 0 =
  background**. The TypeScript side re-validates size and binarity before
  counting (never trusts `foregroundPx` alone).
- Per capture (BIG-PLAN v2, target-dish counting) the pipeline sends ONE
  request whose boxes are: the target-dish food pieces, the food Gemini put
  on other dishes (segmented only for the overlay and the "other dish, not
  counted" pixel count), and last the target dish itself (its mask becomes
  the clip region in `vision/src/targetDish.ts`). More than 128 boxes are
  split into several requests.
- Limits: 25 MB body, 4096² pixels, 1–128 boxes (`MAX_BOXES`). `GET /health` reports the
  model, device, code revision, and settings.

**Settings `sam2-box-v1`:** `multimask_output=False`; binary threshold at
logit 0.0 (the predictor's `mask_threshold`); no hole filling in the worker
(the dish region's fill happens in TypeScript, `dish-region-v3`); no
small-component removal; float32 on MPS/CPU (no CUDA autocast).

## Measured on the team MacBook (M1 Max, MPS)

SAM 2.1 Small, `sam2@2b90b9f`, torch 2.14.1: ~9 s first load (downloads the
checkpoint once), ~0.2–0.35 s per image after warm-up, ~0.4 GB worker RSS plus
~0.3 GB MPS memory. These are single-machine observations, not benchmarks.
Evaluation results: [docs/verification-report.md](../../docs/verification-report.md).
