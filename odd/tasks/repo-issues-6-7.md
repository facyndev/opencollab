# Objective: Resolve GitHub Issues #6 (sidebar agent state & attention) and #7 (agent/subagent process CWD & worktree branch tracking)
Branch: `fix/sidebar-agent-attention` (#6), `feat/git-worktree-branch-tracking` (#7) | Delivery: `single-pr` per issue into `develop` | Test runner: `pnpm -r test && cargo test --workspace`

## Specs

- **S1** (`#6`): Quote from user & issue #6: `"fix(sidebar): agent state detection unreliable and 'Needs attention' clears prematurely on window focus/hover"` — `"1. 'Needs attention' appears in the sidebar for a terminal running an agent. 2. As soon as the user hovers over or brings focus towards the application window, the 'Needs attention' badge disappears immediately before the user can inspect or acknowledge it. 3. The detector appears inaccurate regarding whether an agent is actively working, waiting for an LLM response, or awaiting user approval."` — `"Differentiate real user interaction/acknowledgement from window focus/pointer events."`
  - **Scope & Checks**:
    - Do not clear `attention` (`Needs attention`) merely because `windowFocused` transitions `false -> true` on an already-focused pane; clear `attention` only when the pane itself transitions to active focus while watching (`shouldClearAttentionOnWatchChange`), or on explicit user interaction with the pane (`pointerdown`, `keydown` in terminal, or clicking the terminal item in the sidebar).
    - Do not emit generic PTY byte-silence `StatusChanged` events for terminals with no active agent (`tree.primary.is_none()`), and clear stale `AgentState` / `ActivityTracker` state when an agent process exits back to the shell so shell prompt output does not trigger false `Working` / `Idle` / `Needs attention` states.
    - Checks: `pnpm --filter @opencollab/ui test`, `pnpm --filter @opencollab/desktop test`, `cargo test --workspace`.
- **S2** (`#7`): Quote from user & issue #7: `"feat(git): track worktrees and isolate branch context for agents and subagents"` — `"Inspeccionar el CWD real del proceso del agente/subagente activo (sysinfo con with_cwd) para actualizar la rama de Git mostrada cuando trabajan en un worktree"` — `"Subagent / Process Working Directory Inspection: Inspect the active working directory of running agent processes (or expose an integration/hook for agents) to detect when execution moves into a worktree."`
  - **Scope & Checks**:
    - Refresh process CWDs in `SysinfoProcessInspector` (`ProcessRefreshKind::nothing().with_cmd(UpdateKind::OnlyIfNotSet).with_cwd(UpdateKind::Always)`) and include `cwd: Option<PathBuf>` in `ProcessInfo` and `AgentTree` (tracking the deepest active agent/subagent CWD or primary agent CWD when running inside a worktree/subfolder).
    - Include `agent_cwd: Option<String>` in `terminal-agent` event payload so `TerminalPane` resolves `useGitBranch` against `agentCwd ?? cwd`, updating the Git branch shown in the sidebar thread when an agent or subagent works in a separate Git worktree without mutating the parent shell's OSC 7 `cwd`.
    - Checks: `cargo test --workspace`, `pnpm --filter @opencollab/desktop test`, `pnpm --filter @opencollab/desktop build`.

## Tasks

- [x] **T1** (`S1`, route: `inline`, commit: `aac0a8e`, RED/GREEN: `src/activity.test.ts` 3 failed -> 15 passed, `cargo test -p desktop` 42 passed): Prevent premature `Needs attention` clearance on window focus/hover and isolate agent activity tracking from raw shell output.
- [x] **T2** (`S2`, route: `inline`, commit: `b91c09c`, RED/GREEN: `reports_active_cwd_of_primary_agent_and_prefers_subagent_worktree_cwd` & `sees_the_current_process_and_its_parent` failed -> passed): Inspect active agent/subagent process CWD via `sysinfo` and use it for per-pane Git branch resolution in worktrees.

## Log

- **L1** (2026-10-24): `"take de repo issues and fix it"`
- **L2** (2026-10-24): User selected `#8` first (completed and merged in PR #18), then confirmed for `#6` and `#7`: `"Resolver primero #6 en fix/sidebar-agent-attention y luego #7 en feat/git-worktree-branch-tracking (cada uno desde develop)"` and `"Inspeccionar el CWD real del proceso del agente/subagente activo (sysinfo con with_cwd) para actualizar la rama de Git mostrada cuando trabajan en un worktree"`.
- **L3** (2026-10-24): Completed T1 (`aac0a8e`) on `fix/sidebar-agent-attention` (PR #19 created).
- **L4** (2026-10-24): Completed T2 (`b91c09c`) on `feat/git-worktree-branch-tracking`. All tests passing.
