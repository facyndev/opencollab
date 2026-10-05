# Agent-agnostic status info in the sidebar thread

## Objective

Show helpful, agent-agnostic info under each terminal in the sidebar thread: activity (working / idle / needs attention), how long the agent has been running, and the git branch of the terminal's current folder.

## Problem

With several agents running in parallel the user cannot tell, without focusing each pane, which agent is still working and which one finished or is waiting for input. Agent-specific signals (terminal title formats, hooks, internal session stores) do not work for every agent, so they were rejected.

## Why this approach

Every signal must work the same for any CLI (domain rule: agents are agnostic):

- **Activity**: inferred from PTY output. A working TUI redraws constantly (spinners, streaming text); an idle one goes quiet. No output for a threshold (3 s) means idle. Working → idle while the pane is not focused means "needs attention" until the user focuses it. Cannot tell "finished" from "asking for approval": both mean "go look".
- **Uptime**: start time of the detected agent process (`sysinfo`), already inspected by agent detection.
- **Git branch**: read from the terminal's current folder (reported by OSC 7), walking up to `.git` and reading `HEAD`. No `git` binary required.

## Scope

- Rust: application logic (pure, tested), infrastructure adapters, desktop wiring (events / commands).
- Frontend: sidebar thread meta line, e2e mock and scenario.
- Docs: AGENTS.md.

## Constraints

- Clean Architecture: logic in `application`, I/O in `infrastructure`, thin Tauri adapters.
- No agent-specific logic. No user installation or config changes.
- Strict TDD (RED → GREEN → REFACTOR). Runners: `cargo test -p <crate>`, `pnpm test` (Vitest), `pnpm test:e2e`.
- Git Flow: branch `feature/agent-status-info` (stacked on `feature/agent-session-titles`, not yet merged into `develop`).

## Tasks

- [x] **T1 — Activity (working / idle / needs attention).** Route: delegated writer (multi-file, Rust + frontend). Commit `f7db075`.
- [x] **T2 — Agent uptime.** Route: delegated writer. Commit `dbbc01f`.
- [x] **T3 — Git branch of the current folder.** Route: delegated writer. Commit `1250a01`.

## Acceptance criteria

- Sidebar shows, under each terminal with a detected agent, its activity state; "needs attention" appears when it goes idle while unfocused and clears on focus.
- Sidebar shows elapsed time since the primary agent process started, updating live.
- Sidebar shows the git branch (or short SHA when detached) of the terminal's current folder, for any terminal inside a repo; nothing outside a repo.
- Works for any agent / CLI; no agent-specific code paths.

## Verification

```
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd apps/desktop && pnpm test && pnpm build && pnpm test:e2e
```

TDD: on (source: user global config "Strict TDD Mode: enabled").
RDD: off (global) → delivery unmanaged; ordinary checks apply.
Delivery strategy: ask-on-risk; forecast ~600–900 authored lines total.

## Progress

- T1 `f7db075`: `ActivityTracker` (application, injectable `Instant`, 7 unit tests), `terminal-activity` event emitted on change from the 1 s watcher loop, frontend `activity.ts` (7 Vitest tests), `ThreadMeta` line, e2e scenario `thread-meta.mjs`.
- T2 `dbbc01f`: `ProcessInfo.started_at` (sysinfo `start_time`, 0 -> None), `AgentTree.primary_started_at`, `startedAt` in `terminal-agent`; `duration.ts` (6 Vitest tests), shared 1 s timer `useNow.ts`.
- T3 `1250a01`: `Branch` + `parse_head` + `RepositoryInspector` port + `InspectBranch` (application), `FsRepositoryInspector` (infrastructure, 8 temp-dir tests), `git_branch` command, `useGitBranch.ts`, e2e mock `branches`/`prompt`.
- Design note: attention state and the `focused` check live in `TerminalPane` (reported through `PaneMeta`), so `App.tsx` (user-modified) was not touched.

## Verification evidence

- RED observed per behavior before implementing (Rust: compile errors for missing `ActivityTracker`/`Activity`, missing `primary_started_at`/`started_at`, missing `parse_head`/`Branch`/`InspectBranch`/`FsRepositoryInspector`; Vitest: `Cannot find module './activity'` and `'./duration'`). The sysinfo start-time assertion was added with the field and went GREEN directly (no separate RED).
- After T3: `cargo fmt --all --check`: ok; `cargo clippy --workspace --all-targets -- -D warnings`: ok; `cargo test --workspace`: all pass (application 55, infrastructure 74); `pnpm test`: 5 files / 38 tests pass; `pnpm build`: ok; `pnpm test:e2e`: all scenarios pass.

## Next step

- Parent review; delivery strategy / PR slicing is the user's decision (no push done).
