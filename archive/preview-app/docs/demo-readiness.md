# Seven-day UI demo

The application lives in `/Users/mike/mhacks/mhacks`. The parent directory contains the Git repository and original planning documents. It does not contain a second running application.

## Generated records

`frontend/demo-data.json` is the single replaceable fixture. It covers September 27–October 3, 2026, inclusive, in America/Detroit:

- 21 services: breakfast, lunch, and dinner for each of seven dates.
- 1,945 synthetic capture events: 1,794 successful example analyses, 74 under review, and 77 failures.
- 92 empty-plate examples. Empty plates do not invent original menu servings.
- Menus with plain food names and compatible normalized 1024 × 1024 baseline geometry.
- Known assessed servings, zero leftovers, unknown food, and above-baseline examples.
- One stable simulated attendance value per service, with a default range of 300–1,200 and the seed `scrap-seven-days-v1`.

There are no image bytes, private images, live provider responses, credentials, or database mutations in this fixture. Numerical areas are synthetic examples of prototype estimates. Suggestions are labeled rule-based demo examples. These records are not inserted into SpacetimeDB; the current module is still a starter `person` table.

## Run and regenerate

From the application directory:

```bash
npm ci
npm run demo:generate
npm run test:demo
npm run typecheck
npm run build
npm start
```

The preview listens on port 4173. `npm run dev` builds and starts it. `PORT` can select another port. The server serves only `/`, `/index.html`, `/main.js`, `/styles.css`, and `/demo-data.json`; it does not expose source or environment files.

To change the fixture's date or reproducible attendance configuration:

```bash
DEMO_END_DATE=2026-10-03 ATTENDANCE_MIN=300 ATTENDANCE_MAX=1200 ATTENDANCE_SEED=scrap-seven-days-v1 npm run demo:generate
npm run build:ui
```

The fixture generator runs from explicit values and its documented defaults. It does not need Gemini or R2 credentials. An empty `ATTENDANCE_SEED` falls back to the documented demo seed.

## Public preview

The initial public testing URL is:

https://quantitative-rates-associated-attorney.trycloudflare.com

This is a temporary Cloudflare Quick Tunnel. The computer, preview server, and tunnel must stay running. This is not a permanent hosting deployment. To create another link with an installed Cloudflare tunnel CLI while the preview server is running:

```bash
cloudflared tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:4173
```

Only synthetic built assets are public. No live provider credentials are sent to the browser. Cloudflare's [Quick Tunnel documentation](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) describes the temporary URL's lifetime.

## What to test in the UI

1. Open the public URL from a second device. Confirm the demo/simulated labels and seven available dates.
2. Select days and meals. Their capture counts, food rankings, and recommendations should change together.
3. Select a date outside the fixture. The dashboard should explain the missing data.
4. Check that attendance stays unchanged when reloading the same service.
5. Export the demo CSV. Values should match the selected service's underlying source records.
6. Try narrow screens and keyboard navigation. Verify readable labels and usable controls.

Another active chat, `Simplify Scrap Saver dashboard`, owns a concurrent UI simplification. Avoid simultaneous edits to its dashboard/analytics files. Rebuild the static output after those source changes are complete; the existing public link will then serve the new build without starting another tunnel.

## Environment and live integration still to test

The user-specified configuration is shown in `.env.example`. Keep the user-managed `.env` inside the application directory for `npm run dev:db`. The inspected configured file was in the parent directory; that file is not automatically loaded. The starter client now accepts `SPACETIMEDB_URI`, `SPACETIMEDB_MODULE`, and `SPACETIMEDB_TOKEN`, while retaining template aliases.

- Reconcile `SPACETIMEDB_MODULE` with the database in `spacetime.json`. The inspected values differed.
- Use the intended plural `OBJECT_STORAGE_CONTAINERS` consistently when implementing the storage adapter. The inspected parent file still had the singular spelling. The adapter is not implemented yet.
- **SpacetimeDB:** verify connection/subscription, menu retrieval, successful-analysis persistence, refresh survival, and repeated capture-event idempotency after the real tables/reducers exist.
- **R2:** upload and read a non-private test image; test failed uploads, retryable finalization, missing objects, and expiring read access. Store durable references in SpacetimeDB, not image bytes or signed URLs as identity.
- **Gemini:** make a live server-side image request using the selected model, supplied menu IDs, and compatible baseline geometry. Validate structured output and explicit failures. Fixture tests do not verify API keys, quotas, or model availability.
- **Complete workflow:** menu → image upload → classification → stored result → dashboard. Verify unknown food and missing baselines stay unavailable and are not treated as zero waste.

The UI preview needs no provider keys. Filling an environment file does not implement these missing connections.

## Verification recorded by this assignment

- Original starter/client and SpacetimeDB module builds passed.
- Seven focused fixture/analytics tests passed, including hand-calculated area weighting and excluded invalid results.
- Repeated generation with the same seed reproduced the saved fixture exactly.
- Dependency patches completed with no reported vulnerabilities.
- Public URL rendered the dashboard; selecting October 3 and switching lunch to dinner changed the detail records.
- HTTP checks returned 200 for the four built assets plus the index page, and 404 for `.env`, traversal variants, source, and `package.json`.
- No live Gemini, R2, camera, or application-persistence test was performed. The first database network attempt failed; credentials were not verified by that failure.
- The concurrent UI edit changed the analytics interface while this assignment was checking types. Repeat the final frontend type/build checks after that owner finishes.
