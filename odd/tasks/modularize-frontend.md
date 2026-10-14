# Modularize frontend directory structure (apps/web and apps/desktop)
Objective: Decompose monolithic files and modularize directory structures in apps/web and apps/desktop per issue #11
Branch: feature/modularize-frontend | Delivery: PR a develop | Test runner: vitest + cargo test

## Specs
- S1: "Decompose `apps/web/src/components.tsx` into individual components under `apps/web/src/components/`."
  Target structure:
  apps/web/src/components/
  ├── Field.tsx
  ├── Link.tsx
  ├── OAuthButtons.tsx
  ├── Shell.tsx
  └── index.ts
- S2: "Decompose `apps/web/src/pages.tsx` into individual page views under `apps/web/src/pages/`."
  Target structure:
  apps/web/src/pages/
  ├── AccountPage.tsx
  ├── AuthCompletePage.tsx
  ├── LoginPage.tsx
  ├── RegisterPage.tsx
  └── index.ts
- S3: "Move web clients (`authClient`, `handoff`) to `apps/web/src/services/` and routing/validation to `apps/web/src/utils/`."
  Target structure:
  apps/web/src/services/ (authClient.ts, authClient.test.ts, handoff.ts, handoff.test.ts)
  apps/web/src/utils/ (router.ts, validation.ts, validation.test.ts)
- S4: "Move desktop hooks to `apps/desktop/src/hooks/` and API/infrastructure modules to `apps/desktop/src/services/`."
  Target structure:
  apps/desktop/src/hooks/ (useAuth.ts, useCollabStatus.ts, useGitBranch.ts, usePaneDrag.ts, useWindowFocus.ts, index.ts)
  apps/desktop/src/services/ (auth.ts, auth.test.ts, branchWatch.ts, branchWatch.test.ts, terminalApi.ts, index.ts)
- S5: "Update all import paths across apps and test files accordingly."
- S6: "Ensure all packages and apps pass typechecking (`pnpm -r typecheck`), unit tests (`pnpm -r test`), and build (`pnpm -r build`)."
- S7: "Maintain strict boundaries: zero changes to `@opencollab/contracts` or `@opencollab/domain`."

## Tasks
- [x] T1 (S1) — Decompose `apps/web/src/components.tsx` into individual components under `apps/web/src/components/`. [route: direct inline, commit: 7f64c06]
- [x] T2 (S2) — Decompose `apps/web/src/pages.tsx` into individual page views under `apps/web/src/pages/`. [route: direct inline, commit: 7f64c06]
- [x] T3 (S3, S5) — Move web clients to `apps/web/src/services/` and utils to `apps/web/src/utils/`, updating all web imports and tests. [route: direct inline, commit: 7f64c06]
- [x] T4 (S4, S5) — Move desktop hooks to `apps/desktop/src/hooks/` and services to `apps/desktop/src/services/`, updating all desktop imports and tests. [route: direct inline, commit: 7f64c06]
- [x] T5 (S6, S7) — Comprehensive verification (`pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build`, `cargo test --workspace`) and boundary enforcement. [route: direct inline, commit: 7f64c06]

## Log
- L1: 2026-10-14 Verificación inicial: monorepo-apps corroborado y mergeado en develop (PR #10, commit 3c53e1f). Inicio de refactorización según Issue #11.
- L2: 2026-10-14 Modularización completada en apps/web y apps/desktop:
  - apps/web/src/components/: Field.tsx, Link.tsx, OAuthButtons.tsx, Shell.tsx, index.ts.
  - apps/web/src/pages/: AccountPage.tsx, AuthCompletePage.tsx, LoginPage.tsx, RegisterPage.tsx, index.ts.
  - apps/web/src/services/: authClient.ts, authClient.test.ts, handoff.ts, handoff.test.ts.
  - apps/web/src/utils/: router.ts, validation.ts, validation.test.ts.
  - apps/desktop/src/hooks/: useAuth.ts, useCollabStatus.ts, useGitBranch.ts, usePaneDrag.ts, useWindowFocus.ts, index.ts.
  - apps/desktop/src/services/: auth.ts, auth.test.ts, branchWatch.ts, branchWatch.test.ts, terminalApi.ts, index.ts.
  - Verificación integral:
    - pnpm -r typecheck: OK (0 errores).
    - pnpm -r test: OK (Vitest: 383/383 tests pasando).
    - pnpm --filter @opencollab/desktop test:e2e: OK (todos los escenarios E2E pasando).
    - pnpm -r build: OK (todos los paquetes y aplicaciones compilan).
    - cargo test --workspace: OK (85/85 tests de Rust pasando).
    - Límites de paquetes: 0 cambios en @opencollab/contracts y @opencollab/domain.
