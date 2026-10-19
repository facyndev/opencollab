# Desktop dual storage mode — local (appdata) vs cloud (API)

Objective: give the desktop two storage options for workspaces/sessions/terminals — persist everything locally (appdata) or store everything in the cloud through the REST API built in feature `api-rest-crud` — with mode selection on Onboarding + Settings, collaboration visible-but-inactive in local mode, and a local→cloud migration path on switch.
Branch: feature/desktop-dual-storage (from develop c647c6f) | Delivery: PR to develop (strategy `ask-on-risk`; forecast will exceed 400 authored lines — chain strategy question owed at that point) | Test runner: `cargo test --workspace` + `cargo clippy --workspace --all-targets -- -D warnings` + `pnpm -r test` + `pnpm -r typecheck`

## Specs

- S1 (user, verbatim from the original request): "Lo ideal es que el usuario tenga 2 opciones al usar la aplicación, almacenar todo local (podria ser en appdata) o guardar todo en "cloud" que seria que se interactue con la API." — Two storage modes for the same desktop data.
- S2 (user decision, verbatim): Mode selection = "Onboarding + Settings" — the user picks the mode on first run (onboarding) and can change it later from Settings.
- S3 (user decision, verbatim): Collaboration in local mode = "Visibles pero inactivas" — collaboration UI stays visible but inactive when there is no cloud behind it.
- S4 (user decision, verbatim): Switching local→cloud = "Migrar local → cloud" — changing the mode from local to cloud migrates existing local data to the API.
- S5: In local mode the desktop's workspaces, sessions and terminal profiles survive restarts: they are written to appdata and restored on launch (today they are plain React state, `App.tsx` `useState`, lost on close).
- S6: In cloud mode the same workspace/session/terminal structure is stored through the authenticated REST API from feature `api-rest-crud` (develop 0dd8d1c): workspaces, sessions and terminals endpoints; the desktop's existing PKCE auth session provides the token.

Assumptions (marked as such, not user requirements — challenge or confirm anytime):
- A1: Persisted per-terminal data = launch profile only: name/command/args/cwd/agent id, plus pane order (`Pane.seq` semantics: DOM order stable, visual order = array order) and minimized flag. Never `env` (secrets rule shared with the API), never PTY scrollback or process state.
- A2: The storage port lives in the desktop Rust core — `packages/ui/src/model.ts` already says "Workspaces y sesiones viven acá hasta que el núcleo exponga comandos para ellos" — with a local file backend (JSON under the OS appdata dir) and a cloud backend (HTTP client to the API) behind one port, exposed to the frontend through Tauri commands.
- A3: Window-level UI state (layout choice grid/columns/single, focused pane, maximized pane) is NOT persisted in this feature — only workspace/session/terminal structure. Can be a follow-up.
- A4: Migration (S4) = on mode switch to cloud, local workspaces/sessions/terminals are pushed to the API one workspace at a time; local files are kept (not deleted) after a successful migration.
- A5: Cloud mode requires a signed-in user (existing PKCE flow); switching to cloud without a session prompts login first.
- A6: The REST API base URL is configurable in Settings (dev default `http://localhost:3000`-style local API); the exact default comes from the existing desktop relay/API configuration during T3.

## Tasks

- T1 (S5, A1-A2): Rust core storage port (`WorkspaceSnapshot` load/save) + local appdata JSON backend + unit tests (round-trip, malformed file recovery). route: inline — DONE (RED 8/8 failing → GREEN 87/87; clippy -D warnings 0 workspace-wide; typecheck 0 post-incident recovery). Review assess: pending until commit
- T2 (S5): Tauri commands exposing the port (load on launch, save on change) + frontend bootstraps workspaces from the backend instead of `initialWorkspaces()` + persistence on every mutation. route: TBD
- T3 (S6, A5-A6): Rust HTTP client for the REST CRUD + cloud backend behind the same port, authenticated via the existing `AuthStore` token. route: TBD
- T4 (S2): Onboarding on first run + Settings mode switch (mode persisted). route: TBD
- T5 (S3): Local-mode collaboration visible-but-inactive. route: TBD
- T6 (S4, A4): Local→cloud migration on switch. route: TBD
- T7 (S1-S6): Full verification: cargo test/clippy/fmt, pnpm test/typecheck/build, help/docs updated. route: TBD

## Log

- L1 (2026-10-15, user kickoff, verbatim): "podrias ir haciendolo vos?" — continue the delegated flow autonomously: merge the api-rest-crud PR chain (done, see L2) and start this next feature (per the scope decision recorded in `odd/tasks/api-rest-crud.md` L3/L4). Original product request (verbatim, carried over): "Lo ideal es que el usuario tenga 2 opciones al usar la aplicación, almacenar todo local (podria ser en appdata) o guardar todo en "cloud" que seria que se interactue con la API."
- L2 (2026-10-15, delivery closed): api-rest-crud landed on develop via tracker PR #16 (merge commit 0dd8d1c, CI green on all slices). #13 auto-merged; #14/#15 closed with landing comments. develop docs commit c647c6f. This branch forks from develop c647c6f.
- L3 (2026-10-15, exploration findings): (a) Desktop workspaces/sessions/panes are pure React state (`apps/desktop/src/App.tsx`, `packages/ui/src/model.ts`) initialized from a hardcoded "OpenCollab" workspace — zero persistence today. (b) `model.ts` documents the planned move: core should expose commands for workspaces/sessions. (c) Rust core already has the domain parity model (`apps/desktop/core/domain`: Session/Terminal/AgentProfile with owner+access) — the same model the API persists. (d) Desktop auth (PKCE, tokens in Rust memory via `AuthStore`) already exists in `apps/desktop/src-tauri/src/auth.rs`. (e) The REST surface to consume: POST/GET /workspaces, GET /workspaces/:id, POST/GET /workspaces/:id/sessions, GET /sessions/:id, POST/DELETE /sessions/:id/terminals (env never persisted server-side).
- L4 (2026-10-15, carried-over product decisions, verbatim): Mode selection = "Onboarding + Settings"; collaboration in local mode = "Visibles pero inactivas"; switching local→cloud = "Migrar local → cloud".
- L5 (2026-10-15, T1 done): `application::storage` (WorkspaceSnapshot + Stored{Workspace,Session,Pane}, `SNAPSHOT_VERSION=1`, camelCase serde mirroring the frontend `Pane` model; `is_current_version` gate) + `SnapshotStore` port in `ports.rs` (sync by house rule: "la capa de aplicación no depende de un runtime async") + `infrastructure::FsSnapshotStore` (`workspaces.json` under the configured dir): atomic write (tmp + rename; `fs::rename` replaces on Windows), quarantine of unreadable/future-version files to `.corrupt` with fresh boot (`Ok(None)`), best-effort quarantine so a broken file never blocks the app. House patterns followed: PortError, `Fs*` adapter naming, in-module Spanish-commented tests, `serve_once`-style fixtures. Evidence: RED with stubbed store (8 behavioral tests failing) → GREEN 87/87 (`cargo test -p application -p infrastructure --lib`); `cargo clippy --workspace --all-targets -- -D warnings` exit 0; `cargo fmt --all` clean.
- L6 (2026-10-15, ENVIRONMENT INCIDENT during T1): something external wiped `packages/*` tracked files, ALL `node_modules`, `dist/` builds and left empty dirs (`.git`, root `target/`, `apps/`, `odd/` untouched; docker-compose exonerated — postgres uses a named volume, no bind mounts). Most likely OneDrive (repo lives inside OneDrive; pnpm's symlinked node_modules is a known OneDrive hazard) or Storage Sense. Recovery: `git restore packages/` (68 files), `pnpm install`, `pnpm --filter @opencollab/server^... build`; canary `pnpm -r typecheck` exit 0. OPEN RISK: this WILL recur while the repo stays inside OneDrive — relocation of the repo outside OneDrive (or excluding the folder) is a user decision, surfaced.
