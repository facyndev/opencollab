# Agent state next to the title, branch as a thread line

## Objective

In the sidebar thread, show the agent state next to the terminal title (`Claude Code · Working`) instead of the colored dot, and show the git branch below it as a thread line. Fix stale branches.

## Problem

- The state lives in the secondary line, while the title row only has a dot that duplicates it.
- Branches go stale: `useGitBranch(cwd, activity === "idle")` only re-queries when the cwd changes (OSC 7, emitted only at the shell prompt, so never while an agent runs) or when the boolean "idle" flips. An agent that switches branch (or another agent switching the same folder) is not seen until the next working→idle transition. Observed: two terminals on the same folder showed different branches (`feature/nest-server` vs a stale `develop`).

## Why this approach

- The branch belongs to the folder, not to the agent. Reading `HEAD` is cheap (no `git` binary), so polling the branch on an interval while the pane is mounted is the simplest correct fix; keep the idle-transition refresh too.
- Agent label/tone already come from `describeAgent` (`src/agentState.ts`); reuse it for the title row, no new reducer.

## Scope

- Frontend only: `Sidebar.tsx`, `ThreadMeta.tsx` (+ CSS), `useGitBranch.ts`, unit tests, e2e scenario/mock if affected.
- Docs: AGENTS.md (sidebar thread / branch refresh notes).

## Constraints

- Strict TDD (RED → GREEN → REFACTOR). Source: user global config ("Strict TDD Mode: enabled"). Runners: `pnpm test` (Vitest), `pnpm build`, `pnpm test:e2e` (from `apps/desktop`).
- Git Flow: branch `feature/thread-agent-status` from `develop`, in worktree `../opencollab-worktrees/work` (another agent uses the main checkout).
- Terminals without a detected agent keep the existing status dot.

## Tasks

- [x] **T1 — Branch refresh polling.** `useGitBranch` re-queries every few seconds (and on cwd / refreshKey change); pure, tested helper where possible. Route: delegated writer (preparation trigger + multi-file). Done in `29e9d54`; RED: `branchWatch.test.ts` failed (module missing), GREEN 61 tests; `pnpm build` ok.
- [x] **T2 — State next to the title, branch as a thread line.** Title row: `<icon> <name> · <state label>` with the tone color/icon, replacing the dot when an agent is detected. Branch rendered below as a thread child line (same connector look as nested agents). Tool detail and uptime stay in the secondary line. Update e2e scenario. Route: delegated writer. Done in `6b7d5be`; RED: 19 e2e checks failed before the UI change, GREEN: `pnpm test` 61 passed, `pnpm build` ok, `pnpm test:e2e` exit 0.
- [x] **T3 — Review follow-ups.** Ignore out-of-order branch poll responses (sequence number), keep the last known branch on query error (null only if none known yet), fix the carriage-return cwd fixture in `branchWatch.test.ts`, and use `heads[0]?.includes` consistently in `thread-meta.mjs`; AGENTS.md updated. Route: delegated writer. Done in `9e04b6c`; RED: 2 new `branchWatch` tests failed, GREEN: `pnpm test` 63 passed, `pnpm build` ok, `pnpm test:e2e` all passed.

## Acceptance criteria

- Two terminals on the same folder show the same branch within a few seconds of a branch switch, with no idle transition needed.
- With an agent: title shows `Name · Working|Idle|Needs attention|…`; no dot. Without an agent: dot as before.
- Branch shows under the terminal as a thread line.
- `pnpm test`, `pnpm build`, `pnpm test:e2e` pass.

## Progress

- Created 2026-10-05. Delivery strategy: ask-on-risk (forecast < 400 lines).
- T1, T2 and T3 implemented 2026-10-05. Next: review and delivery (PR to `develop`).
