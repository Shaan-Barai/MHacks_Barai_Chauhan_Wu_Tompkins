# capture — replay/file-upload capture adapter (Agent 3)

Owner: Agent 3 — camera/replay capture and image preparation. Built against
`contracts/` (AGENTS.md §5 "Agent 3", §6, §7).

For the **Uno Q + C920s** rig, see [camera capture setup](uno-q/README.md).
Manual Enter/`--once` capture and timed `--auto` capture both use FFmpeg and
SSH, without OpenCV. `--auto` transfers one raw photo per second to the laptop.
Timed frames have unresolved dish identity, so they are never submitted one
per frame: the inbox bridge (`npm run ingest-inbox -- --service <id>`) groups
frames into dishes with Gemini and submits one `camera` capture per dish. See
[BRIDGE.md](../BRIDGE.md).

Camera hardware is not available yet, so this package implements the
**replay adapter** (a JSON manifest listing dish images with hall/service
context) and a **manual file-upload** path behind the same replaceable
adapter. A future camera adapter plugs into the identical seams
(`Uploader`, `IngestionSink`) without changing consumers.

## What it does

For each declared dish, `ReplayCaptureAdapter`:

1. Reads the image file and runs cheap programmatic quality checks.
2. Normalizes it to the shared coordinate space `topdown-normalized-v1`.
3. Uploads the normalized bytes through the `Uploader` seam (Agent 5's
   two-step storage flow: authorize → upload → finalize → `objectId`).
4. Submits one `CaptureEvent` (contracts shape, verbatim) — metadata plus the
   finalized object reference, never image bytes — to the `IngestionSink`.

Every event has a ULID-based `eventId` minted at capture time, a UTC ISO
`capturedAt`, `source` of `'replay'` or `'manual_upload'`, hall/service
context, `ImageGeometry`, declared quality flags, and `state: 'pending'`.

## Idempotency (exactly-once per dish)

- A replay manifest entry's `entryId` is the declared identity of one dish.
  Re-running the same manifest (or retrying after a transient failure)
  re-uses the entry's minted `eventId` and `capturedAt`; a successfully
  ingested entry is returned from the adapter's registry without a second
  upload or submission (`alreadyIngested: true`).
- Event IDs are **not** derived from image content. Identical bytes under two
  different `entryId`s are two dishes; two frames of one dish may differ
  (AGENTS.md 3.2). Downstream, `eventId` is the ingestion idempotency key
  (Agent 5 upserts by it).
- `ingestFile` without an `entryId` is explicitly "a new dish per call";
  pass the same `entryId` to retry one dish.
- The registry is in-memory per adapter instance (prototype scope). Durable
  cross-process dedupe is Agent 5's job via `eventId` (AGENTS.md 5.3).

## Normalization: `topdown-normalized-v1`

Deterministic, applied identically to observation and reference images
(AGENTS.md §7.3). Defined in `src/normalize.ts`:

1. Decode (JPEG/PNG/WebP only) and auto-orient from EXIF rotation.
2. Center-crop to the largest centered square:
   `side = min(w, h)`, `left = floor((w - side) / 2)`, `top = floor((h - side) / 2)`.
3. Resize to exactly **1024 × 1024** with Lanczos3 resampling (sharp).
4. Encode JPEG quality 90.

All pixel areas (Agent 4 estimates, Agent 2 baselines) are measured in this
1024×1024 space, recorded as `ImageGeometry` on every event. Optional
`plateShape` / `plateDiameterPx` hints from the manifest are carried through
(diameter is declared in the normalized space).

## Quality flagging

- **Declared flags** (operator-provided in the manifest, validated subset of
  `QualityFlag`): `blurred`, `no_plate`, `multiple_dishes`,
  `incompatible_geometry`. They propagate to `CaptureEvent.qualityFlags`;
  flagged captures still ingest (state `pending`) so nothing is dropped —
  downstream decides handling.
- **Programmatic checks** (cheap, no ML): missing file
  (`IMAGE_FILE_MISSING`), unsupported extension/format
  (`UNSUPPORTED_IMAGE_TYPE` — only `.jpg/.jpeg/.png/.webp`), corrupted or
  undecodable bytes (`IMAGE_UNREADABLE`), zero/missing dimensions
  (`INVALID_IMAGE_DIMENSIONS`). These make the entry fail with a contracts
  `ApiError` envelope (code, plain-language message, details incl. the minted
  `eventId`, `retryable`) in that entry's result — reported, never silently
  discarded, and other entries continue.
- Content-based detection (actual blur scoring, plate detection) is out of
  prototype scope; the hooks are the declared flags.

## Replay manifest format

```json
{
  "manifestVersion": 1,
  "hallId": "hall-main",
  "serviceId": "svc_hall-main_2026-10-03_lunch",
  "entries": [
    {
      "entryId": "dish-001",
      "imagePath": "images/dish-001.jpg",
      "capturedAt": "2026-10-03T12:42:09-04:00",
      "declaredFlags": ["blurred"],
      "plateShape": "round",
      "plateDiameterPx": 900
    }
  ]
}
```

`imagePath` is resolved relative to the manifest file. `capturedAt` is
optional (defaults to first-ingestion time) and is stored normalized to UTC.
Duplicate `entryId`s, unknown flags, and malformed fields fail validation
with `MANIFEST_INVALID`.

## Usage

```ts
import {
  ReplayCaptureAdapter,
  InMemoryUploader,
  InMemoryIngestionSink,
} from '@scrap/capture';

const adapter = new ReplayCaptureAdapter(uploader, sink);
const results = await adapter.ingestManifestFile('replay/manifest.json');
// or one file:
const result = await adapter.ingestFile({
  imagePath: 'photo.jpg',
  hallId: 'hall-main',
  serviceId: 'svc_hall-main_2026-10-03_lunch',
  entryId: 'upload-123', // stable retry key
});
```

Each `CaptureResult` is either
`{ ok: true, event, imageObjectId, alreadyIngested }` or
`{ ok: false, entryId, error: ApiError }`.

## Interfaces for Agents 4 / 5 / 8

- **`Uploader`** (`src/uploader.ts`) — `authorizeUpload(request)` →
  `uploadBytes(auth, bytes)` → `finalizeUpload(auth)` returning the durable
  `objectId`. `HttpUploader` (`src/http.ts`) implements it against the
  backend (`/api/images/uploads` → PUT upload URL → `/finalize`);
  `InMemoryUploader` serves tests. Neither is a storage client or holds
  credentials.
- **`IngestionSink`** (`src/ingestion.ts`) — `submitCaptureEvent(event)`,
  idempotent by `eventId` on Agent 5's side. `HttpIngestionSink` posts to
  `/api/captures` (analysis runs there) and records each event's resulting
  state. Receives metadata + object reference only, never bytes.
- **`CaptureEvent` / `ImageGeometry` / `QualityFlag` / `ApiError`** — verbatim
  copies of `contracts/types.ts` in `src/contract-types.ts` (re-sync when
  Agent 1 changes the contract; do not edit locally).
- Agent 4 consumes the recorded `ImageGeometry` (always 1024×1024
  `topdown-normalized-v1`) for pixel-area estimation; Agent 8 can feed replay
  manifests as fixture input.

## Replay into a running backend

```bash
npm run replay                          # every fixtures/replay/demo-*.json
npm run replay -- path/to/manifest.json
API_URL=http://host:8787 npm run replay
```

Demo manifests and AI-generated synthetic plate images (provenance in
`fixtures/replay/README.md`) cover four services on 2026-10-02/03.
`ReplayCaptureAdapter`'s optional `stateFile` (the CLI uses
`.replay-state.json`, gitignored) persists minted eventIds and completed
entries across processes, so re-running replay reports "already ingested"
instead of creating new dishes. Delete it only together with a fresh database.

## Simulate the camera (no board)

```bash
npm run simulate-camera -- --count 3                      # test2/*.jpeg → images/arduino-inbox
npm run simulate-camera -- --count 3 --service svc_hall-main_2026-10-03_dinner --state-dir /tmp/sim-state
```

`src/simulateCamera.ts` (`simulateCamera`, `listPhotos`) writes photos into an inbox exactly like
`uno-q/laptop_capture.py` saves a manual capture: `<uuid4>/photo.jpg` (unchanged bytes) +
`metadata.json` (same protocol-v1 fields and formatting), via a dot-prefixed temp folder and an
atomic rename. Each photo is one distinct dish. `captureSource: "simulated_camera"` makes the bridge
submit these dishes as `source: 'replay'`, never `'camera'`. With `--service` it then runs one
`ingest-inbox` pass (`--no-dedupe` unless `--dedupe`). Options and rationale:
[BRIDGE.md](../BRIDGE.md#run-it-without-the-board-simulate-camera).

Use the bridge's `--state-dir <dir>` to keep a demo or E2E run's grouping/event-ID state out of
`capture/.inbox-*.json`. For the real board, `scripts/live_camera_test.py` is the hardware check
(camera preflight, manual + auto frames, cued plate run through the bridge); the simulator covers the
same bridge path without hardware.

## Run tests

```bash
cd capture
npm install
npm test        # tsc && node --test dist/test/*.test.js
```

`test/simulateCamera.test.ts` checks the simulator's inbox against the inbox reader, the bridge
(fake Gemini matcher and `--no-dedupe`), and `laptop_capture.py`'s own bundle validation (needs
`python3`; skipped otherwise).

Tests cover: exactly-once ingestion per manifest entry, identical bytes ≠
duplicate dish, stable event IDs across retries (injected transient upload
failure), normalized geometry + UTC timestamps + source labels, declared-flag
propagation, unusable-input errors, manifest validation, and deterministic
normalization. Fixture images are generated at test time with sharp; no
binary fixtures are committed.

## Assumptions and limits

- Node >= 20; `sharp` is the only runtime dependency. No network calls, no
  Gemini, no database, no credentials (hard boundaries per AGENTS.md).
- The upload seam shape anticipates Agent 5's storage adapter; if Agent 5's
  real interface differs, this package adapts to it — the contract-visible
  `CaptureEvent` does not change.
- Replay timestamps default to ingestion time when the manifest omits
  `capturedAt`; demo manifests should declare timestamps for realistic
  trends.
- Normalization assumes the camera is roughly centered over the dish;
  center-cropping a square from a far-off-center frame can cut the plate.
  Real plate detection/cropping is future work for the camera adapter.
