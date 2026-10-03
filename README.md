# Scrap — dining hall food-waste tracker (MHacks prototype)

Scrap helps dining hall managers see what food comes back uneaten. A top-down
camera photographs dishes on the conveyor toward the wash station, Gemini
identifies menu items and estimates the leftover food area in pixels, and a
beginner-friendly dashboard shows waste totals, trends, the most-wasted items,
and AI-powered suggestions.

All waste figures are **AI-estimated pixel areas**, not grams or cost, and
attendance is **simulated** in this prototype — both are labeled as such
throughout.

## Documents

- [`AGENTS.md`](AGENTS.md) — the working plan: agent roles, ownership, rules,
  measurement formulas, and completion checks.
- [`UI.md`](UI.md) — dashboard spec (layout, palette, copy).
- [`contracts/`](contracts/) — shared entity types, error format, sample
  records, and [recorded decisions](contracts/decisions.md).

## Repository layout

| Directory | Owner | Contents |
| --- | --- | --- |
| `contracts/` | Agent 1 | Shared types, samples, decisions |
| `data/`, `db/` | Agent 2 | Menu parsing/validation, SpacetimeDB schema, seeds |
| `capture/` | Agent 3 | Camera/replay capture adapter |
| `vision/` | Agent 4 | Gemini gateway, classification, area analysis |
| `backend/` | Agent 5 | API, object-storage adapter, orchestration |
| `analytics/` | Agent 6 | Aggregates, simulated attendance, suggestions |
| `frontend/` | Agent 7 | Scrap dashboard (React + Tailwind) |
| `docs/`, `tests/` | Agent 8 | Demo docs, fixtures, integration/e2e tests |

## Setup

1. Copy `.env.example` to `.env` and fill in values (server-side only; never
   commit `.env`).
2. Install and start commands will be added here as each module lands —
   the stack is Vite + React + TypeScript + Tailwind (frontend),
   Node + TypeScript (backend), SpacetimeDB + external object storage (data).
   See [`contracts/decisions.md`](contracts/decisions.md) for current status
   and open questions.
