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

- [ ] **T1 — `AgentEvent` contract, reducer and generic adapter.** Replace the ad-hoc activity event with `AgentEvent`s; sidebar renders `AgentState`. Route: delegated writer.
- [ ] **T2 — Launch agents as profiles from the app.** New-terminal menu offers detected/known agents; the agent runs inside the default shell so the pane returns to the shell on exit; adapters can augment args/env. Route: delegated writer.
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
