# financial-forecasting-platform — Readiness Report

_Assessed 2026-08-27_

## Score: 100/100 — Ready to run

## Stack

TypeScript monorepo (npm workspaces): `packages/api`, `packages/engine`, `packages/shared`, `packages/web`. Prisma for the DB layer, Vitest for tests, ESLint/Prettier configured, Docker Compose for Postgres + services.

## Current state

- Dependencies installed: yes — `node_modules` populated (475 top-level entries) at this path already
- Lockfile: yes — `package-lock.json`
- README: yes, extensive (19.7KB) plus `CLAUDE.md`, `CHANGELOG.md`, `docs/` (explains run steps: yes — `npm install`, `npm run stack:up`, `npm run dev`, DB migrate/seed commands)
- Env config: both `.env` and `.env.example` present
- Git: `main`, remote yes (`origin` → `github.com/TKP1972/Financial-Forecasting-Platform`), clean working tree
- Tests: yes — 52 vitest spec files (`*.test.ts(x)`/`*.spec.ts`) across packages, plus dedicated e2e/UI-journey scripts and a `coverage/` output present from a prior run
- Docker: yes (`docker-compose.yml`, `docker-compose.dev.yml`, `docker/`)

## Steps to get this running

1. Dependencies are already installed — verify with `npm run typecheck` or `npm run test` first.
2. `npm run infra:up` (Postgres) then `npm run db:migrate` and `npm run db:seed`.
3. `npm run dev` (API on :4000, web on :5173), or `npm run stack:up` to build+start everything at once.

This is the most complete project of the 13 — the only one where dependencies are already installed at the new path, and it scores full marks across every rubric category.

## Similar / related projects

- **financial-reporting** — same financial domain but a distinct scope (tax/ledger/reporting engine vs. forecasting), different stack (Python/Django vs. this TS monorepo). Worth checking whether these two are meant to integrate.
- Not closely related to the demand/supply-chain forecasting cluster (demand-forecast, demand-planner, etc.) — this one is specifically financial forecasting.

## Stray files needing review

- `Claude_Cowork_AI_Engineer_Package/` — a folder of generic "Claude Cowork" onboarding docs, a token-optimization guide, and templates. This content is not about financial forecasting at all; it reads like generic AI-tooling onboarding material that ended up inside this project's root rather than in a shared/tooling location.
- `.internal/correspondence/` — **not flagged as stray**: it has its own README explicitly explaining it's intentional, git-tracked "working context" (an engineering correspondence log), distinct from `docs/` which is product documentation. Mentioned here only so it isn't mistaken for clutter on a future pass.
