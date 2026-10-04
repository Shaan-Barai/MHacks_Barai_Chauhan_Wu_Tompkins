# Bridge: Uno Q inbox → R2 + SpacetimeDB

**Status (2026-10-03): implemented.** Fixture-tested and smoke-tested against an offline backend.
Not yet tested live with Gemini, R2, or the real camera (section 6). Without the board, use
`npm run simulate-camera` (below).

**Core rule: each physical dish is counted once.** Many frames, manual or automatic, can show the
same plate. They are grouped into one **dish group**, and only one representative frame per group is
uploaded and submitted as a `CaptureEvent`. Gemini decides whether a new frame shows the same dish.

## Run it

```bash
# 1. Backend running with GEMINI_API_KEY, OBJECT_STORAGE_PROVIDER=r2, SPACETIMEDB_URI (see README)
# 2. Camera writing to images/arduino-inbox/ (capture/uno-q/README.md)
python3 capture/uno-q/laptop_capture.py --target arduino@YOUR_BOARD_IP --auto
# 3. Bridge, in another terminal
cd capture && npm run ingest-inbox -- --service svc_hall-main_2026-10-03_lunch --watch
```

| Option | Meaning |
| --- | --- |
| `--service <id>` | Required. `hallId` comes from `GET /api/services` |
| `--watch` | Keep scanning; Ctrl+C closes and ingests the open dish. Without it: one pass, then exit |
| `--inbox <dir>` | Default `<repo>/images/arduino-inbox` |
| `--poll <s>` / `--idle <s>` | Scan interval (default 2) / close the open dish after this long with no new photos (default 10) |
| `--no-dedupe` | One dish per manual photo, no Gemini; `--auto` frames are skipped. Prints a warning |
| `--state-dir <dir>` | Where `.inbox-groups.json` / `.inbox-ingest.json` live. Default `capture/` |
| `API_URL` | Backend, default `http://localhost:8787` |

Output: `+` new dish, `■` dish closed, `✓ dish … → <eventId> (<state>)` ingested, `?` an unsure
merge, `✗` a bad capture or failed upload, `⏸` paused because dish comparison is unavailable.

### Run it without the board: `simulate-camera`

`capture/scripts/simulate-camera.mjs` writes existing photos (default: every `test2/*.jpeg`) into an
inbox exactly as `laptop_capture.py` saves a **manual** capture: `<inbox>/<uuid4>/photo.jpg` (bytes
unchanged) + `metadata.json` (the same protocol-v1 fields, 2-space JSON), written into a dot-prefixed
`.receive-*` folder, fsynced, then renamed. Each photo is one new capture, i.e. one distinct dish.

```bash
cd capture
npm run simulate-camera -- --count 3                       # → images/arduino-inbox, then run the bridge
npm run simulate-camera -- --count 3 --interval 2 \
  --service svc_hall-main_2026-10-03_dinner                # also runs one bridge pass (--no-dedupe)
npm run simulate-camera -- --inbox /tmp/inbox --photos path/to/photos --count 2
```

| Option | Meaning |
| --- | --- |
| `--inbox <dir>` | Default `<repo>/images/arduino-inbox` |
| `--photos <path>` | A JPEG or a folder of `.jpg`/`.jpeg` (default `<repo>/test2`) |
| `--count <n>` | First *n* photos by name (default all; more than available is an error) |
| `--interval <s>` | Seconds between photos (default 0) |
| `--service <id>` | After writing, run one `ingest-inbox` pass for this service |
| `--dedupe` | With `--service`: Gemini grouping instead of `--no-dedupe` |
| `--state-dir <dir>` | With `--service`: passed through to `ingest-inbox` |

**How it complements `live_camera_test.py`.** `capture/scripts/live_camera_test.py` (§6) is the
hardware check: real board, real C920 frames, Gemini grouping in `--watch`, `source = camera`. The
simulator replaces only the board + SSH step, so the rest of the path (bridge → R2 → SpacetimeDB →
Gemini + SAM → overlay → dashboard API) can be run and asserted repeatably without hardware; the live
E2E `tests/e2e/bigplan-live.test.mjs` uses it. Both use the bridge's `--state-dir` to keep their state
out of `capture/.inbox-*.json`.

**Labeling.** Only two values differ from a real capture: `captureSource: "simulated_camera"` and
`device: "simulate-camera:<file>"`. The inbox reader turns that into `InboxFrame.simulated`, and the
bridge submits those dishes with `source: 'replay'` instead of `'camera'` (AGENTS.md §3.7: demo data is
labeled). Everything else (grouping, normalization, upload, analysis) is the real camera path.

**Dedupe or not.** Each simulated photo is a different plate, so `--no-dedupe` (one dish per manual
photo, no Gemini) is the default with `--service` and in the live E2E: it is deterministic and spends
no Gemini calls on same-dish checks. Use `--dedupe` to exercise Gemini grouping on purpose; an
`unsure` verdict can then merge two different photos (§3, by design).

## 1. What it connects

```text
Uno Q + C920s ── SSH ──▶ laptop_capture.py ──▶ images/arduino-inbox/<uuid>/{photo.jpg,metadata.json}
                                                     │
                                         capture: ingest-inbox (this bridge)
                                                     │  group frames ──▶ POST /api/dish-match ──▶ Gemini
                                                     ▼  one frame per dish
                     POST /api/images/uploads → PUT presigned R2 URL → POST /api/images/:id/finalize
                     → POST /api/captures → analysis → SpacetimeDB (image_object, capture_event,
                       analysis_attempt, food_measurement)
```

## 2. Components

| Piece | Owner | Location |
| --- | --- | --- |
| Inbox reader (complete dirs, checksum re-verify) | 3 | [capture/src/inbox.ts](capture/src/inbox.ts) |
| Pre-filter fingerprint + dish-match thumbnail | 3 | [capture/src/frames.ts](capture/src/frames.ts) |
| Dish grouper (verdicts, groups, persisted state) | 3 | [capture/src/dishGrouper.ts](capture/src/dishGrouper.ts) |
| Bridge pass (scan → group → ingest) | 3 | [capture/src/inboxBridge.ts](capture/src/inboxBridge.ts) |
| `HttpDishMatcher` client | 3 | [capture/src/http.ts](capture/src/http.ts) |
| `ReplayCaptureAdapter.ingestCameraCapture` (`source: 'camera'`) | 3 | [capture/src/adapter.ts](capture/src/adapter.ts) |
| CLI | 3 | [capture/scripts/ingest-inbox.mjs](capture/scripts/ingest-inbox.mjs) |
| Camera simulator (inbox writer, no board) | 3 | [capture/src/simulateCamera.ts](capture/src/simulateCamera.ts), [capture/scripts/simulate-camera.mjs](capture/scripts/simulate-camera.mjs) |
| Live E2E (inbox → R2/SpacetimeDB → Gemini+SAM → dashboard API) | 8 | [tests/e2e/bigplan-live.test.mjs](tests/e2e/bigplan-live.test.mjs) |
| `judgeSameDish` prompt, schema, validation | 4 | [vision/src/dishMatch.ts](vision/src/dishMatch.ts) |
| `POST /api/dish-match` | 5 | [backend/src/services/dishMatchService.ts](backend/src/services/dishMatchService.ts), [backend/src/http/app.ts](backend/src/http/app.ts) |
| `DishMatchRequest` / `DishMatchResult` | 1 | [contracts/types.ts](contracts/types.ts) |

Reused without changes: `HttpUploader`, `HttpIngestionSink`, `normalizeImage` (1024² center crop),
the adapter's exactly-once registry, and the Gemini gateway. No `db/` or schema changes were needed.
The Gemini key stays in the backend process.

## 3. Grouping algorithm

Frames are processed strictly in `capturedAt` order. Manual and automatic captures go through the
same grouper.

1. **Pre-filter (no AI).** The frame and the previous frame are compared using 64×64 **RGB**
   fingerprints of the same center-square crop that gets uploaded. If the mean absolute difference is
   below 4/255 (`prefilter-v1`), the frame inherits the previous frame's assignment: the same dish,
   or no plate. RGB matters because two differently colored plates can look the same in grayscale.
   This step only means "nothing moved." It never decides that a frame is a *different* dish.
2. **Gemini.** Otherwise `POST /api/dish-match` compares the frame with a reference:
   - the **latest frame of the open dish**, so a sliding plate is tracked step by step;
   - if no dish is open, the **latest frame of the last closed dish**. A plate still in view after a
     flush, idle close, or gap therefore attaches to its existing dish as a *late frame* and is not
     counted again;
   - if there is no dish at all, **the frame itself**, which only answers "is a plate visible?"
3. **Verdicts:**
   - `plateVisible: false` makes a no-plate frame.
   - `same` or `unsure` joins the reference's dish. An `unsure` merge is logged, because missing a
     dish is preferred over counting one twice.
   - `different` closes the open dish and opens a new one.
4. **A dish closes when:**
   - a `different` verdict arrives;
   - no-plate frames continue for ≥ 3 s of frame time after the dish's last plate frame, so a hand
     passing over doesn't split a dish;
   - the service changes;
   - `--watch` sees no new photos for `--idle` seconds;
   - a one-shot run ends, or Ctrl+C.
5. **Ingestion:** each closed dish uploads its **middle** plate frame once, through
   `ingestCameraCapture`, under registry key `camera:<serviceId>:<groupId>`. The group ID is the
   dish's first `captureId`, and `capturedAt` comes from the representative frame. If the upload
   fails, the dish stays `closed` and is retried on the next pass with the same `eventId`.

## 4. Gemini same-dish judgment

`judgeSameDish` (prompt `dish-match-v1`, temperature 0) sends both images with a schema-constrained
answer `{ plateVisible, sameDish: same|different|unsure|not_applicable, reason }`. The prompt asks
Gemini to judge the same physical plate by plate shape, color, rim, and leftover arrangement. Position,
rotation, lighting, and partial occlusion alone don't make a dish different. Weak evidence should be
`unsure`, and text inside the images is ignored.

Validation rejects inconsistent answers, such as a verdict without a plate or `not_applicable` with a
plate. A rejected answer is a retryable `VISION_INVALID_RESPONSE` and is never read as `different`.

**Endpoint behavior:**

- Two ≤ 400 KB thumbnails go in. The bridge sends 512×512 JPEGs at quality 80, inside the backend's
  1 MB JSON limit.
- Nothing is stored or logged.
- Without a Gemini key: `503 DISH_MATCH_UNAVAILABLE`.
- Provider error or unusable answer: `502`.

**In the bridge**, any dish-match error **pauses the pass at that frame**. Later frames wait. A
one-shot run exits with code 1, and a rerun resumes from the same frame. `--watch` retries with
backoff of up to 30 s.

## 5. State and idempotency

The state files are in `capture/` and are gitignored:

- `.inbox-groups.json` holds every processed frame with its dish and the verdict that put it there
  (`prefilter` with its difference value, or `gemini` with model, prompt version, and reason). It also
  holds each dish's members, close reason, representative frame, unsure and late-frame counts, and
  `eventId`.
- `.inbox-ingest.json` is the adapter's registry of minted `eventId`s.

**Effects:**

- **Reruns are deterministic.** A rerun reuses recorded verdicts and never asks Gemini again about a
  frame, so it cannot regroup frames into extra dishes.
- **Two layers of deduplication.** Ingested dishes are skipped, and the backend also deduplicates by
  `eventId`.
- **Resetting.** Delete both files only together with a fresh database.
- **The inbox is read-only.** Dot-prefixed transfer directories are ignored. Incomplete or tampered
  captures (`INBOX_INCOMPLETE`, `INBOX_METADATA_INVALID`, `CHECKSUM_MISMATCH`) are reported once and
  never grouped.

## 6. Verification

**Fixture tests:** `capture/test/bridge.test.ts` has 12 tests using a fake matcher that plays Gemini.
They show:

- a stationary plate over 10 frames → 1 dish and 1 Gemini call;
- a sliding plate → 1 dish, with its middle frame uploaded;
- a 2 s occlusion → still 1 dish; an empty belt for more than 3 s followed by a new plate → 2 dishes;
- back-to-back different plates → split;
- `unsure` → merged and reported;
- a double Enter press → 1 dish;
- a plate seen again after a flush → a late frame, not a new dish;
- a dish-match failure → pauses in order, and resuming gives the same dishes;
- a rerun → 0 Gemini calls and 0 uploads;
- a failed upload → retried under the same `eventId`;
- `--no-dedupe` → behaves as described;
- the inbox reader → handles bad and in-progress captures.

`capture/test/simulateCamera.test.ts` (8 tests) shows the simulator's inbox is accepted by the
inbox reader and the bridge (with a fake matcher and with `--no-dedupe`), is labeled `replay`, and
passes `laptop_capture.py`'s own `validate_bundle()` / `save_capture()` byte-for-byte.

Capture suite: 36/36 passing.

**Other suites:** `vision/test/dishMatch.test.ts` (vision 42/42) and
`backend/test/dishMatch.test.ts` (backend 32/32) cover endpoint validation, `503` without a key,
`502` on a bad answer, and the size limit.

**Offline smoke test:** the backend ran with local-dev storage, the in-memory repo, and no Gemini key.
- Grouping mode paused with `DISH_MATCH_UNAVAILABLE` and exited 1.
- `--no-dedupe` ingested 2 manual captures as `camera` events (1024² normalized, objects stored) and
  skipped the interval frame.
- A rerun added nothing.

**Camera-path audit after the SAM/big-plan merge (2026-10-03, Agent 3/8):** traced
`uno_q_camera.py` → SSH → `laptop_capture.py` → inbox → `ingest-inbox` → `POST /api/images/uploads`
→ PUT presigned URL → `POST /api/images/:id/finalize` → `POST /api/captures` → `MaskAnalyzer`
(`analyzeCaptureWithMasks`) → SpacetimeDB. Nothing in the merged mask pipeline changes the bridge's
inputs:

- the bridge still uploads the `topdown-normalized-v1` 1024 × 1024 JPEG (`normalizeImage`, EXIF
  auto-orient + center square), and `CaptureEvent.geometry` is what the SAM pipeline segments against
  (`vision/src/maskPipeline.ts` checks SAM output against `geometry.widthPx/heightPx`);
- the backend validates only `coordinateSpace = 'topdown-normalized-v1'` and positive dimensions
  (`backend/src/services/validation.ts`); `source` (`camera`/`replay`) is a label, not a branch;
- the capture's own `image_object` row keeps `association = { kind: 'capture', id: eventId }`
  (required by `IngestionService`); masks and the overlay are added by the backend, not the bridge.

Offline smoke (2026-10-03, backend with local-dev storage, in-memory repo, mock analyzer, no Gemini):
`simulate-camera --count 3 --service svc_hall-main_2026-10-03_dinner --state-dir <tmp>` ingested 3
`test2` photos as 3 `replay` events (`succeeded`, 1024² `topdown-normalized-v1`, 0 Gemini checks); a
rerun added nothing. The live Gemini + SAM + R2 + SpacetimeDB run is
`tests/e2e/bigplan-live.test.mjs` (`SCRAP_E2E=1`; see docs/verification-report.md for results).

**Not yet verified:**

- live Gemini same-dish accuracy on real C920 photos;
- R2 and SpacetimeDB with this bridge;
- latency at 1 fps.

Live check, scripted: `python3 capture/scripts/live_camera_test.py --target arduino@YOUR_BOARD_IP --service <id>` checks the board, takes manual and 5-frame auto photos, probes `/api/dish-match`, then cues you through the plate run below with the bridge in the background. It verifies one `camera` event per plate and a no-op rerun. It uses its own inbox and `--state-dir` under `images/camera-test/`, so the real inbox and bridge state are untouched. `--stage camera` needs no backend.

Live check, by hand: run steps 1–3 above while passing three plates under the camera with gaps between them,
holding one plate still for about 10 s. Expect exactly three `✓ dish` lines and three `capture_event`
rows with `source = camera` (`spacetime sql scrap "SELECT * FROM capture_event"`). Rerun and expect
nothing new. Note the Gemini checks against the frame count.

## 7. Open questions

1. **Thresholds.** The pre-filter value (4/255), the 3 s grace period, and the 10 s idle timeout are
   provisional. Tune them on real conveyor footage.
2. **Gemini cost and latency.** Measure the model choice and latency at 1 fps. The pre-filter should
   keep calls to roughly one or two per plate change.
3. **Representative frame.** Middle frame, sharpest frame, or a frame Gemini picks for least
   occlusion?
4. **`unsure` merges as a quality flag.** Should they be surfaced on the dashboard? That would need a
   new `QualityFlag` value. For now they appear only in the bridge log and state file.
5. **Older dishes.** Should a frame also be compared with dishes older than the last closed one? A
   plate that leaves and returns after another plate would currently count twice. That shouldn't
   happen on a one-way conveyor.
6. **Keeping raw originals.** Should the raw, un-normalized original also be kept in R2?
7. **Hall/service source.** Should hall/service come from a config file or the clock instead of
   `--service`?
