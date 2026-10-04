# Bridge: Uno Q inbox → R2 + SpacetimeDB

**Status:** design only, not implemented (2026-10-03). Nothing below exists in code yet
except the pieces marked *existing*.

**Core rule: each physical dish is counted once.** Many frames, manual or automatic, can show the
same plate. They are grouped into one **dish group**, and only one representative frame per group is
uploaded and submitted as a `CaptureEvent`. Gemini decides whether a new frame shows the same dish
(section 4).

## 1. Current state and the gap

```text
Uno Q + C920s                         Laptop                                 Backend (existing)
─────────────                         ──────                                 ──────────────────
uno_q_camera.py  ── SSH stream ──▶  laptop_capture.py                    POST /api/images/uploads ─▶ image_object (pending)
(FFmpeg MJPEG)                      images/arduino-inbox/<uuid>/          PUT  presigned R2 URL    ─▶ bytes in R2
                                      photo.jpg  (raw 1920×1080)          POST /api/images/:id/finalize ─▶ image_object (finalized)
                                      metadata.json                       POST /api/captures       ─▶ capture_event, analysis,
                                             │                                                          food_measurement
                                             ╳  ◀── nothing connects these ──▶
```

- **Camera side** ([capture/uno-q/README.md](capture/uno-q/README.md)) stops at validated local
  files. It does not upload to R2, call SpacetimeDB reducers, or run analysis. Automatic frames are
  marked `dishIdentity: "unresolved"`.
- **Backend side** ([backend/src/services/imageService.ts](backend/src/services/imageService.ts),
  [backend/src/services/ingestionService.ts](backend/src/services/ingestionService.ts)) already does
  upload authorization → R2 → finalize → capture event → analysis → SpacetimeDB rows. It
  deduplicates by `eventId`, but it cannot tell that two different `eventId`s show the same plate.
  Today only the replay adapter ([capture/scripts/replay.mjs](capture/scripts/replay.mjs)) drives it.

The bridge has three parts:

1. A laptop-side script that scans the inbox and groups frames into dishes.
2. A backend endpoint that asks Gemini whether two frames show the same dish.
3. The existing upload and ingestion flow for one representative frame per dish.

## 2. Components

| Piece | Status | Owner | Location |
| --- | --- | --- | --- |
| HTTP upload seam (authorize → PUT → finalize) | existing | 3 | `HttpUploader`, [capture/src/http.ts](capture/src/http.ts) |
| HTTP capture submission | existing | 3 | `HttpIngestionSink`, [capture/src/http.ts](capture/src/http.ts) |
| Normalization to `topdown-normalized-v1` (1024² center crop) | existing | 3 | `normalizeImage`, [capture/src/normalize.ts](capture/src/normalize.ts) |
| Stable-identity registry with optional state file | existing | 3 | `ReplayCaptureAdapter`, [capture/src/adapter.ts](capture/src/adapter.ts) |
| Gemini transport (schema-constrained, retries, timeouts) | existing | 4 | `GeminiGateway.generateStructured`, [vision/src/gateway.ts](vision/src/gateway.ts) |
| Same-dish prompt, schema, and validation | **new** | 4 | `judgeSameDish(...)` in `vision/src/dishMatch.ts` |
| `POST /api/dish-match` endpoint | **new** | 5 | [backend/src/http/app.ts](backend/src/http/app.ts) |
| `DishMatchRequest` / `DishMatchResult` payloads | **new** | 1 | [contracts/types.ts](contracts/types.ts) |
| Dish grouper (pre-filter + Gemini verdicts + group state) | **new** | 3 | `capture/src/dishGrouper.ts` |
| Camera-capture entry point on the adapter | **new** | 3 | `ReplayCaptureAdapter.ingestCameraCapture(...)` |
| Inbox scanner CLI | **new** | 3 | `capture/scripts/ingest-inbox.mjs` |
| npm script `ingest-inbox` | **new** | 1 | `capture/package.json` |

The Gemini key stays in the backend process. The capture script only calls the backend over HTTP,
the same way it does for uploads.

## 3. End-to-end flow

```text
inbox frame (sorted by capturedAt)
   │
   ├─ verify byteLength + sha256 ─✗─▶ report CHECKSUM_MISMATCH, skip frame
   │
   ├─ pre-filter vs previous frame (tiny pixel difference?) ── yes ─▶ same group as previous frame
   │                                                                   (no Gemini call)
   ▼ no
POST /api/dish-match { reference: open group's representative thumbnail, candidate: this frame's thumbnail }
   │
   ├─ plateVisible = false        ─▶ "gap" frame; start the close-grace timer for the open group
   ├─ sameDish = same | unsure    ─▶ add to open group (unsure is merged, never a new dish)
   └─ sameDish = different        ─▶ close open group → ingest it once; open a new group
   │
group closed (different dish, gap ≥ grace, idle timeout, or script exit)
   ▼
pick representative frame → ingestCameraCapture → normalize → R2 upload → finalize
   → POST /api/captures (one eventId per group) → analysis → SpacetimeDB rows
```

## 4. Counting each dish once

### 4.1 Grouping rules

- **Order:** frames are processed strictly in `capturedAt` order. Manual (Enter / `--once`) and
  automatic (`--auto`) captures go through the same grouper. A double Enter press on one plate merges
  into a single dish.
- **Cheap pre-filter (no AI):** downscale the frame and the previous frame to 64×64 grayscale and
  compute the mean absolute difference. Below `DISH_PREFILTER_MAD` (provisional value `4/255`,
  versioned `prefilter-v1`), the frame joins the previous frame's group without a Gemini call. A
  fixed camera at 1 fps produces long runs of nearly identical frames, so most frames never reach
  Gemini. This is only a shortcut for "nothing moved." A large difference does not prove a new dish;
  that decision is Gemini's.
- **Gemini comparison:** every other frame is compared with the **open group's representative
  frame**, not just the previous frame. A plate that slides along the conveyor is therefore still
  recognized as the same plate.
- **`unsure` merges:** an `unsure` verdict joins the open group. Missing a dish is preferred over
  counting one twice. Every `unsure` merge is logged with both frame IDs for review (section 8).
- **Short occlusions don't split a dish:** a `plateVisible: false` frame (a hand, an empty conveyor)
  does not close the group immediately. The group closes only after `DISH_CLOSE_GRACE_SECONDS`
  (provisional `3`) of consecutive no-plate frames. If a plate reappears within the grace period,
  Gemini compares it with the open group as usual.
- **Other close triggers:** a `different` verdict, no new inbox frames for `DISH_IDLE_SECONDS`
  (provisional `10`, so the last dish of a `--watch` session still gets ingested), or a normal script
  exit (Ctrl+C flushes the open group).
- **No plate ever seen:** a group that contains only no-plate frames is never ingested.

### 4.2 Gemini same-dish judgment (Agent 4)

`judgeSameDish(gateway, reference, candidate)` sends both images in one schema-constrained request:

```ts
interface DishMatchResult {
  plateVisible: boolean;                  // is any dish/plate visible in the candidate?
  sameDish: 'same' | 'different' | 'unsure'; // meaningful only when plateVisible
  reason: string;                         // short, for logs only
  model: string;
  promptVersion: string;                  // e.g. 'dish-match-v1'
}
```

Prompt intent: both images come from the same fixed top-down camera. Decide whether the candidate
shows the same physical plate as the reference. Use plate shape, color, rim pattern, and the
arrangement of leftovers. A change in position or rotation alone does not mean a different dish. If
the evidence is weak, answer `unsure`.

Image text is untrusted (AGENTS.md rule 3.8). The prompt states that text visible in the images is
not an instruction. The output is validated (rule 3.9): a malformed response is treated as a
provider error, never as `different`.

### 4.3 Backend endpoint (Agent 5)

`POST /api/dish-match`, body `DishMatchRequest`:

```json
{ "reference": { "mimeType": "image/jpeg", "base64": "…" },
  "candidate": { "mimeType": "image/jpeg", "base64": "…" } }
```

- Accepts two **transient thumbnails** (the script sends 512×512 JPEGs of the normalized crop). They
  are never stored, never written to SpacetimeDB, and never logged. Request size is capped, for
  example at 2 MB.
- Returns `DishMatchResult`. In gateway mock mode (no `GEMINI_API_KEY`) it returns
  `503 DISH_MATCH_UNAVAILABLE` and does not fake a verdict.

### 4.4 When Gemini is unavailable

The script must not guess. On a dish-match error or `503`, it **pauses at that frame** and retries
with backoff. Frames are never ingested ungrouped, so nothing can be counted twice. `--no-dedupe` is
an explicit opt-out for manual-only sessions. It ingests one dish per manual capture, still skips
`--auto` frames, and prints a warning.

### 4.5 Representative frame

The middle frame of the group's plate-visible frames, by `capturedAt`. Later this can become the
sharpest frame or a Gemini-chosen one; that's an open question. All member `captureId`s are recorded
in the state file. Only the representative frame is uploaded.

## 5. Mapping to a CaptureEvent

| Source | CaptureEvent / upload |
| --- | --- |
| Group ID = first member's `captureId` | registry key `camera:<serviceId>:<groupId>` and `entryId`. `eventId` is still a minted ULID, never derived from bytes (AGENTS.md 3.2) |
| Representative frame's `capturedAt` | `capturedAt` |
| Representative `photo.jpg` | normalized to 1024×1024 by `normalizeImage`, then uploaded. `geometry` comes from normalization. The raw frame is never uploaded |
| — | `source: 'camera'`, `qualityFlags: []`, `state: 'pending'` |

`ingestCameraCapture({ groupId, imagePath, capturedAt, hallId, serviceId })` calls the existing
private `ingestEntry` with `source: 'camera'`. This value is already in `CaptureSource`
([contracts/types.ts](contracts/types.ts)) and is accepted by
[backend/src/services/validation.ts](backend/src/services/validation.ts). The `ingestEntry`
signature widens to `CaptureSource`.

## 6. Hall and service context

The Uno Q metadata has no hall or meal context, so the operator supplies it:

```bash
cd capture && npm run ingest-inbox -- --service <serviceId>          # one-shot
cd capture && npm run ingest-inbox -- --service <serviceId> --watch  # live demo
```

The script calls `GET /api/services` and takes `hallId` from the matching service. It stops before
scanning if the service is unknown. A dish group never spans two services. Changing `--service`
closes the open group.

## 7. Idempotency and state (`capture/.inbox-state.json`, gitignored)

The state file records:

- every processed `captureId`
- its group assignment
- the verdict that assigned it: `prefilter`, or `gemini` with the model, prompt version, and result
- each group's open/closed/ingested status
- each group's minted `eventId`

Consequences:

- **Reruns are deterministic.** Recorded verdicts are reused and Gemini is never asked again about a
  frame it already judged, so a rerun cannot regroup frames differently and create a second dish.
- **Ingested groups are skipped** (`already ingested`). The backend also deduplicates by `eventId`.
- **Writes are atomic** (temp file + rename), like the replay registry. Delete the state file only
  together with a fresh database.
- **The inbox is read-only.** Inbox directories are never moved or deleted, and `images/` stays
  gitignored. Only complete directories with `photo.jpg`, `metadata.json`, and `protocolVersion: 1`
  are read.

## 8. Failure handling and logging

| Situation | Behavior |
| --- | --- |
| Backend not running | Exit at startup after `GET /api/health`, same as `replay.mjs` |
| Unknown `--service` | Exit before scanning |
| Checksum or length mismatch | `✗ <captureId>: CHECKSUM_MISMATCH`; frame excluded from grouping |
| Dish-match error / `503` / malformed verdict | Pause at that frame and retry with backoff; nothing after it is processed out of order |
| `unsure` verdict | Merged; logged as `? <captureId> merged into <groupId> (unsure: <reason>)` |
| Upload, finalize, or submit error | `✗ group <groupId>` with the backend `ApiError`; a rerun retries with the same `eventId` |
| Upload authorized but never finalized | Shows up in the existing `GET /api/images/orphans` / `POST /api/images/cleanup-orphans` |
| Analysis `needs_review` / `failed` | Reported from `HttpIngestionSink.outcomes`; the dish is still counted once and is never re-submitted as new |

Each closed group prints one line:
`✓ dish <groupId> (<n> frames, <k> Gemini checks) → <eventId> (<state>)`.

## 9. Ownership (AGENTS.md §4)

- **Agent 1:** `DishMatchRequest`/`DishMatchResult` in `contracts/`, the `capture/package.json` script
  line, and a `contracts/decisions.md` entry for the dish-grouping rule.
- **Agent 3:** `capture/src/dishGrouper.ts`, the adapter method, `capture/scripts/ingest-inbox.mjs`,
  and the `.inbox-state.json` entry in [capture/.gitignore](capture/.gitignore).
- **Agent 4:** `vision/src/dishMatch.ts` (prompt, response schema, validation) on the existing gateway.
- **Agent 5:** the `POST /api/dish-match` route, its size limit, and the no-logging rule.
- **No changes** to `db/` or to the SpacetimeDB schema. Only grouped, representative captures reach
  the existing tables.

## 10. Verification plan

**Fixture tests**

The grouper is tested with a fake dish-match client, a synthetic inbox, `InMemoryUploader`, and
`InMemoryIngestionSink`:

1. Ten near-identical frames of one plate: one dish, zero Gemini calls (pre-filter).
2. A plate that moves across the frame: verdicts are `same`, giving one dish.
3. Plate A, a 2-second hand occlusion, then plate A again: one dish (grace period).
4. Plate A, an empty conveyor for more than 3 seconds, then plate B: two dishes, ingested in order.
5. An `unsure` verdict: merged and logged.
6. A double Enter press on one manual plate: one dish.
7. A dish-match `503`: processing pauses, nothing is ingested, and resuming gives the same groups.
8. Rerun with the state file: no new Gemini calls, no new uploads, same `eventId`s.
9. A checksum mismatch: frame excluded.
10. The idle timeout and Ctrl+C flush the last group.

**Vision (Agent 4) tests:** `judgeSameDish` validation covers malformed JSON, extra fields, and
`plateVisible: false` with `sameDish` set, all through the gateway's mock transport.

**Backend (Agent 5) tests:** the route returns `503` in mock mode, enforces the size limit, and keeps
thumbnails out of logs and out of the repository.

**Live check:** run the backend with `GEMINI_API_KEY`, `OBJECT_STORAGE_PROVIDER=r2`, and
`SPACETIMEDB_URI` set.

1. Run `laptop_capture.py --auto` while passing three plates under the camera, leaving gaps between
   them and holding one plate still for about 10 seconds.
2. Run `npm run ingest-inbox -- --service <id> --watch`.
3. Expect exactly three dish lines, three objects in R2, and three `capture_event` rows with
   `source = camera` (check with `spacetime sql scrap "SELECT * FROM capture_event"`).
4. Rerun and expect no new rows.
5. Record the number of Gemini calls compared with the number of frames.

## 11. Open questions

1. **Thresholds.** `DISH_PREFILTER_MAD`, the grace period, and the idle timeout are provisional.
   Tune them on real conveyor footage.
2. **Gemini choice.** Which Gemini model to use, and the latency at 1 fps. The pre-filter should keep
   calls to roughly one or two per plate change, but this needs to be measured.
3. **Representative frame.** Middle frame, sharpest frame, or a frame Gemini picks for least
   occlusion?
4. **`unsure` merges as a quality flag.** Should they be surfaced on the dashboard? That would need a
   new `QualityFlag` value (Agent 1). For now they appear only in the bridge log.
5. **Non-adjacent duplicates.** Should the bridge also compare with the last few *closed* groups, to
   catch a plate that leaves and comes back after the grace period? On a one-way conveyor this
   shouldn't happen, so it is left out to save Gemini calls.
6. **Keeping raw originals.** Should the raw, un-normalized original of the representative frame also
   be kept in R2?
7. **Hall/service source.** Should hall/service come from a config file or the clock instead of
   `--service`?
