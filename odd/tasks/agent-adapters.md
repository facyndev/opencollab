# Agent adapters: rich agent state via official per-launch integrations

## Objective

Model agent state as a stream of `AgentEvent`s produced by per-agent adapters, and show it in the sidebar thread. Rich adapters for agents whose official integration was verified (Claude Code, OpenCode); a generic adapter (PTY activity + process) for every other agent or when the user launches the agent by hand.

## Problem

T1–T3 (`agent-status-info`) only give coarse, agent-agnostic signals (working / idle / needs attention). The user wants richer states (tool running, approval required, completed, error) obtained in a standard, legal way, without installing anything or editing user config.

## Why this approach

Spike of 2026-10-05 (real CLIs, see Engram `discovery/agent-state-integrations`):

- **Claude Code 2.1**: `claude --settings '<json>'` with `type: "http"` hooks works in the interactive TUI, is additive to the user's settings, ~0.1 s latency: `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `Notification`, `PostToolUse`, `Stop`. Anthropic allows launching the unmodified official binary with the user's own login (https://code.claude.com/docs/en/legal-and-compliance).
- **OpenCode 1.18**: `opencode --port <n> --hostname 127.0.0.1` keeps the TUI; SSE `GET /event` streams `session.status` (busy/idle), `session.idle`, `message.part.updated` (tool pending/running/completed), `permission.asked` / `permission.replied`, text parts.
- **Codex 0.160**: `codex app-server --listen ws://…` + TUI `codex --remote ws://…` works, but an observer connection only received thread status; tool/approval events unverified (account over quota). Deferred.
- **Grok, Antigravity**: rich events only in headless / ACP modes (no TUI). Generic adapter only.

Rejected: ACP (replaces the TUI; Claude via Agent SDK with claude.ai login is not allowed), hook installation into user config, terminal-title parsing, internal session stores.

## Architecture

- `application`: `AgentEvent` contract (status_changed, tool_started, tool_finished, approval_required, message, completed, error), `AgentStatus`, a pure reducer from events to per-terminal `AgentState`, and the `AgentAdapter` notion: an adapter contributes launch augmentation (extra args / env) and turns its source into `AgentEvent`s.
- Agents launched **by the app** as profiles (command, args, env, cwd — still agent-agnostic in the domain); adapter-specific flags are added in infrastructure.
- Generic adapter: existing activity tracker + process exit → `status_changed` / `completed` / `error`.
- Claude adapter: local HTTP receiver (127.0.0.1, random port, per-launch secret) + per-launch `--settings` inline JSON with HTTP hooks.
- OpenCode adapter: free localhost port, `--port/--hostname`, SSE client; protect the server if OpenCode supports a password (`OPENCODE_SERVER_PASSWORD`, to verify).

## Constraints

- Clean Architecture; domain stays agent-agnostic (no agent-specific logic in `domain`).
- Nothing written to user config files; all integration is per-launch (flags / env).
- Localhost-only listeners with per-launch secrets.
- Strict TDD. Runners: `cargo test -p <crate>`, `pnpm test`, `pnpm test:e2e`.
- Git Flow: `feature/agent-adapters`, stacked on `feature/agent-status-info` (both unmerged).

## Tasks

- [x] **T1 — `AgentEvent` contract, reducer and generic adapter.** Replace the ad-hoc activity event with `AgentEvent`s; sidebar renders `AgentState`. Route: delegated writer. Commit `3fd8057`.
- [x] **T2 — Launch agents as profiles from the app.** New-terminal menu offers detected/known agents; the agent runs inside the default shell so the pane returns to the shell on exit; adapters can augment args/env. Route: delegated writer. Commit `1e4bc34`.
- [ ] **T3 — Claude Code adapter (`--settings` HTTP hooks).** Route: delegated writer.
- [ ] **T4 — OpenCode adapter (`--port` + SSE `/event`).** Route: delegated writer.
- [ ] **T5 — Codex adapter (app-server + `--remote`).** Deferred until Codex quota renews (2026-10-16) to verify tool/approval events.

## Acceptance criteria

- Sidebar shows, per terminal: status (working / idle / needs attention), current tool (e.g. `Bash: echo hi`), approval required with its description, completed / error.
- Claude Code and OpenCode launched from the app produce rich events; any other agent (or one typed by hand) still gets generic status.
- No user config file is created or modified; listeners bind to 127.0.0.1 and require a per-launch secret.

## Verification

```
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd apps/desktop && pnpm test && pnpm build && pnpm test:e2e
```

TDD: on (source: user global config). RDD: off (global). Delivery: ask-on-risk; PR slicing to be decided with the user at delivery (branch stack: agent-session-titles → agent-status-info → agent-adapters).

## Progress

- Branch created; feature document created.
- T1 `3fd8057`: `AgentEvent`/`AgentStatus` (working | idle only; approval is separate data), `AgentState::reduce` (rules documented in code, 13 tests), `AgentStates` (per-terminal, emits only on change), `AgentEventSink` + `AgentAdapter` (`prepare` -> `LaunchAugmentation{args, env, token}`, `bind(token, terminal, sink)`) + `AgentAdapters` registry. Generic adapter = `activity_event` / `exit_event` (exit code not exposed by `PtyPort`, so terminal exit reports `completed`). Wire: ONE event `terminal-agent-state { terminalId, state }` carrying the reduced state (reducer stays in Rust, frontend only formats: `agentState.ts`, 11 Vitest tests). `terminal-activity` removed. Sidebar shows status, tool (`Bash: echo hi`), `Needs approval: ...` (accent), error.
- T2 `1e4bc34`: `agent_shell_profile` (infrastructure) chains the agent inside the default shell (PowerShell: `; cmd 'args'` after the OSC 7 integration; Unix: `-c 'cmd; exec $SHELL'`), `command_exists` (PATH + PATHEXT), `KnownAgent::launch_command`, `open_shell(agent?)`, `available_agents`, `AppState.adapters` (empty: T3/T4 implement `AgentAdapter` and register there). Menu `+` lists installed agents; e2e `launch-agent`.
- Route evidence (T1, T2): delegated writer (multi-file Rust + frontend); `shell.rs` untouched (new module `agent_launch.rs` instead).

## Verification evidence

- RED observed: `cargo test -p application agent_state` (undeclared `AgentState`), `... launch_command` (E0599 no method), Vitest `Cannot find module './agentState'` (suite failed) and `newPane().agent` undefined (2 failures). Not strictly red: `agent_event` and `agent_adapter` tests were written together with their code (the module was not registered at first, 0 tests ran), `agent_launch` tests passed on first run, and the new real-shell e2e passed on first run.
- After T2: `cargo fmt --all --check` ok; `cargo clippy --workspace --all-targets -- -D warnings` ok; `cargo test --workspace` all pass (application 71, infrastructure 30 + 2 integration); `cargo test -p infrastructure --test shell_integration_e2e -- --ignored` 2 passed (real PowerShell runs the agent command inside the shell and returns to its OSC 7 prompt); `pnpm test` 7 files / 56 tests; `pnpm build` ok; `pnpm test:e2e` all scenarios pass.
- Not verified: launching a real agent CLI from the app UI (`cargo tauri dev` not run).
