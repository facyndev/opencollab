# Agent guidance for OpenCollab

Guidance for AI coding agents working on OpenCollab.

## Product overview

OpenCollab is a desktop application that centralizes terminal-based AI agents (Claude Code, OpenCode, Codex, Gemini CLI) in a flexible grid for parallel monitoring and real-time collaboration.

- **Workspace:** top-level project container grouping sessions. Persisted locally in appdata or on the server depending on the desktop storage mode (`local` vs `cloud`).
- **Session:** live shared unit displaying multiple terminal panes in a grid.
- **Terminal:** single PTY process running an agent profile or shell.
- **Storage modes (desktop):**
  - *Local (`appdata`):* workspaces, sessions, and terminal launch profiles (`workspaces.json`) are stored locally on disk via `FsSnapshotStore`. Collaboration controls remain visible in the UI with an inactive state (`data-collab-inactive="true"`), and relay polling is short-circuited.
  - *Cloud (`API`):* workspaces, sessions, and terminal launch profiles synchronize with the authenticated NestJS REST API (`CloudSnapshotStore`). Chosen during first-run Onboarding or switched later in Settings (`storage.json`). Switching from Local to Cloud migrates existing local workspaces to the cloud account one workspace at a time while preserving local files on disk.
- **Collaboration model:**
  - *Workspace member:* persistent team access across workspace sessions. View access enabled by default.
  - *Session guest:* temporary, session-scoped access.
- **Access control:** ordered level `AccessLevel { None < View < Write }`. Disabling View revokes all access; Write implies View. Enforced on the server and verified fail-closed on the host machine. Permissions update dynamically during active sessions.

## Architecture and package boundaries

Clean architecture with inward-pointing dependencies:

```
apps/
  desktop/
    core/             # Rust desktop domain, use cases, wire protocol, and PTY/OS adapters
    src-tauri/        # Tauri 2 commands, state wiring, and event bridges
    src/              # React 19 frontend (terminal grid, xterm.js, workspaces)
  api/                # NestJS 11 relay (auth, sessions, Prisma 7 + PostgreSQL, WebSockets)
  web/                # Vite 8 + React 19 auth portal (/login, /register, desktop handoff)
packages/
  domain/             # @opencollab/domain: pure TypeScript collaborative business logic
  contracts/          # @opencollab/contracts: canonical wire contract (Zod schemas, parity with Rust)
  ui/                 # @opencollab/ui: presentational components (Panel, Sidebar, StatusBar, TopBar)
  config/             # Shared TypeScript and tooling configs
```

### Package roles and import rules

- **`@opencollab/domain`:** single authority for collaborative rules (workspaces, sessions, permissions). Zero external runtime dependencies.
- **`@opencollab/contracts`:** wire protocol schemas and DTOs with byte parity to `apps/desktop/core/protocol`.
- **`@opencollab/ui`:** pure presentational components and styles. Zero business logic and zero `@tauri-apps/api` imports.
- **`apps/web`:** isolated authentication client. Does not import `@opencollab/ui` or desktop modules.
- **Import convention:** applications (`apps/*`) must consume shared packages strictly via `@opencollab/*` from their built `dist/` outputs. Relative cross-package file imports are prohibited.

## Tooling and workflow

- **Transitive builds:** build internal dependencies automatically with `pnpm --filter <app>^... build`.
- **Task runner:** Turborepo handles task orchestration (`turbo.json`).
- **Prisma:** schema located at `apps/api/prisma/schema.prisma`. Running `pnpm install` automatically triggers `postinstall: prisma generate`.
- **Development commands:** run `pnpm dev` from the root to start all apps in parallel (`api`, `web`, `desktop`), or run an individual app via `pnpm desktop:dev`, `pnpm api:dev`, or `pnpm web:dev` (every `apps/*` package also exposes `pnpm dev` locally). Desktop development uses `tauri.dev.conf.json` with identifier `com.opencollab.desktop.dev` and deep-link scheme `opencollab-dev://` registered at runtime to run alongside production instances without WebView2 lock or auth redirect contention.

### Verification commands

- **TypeScript tests:** `pnpm -r test`
- **Typecheck:** `pnpm -r typecheck`
- **Build all:** `pnpm -r build`
- **Rust tests:** `cargo test --workspace`
- **Rust linting:** `cargo clippy --workspace --all-targets -- -D warnings`
- **Rust formatting:** `cargo fmt --all --check`
- **Package versions:** `pwsh ./scripts/check-version.ps1 -Package desktop` (or `server`, `web`)

### Git flow and versioning

- **Branches:** `main` (production releases), `develop` (integration), `feature/*`, `release/*`, `hotfix/*`.
- **Package versioning:** independent semantic versions:
  - `desktop`: tracked in root `Cargo.toml`, `apps/desktop/package.json`, and `tauri.conf.json`. Tag: `desktop-vX.Y.Z`.
  - `server`: tracked in `apps/api/package.json`. Tag: `server-vX.Y.Z`.
  - `web`: tracked in `apps/web/package.json`. Tag: `web-vX.Y.Z`.
  - Wire protocol: `PROTOCOL_VERSION` in `protocol` and `@opencollab/contracts`.

## Technical specifics

### Terminal and process handling

- **ConPTY:** Windows ConPTY emits a cursor position query (`ESC[6n`) requiring an xterm response before output flows. Raw PTY readers must reply to this query.
- **Process termination:** closing a terminal kills the full process tree (`taskkill /T /F` on Windows, `kill -KILL -<pgid>` on Unix) to prevent orphaned agent child processes.
- **Shell exit:** typing `exit` or child process exit triggers `terminal-exit`, closing the pane cleanly.

### Agent detection and activity

- **Detection:** `agent_watcher.rs` polls every 1 second via `sysinfo`, inspecting child processes beneath the shell. Stops at instances matching `current_exe()` to prevent recursion.
- **Activity tracking:** `ActivityTracker` records PTY byte output (3 seconds of silence transitions to `idle`).
- **Git branch tracking:** `FsRepositoryInspector` reads `.git/HEAD` directly upwards from the current working directory every 3 seconds.

### Shell integration and current directory tracking

- **PowerShell OSC 7:** the default Windows shell wraps the prompt to emit `ESC]7;file://localhost/<path> ESC\`. `xterm.js` reads this sequence to update the path display.
- **Directory switcher:** `CwdSwitcher.tsx` sends `cd` commands to the shell; disabled while an agent process is running.

### Rich agent adapters

- **Claude Code:** launched with `--settings <file>` targeting a local HTTP hook receiver on `127.0.0.1` with per-launch UUID security tokens. Translates hook events to `AgentEvent`s.
- **OpenCode:** launched with `--port <p>` and authenticated via `OPENCODE_SERVER_PASSWORD`. Consumes `GET /event` SSE stream.

### Authentication and desktop handoff

- **Web client:** routes `/login`, `/register`, `/auth/complete`, and `/account`. Stores access token in memory and refresh token in an `httpOnly` cookie (`oc_refresh`).
- **Desktop handoff:** desktop generates PKCE S256 challenge, opens `<web>/login?client=desktop&code_challenge=...`, and web returns authorization code via `opencollab://auth/callback?code=...` (or `opencollab-dev://` in dev). Desktop exchanges code for tokens, keeps the short-lived `access_token` strictly in Rust memory, and persists the rotating `refresh_token` + user profile in the OS credential store (`keyring`: Windows Credential Manager / macOS Keychain / Linux Secret Service, isolated between `opencollab` and `opencollab-dev`).

### UI rules and component guidelines

- **Component framing:** structural panels must reuse `Panel` from `@opencollab/ui`.
- **Drag-and-drop:** reorders visually via CSS `order`. Underlying DOM order strictly preserves `Pane.seq` to avoid resetting `xterm.js` buffers.
- **No `React.StrictMode`:** disabled in development to prevent duplicate PTY spawns.
