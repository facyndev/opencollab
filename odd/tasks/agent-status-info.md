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
- [x] **T4 — Bring `develop` into this branch.** `develop` diverged (13 commits: subagent-adapters T4–T7 incl. subagent tree / hooks SettingsModal, and `status-bar-live`). Merge (no rebase), keep `status-bar-live`. Route: delegated writer (multi-file conflicts). Commit `94a583b`.
- [x] **T5 — Remove subagents, hooks and session titles entirely.** User decision (2026-10-05): agent-specific signals are not universal, drop them. Remove the subagent code that arrives from `develop`, the hook system (`HookReceiver`, `opencollab-hook` sidecar / `apps/hook-relay`, installers, translators, `OPENCOLLAB_*` env injection, hook commands/events, settings UI for hooks) and session titles (`TrackAgentSessionTitle`, `terminal-agent-session`, sidebar title item). Keep agent detection (`KnownAgent`, nested agents) and T1–T3. Route: delegated writer. Commits `aac8903` (code), `7eeeb68` (docs).

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

- T4 `94a583b`: merge of `develop` (no rebase). 11 conflicts (AGENTS.md, e2e run/mock, commands.rs, main.rs, state.rs, TerminalPane.tsx, model.ts, application/infrastructure lib.rs, subagent-adapters.md modify/delete): kept T1–T3 and `status-bar-live` (collab_status, relay probe, StatusBar) from both sides; develop's subagent pieces were dropped or kept only where needed to compile (`subagentsApi.ts`, grok in SettingsModal) until T5.
- T5 `aac8903` + `7eeeb68`: removed `apps/hook-relay`, hook receiver/installers/session-title translators, `HookInstaller`/`SessionTitleTranslator` ports, `HookEndpoint` env injection, hook/title Tauri commands and event, `SettingsModal` (it only configured hooks; its Settings button in the sidebar went with it), subagent tree/UI/tests/e2e, modal CSS, mock handlers. AGENTS.md hook paragraph removed; superseded notes added to the three older ODD docs.

## Verification evidence

- RED observed per behavior before implementing (Rust: compile errors for missing `ActivityTracker`/`Activity`, missing `primary_started_at`/`started_at`, missing `parse_head`/`Branch`/`InspectBranch`/`FsRepositoryInspector`; Vitest: `Cannot find module './activity'` and `'./duration'`). The sysinfo start-time assertion was added with the field and went GREEN directly (no separate RED).
- After T3: `cargo fmt --all --check`: ok; `cargo clippy --workspace --all-targets -- -D warnings`: ok; `cargo test --workspace`: all pass (application 55, infrastructure 74); `pnpm test`: 5 files / 38 tests pass; `pnpm build`: ok; `pnpm test:e2e`: all scenarios pass.

- After T5: `cargo fmt --all --check` ok; `cargo clippy --workspace --all-targets -- -D warnings` ok; `cargo test --workspace` all pass (application 48); `pnpm test` 6 files / 43 tests; `pnpm build` ok; `pnpm test:e2e` all scenarios pass (run with the user's WIP styles applied temporarily: the committed Sidebar imports the untracked brand logo, whose unstyled 13 MB image overlays the UI otherwise).
- Note: committed `Sidebar.tsx` imports `../assets/brand` (untracked user WIP), so a clean checkout does not build until the brand assets are committed.

## Next step

- Parent review; delivery strategy / PR slicing is the user's decision (no push done).
