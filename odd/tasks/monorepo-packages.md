# monorepo-packages — `apps/` → `packages/`, one pnpm workspace, `desktop-v*` tags

## Objective

Treat the repo as a real monorepo: rename `apps/` to `packages/`, manage the
three JS packages (desktop, server, web) as one pnpm workspace with a single
lockfile, and tag desktop releases as `desktop-vX.Y.Z` like the other packages.

## Problem

- `apps/desktop`, `apps/server` and `apps/web` are three independent pnpm
  projects (one lockfile and `node_modules` each, no root `package.json`), so
  the repo is a monorepo only by convention.
- After `per-package-versioning`, server and web use prefixed tags
  (`server-v*`, `web-v*`) but the desktop still uses bare `v*`.

## User decisions (2026-10-08)

- Folder name: `packages/` (replaces `apps/`). `crates/` stays as is.
- Desktop tags: `desktop-vX.Y.Z`. Already published tags (`v0.1.0`…`v0.3.0`)
  are not rewritten.
- Merge `feature/per-package-versioning` and `feature/sidebar-thread-duration`
  into `develop` first (done: `f2bba8f`, `32a5332`).

## Scope

Branch `feature/monorepo-packages` (from `develop`). Historical ODD documents
keep their old `apps/` paths (they are history); live docs (`AGENTS.md`,
`README.md`, this file, `nest-server.md` pending items) are updated.

## Constraints

- Strict TDD (session config): existing suites are the safety net for the
  rename; the tag change gets an observed RED with `check-version.ps1`.
- Git Flow: no commits on `develop`/`main`; no push without the user.
- Docker images must still build and run with the single root lockfile.

## Checklist

- [x] **M1** — `git mv apps packages` and update every live path reference
  (Cargo workspace members, CI, release workflow, scripts, docker-compose,
  Dockerfiles, `.gitignore`, `AGENTS.md`, `README.md`, code/comments).
- [x] **M2** — Root pnpm workspace: root `package.json` (private, shared
  `packageManager`, convenience scripts), `pnpm-workspace.yaml` with
  `packages/*` (absorbing the server's workspace settings), one root
  `pnpm-lock.yaml` (per-package lockfiles removed), CI and Dockerfiles adapted.
- [x] **M3** — Desktop tags `desktop-vX.Y.Z`: `check-version.ps1`,
  `release.yml` trigger and pre-release detection, `AGENTS.md`.

## Acceptance criteria

- No live reference to `apps/` remains (outside historical ODD docs).
- `pnpm install` at the root installs all three packages; desktop, server and
  web tests and builds pass from the root workspace.
- `cargo test --workspace`, clippy and fmt pass.
- `docker compose up -d --build` brings the three services up healthy.
- `check-version.ps1 -Package desktop -Tag desktop-v0.3.0` passes and
  `-Tag v0.3.0` fails; `release.yml` triggers only on `desktop-v*.*.*`.

## Applicable checks

`pnpm -r test`, `pnpm -r build`, desktop `pnpm test:e2e`,
`cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
`cargo test --workspace`, `check-version.ps1` for the three packages,
`docker compose up -d --build` + `/health`.

## Progress

- Route: delegated direct (writer trigger: 2+ non-trivial files per task).
- M1 03f07a3, M2 e7f5d09, M3 6dee186. Docker unavailable locally: images built only via simulated pnpm filter install + deploy.
- Verified (writer, parent spot check of the bare `v0.3.0` tag failing): root `pnpm install --frozen-lockfile`; desktop 73 tests + build + E2E; server 212 tests + typecheck + build; web 90 tests + build; cargo fmt/clippy/test; check-version RED→GREEN. Pending: `docker compose up` + `/health`, server `test:integration`.
- Review (RDD on, risk high): consent granted, START refused with `lens_context_budget_exceeded` (the tool counts the rename as 45k changed lines, no review authority created). Authored lines: M1 ~170 (+ renames), M2 ~195 (+ lockfile), M3 36.
- Next: user decides how to review the reduced scope, then nest-server T7 on its own branch.
