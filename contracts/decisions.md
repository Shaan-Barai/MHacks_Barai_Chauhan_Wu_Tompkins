# Decisions and open questions

Owner: Agent 1 (coordinator). Decisions here gate dependent implementation
(AGENTS.md §10). Provisional items are explicitly labeled and may change when
pending details arrive; agreed items came from the team or AGENTS.md.

## Agreed

- **Storage architecture:** SpacetimeDB for application records + external
  object storage for image bytes (AGENTS.md §2). No image bytes/base64 in
  SpacetimeDB tables or subscriptions.
- **Vision provider:** Gemini API for classification and pixel-area estimates.
  No custom model training.
- **Frontend:** React + Tailwind, "Kitchen Garden" palette mapped to Tailwind
  theme tokens, single-dashboard layout per `UI.md`. All mock data in one file
  so it can be swapped for live queries later.
- **Terminology:** UI "waste units" = observed estimated leftover area
  (pixels). See `contracts/README.md`.
- **Workflow:** commit and push incrementally to `main`; PRs are resolved
  automatically by the agents (confirmed in workspace chat, 2026-10-03).

## Provisional (labeled, revisit when details arrive)

- **Frontend tooling:** Vite + React 18 + TypeScript + Tailwind.
- **Backend:** Node.js 20+, TypeScript, Express. Smallest setup that can host
  the storage adapter, Gemini gateway, and REST API.
- **SpacetimeDB module language:** verify currently supported module languages
  against the official SpacetimeDB docs before Agent 2 starts; default to the
  best-documented option (Rust) if nothing argues otherwise. Record the chosen
  version here when installed.
- **Gemini model:** `gemini-2.5-flash` via the official `@google/genai` SDK,
  server-side only; confirm model availability and limits when the API key
  arrives.
- **Object storage (dev):** a `local-dev` filesystem adapter behind Agent 5's
  storage interface so the full flow runs before a cloud provider is chosen.
  The adapter interface must not leak provider specifics.
- **Hall timezone:** `America/Detroit` (MHacks/UMich) until a hall config says
  otherwise.
- **Simulated attendance bounds:** 300–1,200 per service (AGENTS.md 6.2),
  configurable via env.

## Open questions

- External object-storage provider/account/bucket (R2 / S3 / Supabase /
  Firebase) and public-vs-private image access, retention policy.
- Camera hardware, capture trigger, conveyor conditions, plate sizes.
- Menu upload CSV column format and the mock "menu API" response shape
  (UI.md setup step 2).
- How uneaten reference areas are supplied and reviewed for real menus.
- Gemini API key provisioning, rate limits, timeout/retry budget.
- Deployment target for the demo (local-only vs hosted).
