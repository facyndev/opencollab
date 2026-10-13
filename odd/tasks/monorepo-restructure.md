# Monorepo restructure — apps/* + packages/* (domain manda)
Objective: Migrar a apps/web, apps/desktop, apps/api + packages/domain, contracts, ui, api-client, config, utils
Branch: feature/monorepo-apps | Delivery: PR a develop | Test runner: vitest + cargo test

## Specs
- S1: `packages/domain` (@opencollab/domain) es la única autoridad de reglas colaborativas (Workspace, Session, Invitation, permission, ids, errores) en TypeScript puro sin dependencias de Nest, Prisma ni React. `server/src/domain/index.ts` re-exporta `@opencollab/domain`. Todos los tests unitarios del dominio (*.spec.ts) corren y pasan en `packages/domain`.
- S2: `packages/contracts` (@opencollab/contracts) es la única fuente del wire contract (Envelope, Message, AccessLevelDto, parseFrame, PROTOCOL_VERSION = 1). Paridad de bytes con Rust (snake_case, Vec<u8> como number[], versión u16). Zod schemas para validación.
- S3: Mudanza de rutas de aplicaciones y Rust: `packages/desktop` -> `apps/desktop`, `packages/server` -> `apps/api`, `packages/web` -> `apps/web`, y `crates/*` -> `apps/desktop/core/*`. Actualización de miembros en `Cargo.toml`, `pnpm-workspace.yaml` (apps/* y packages/*) y configuración de `turbo.json` con `dependsOn: ["^build"]`.
- S4: `packages/ui` (@opencollab/ui) contiene componentes presentacionales compartidos (Panel, Sidebar, StatusBar, TopBar, ThreadMeta, icons, helpers puros) sin lógica de negocio ni `@tauri-apps/api`.
- S5: Builds con tsup en cada package (CJS + ESM + d.ts). `apps/api` permanece en CJS (`dist/main.js`). Desktop y web consumen paquetes compilados.
- S6: Prisma vive dentro de `apps/api` (`prisma/schema.prisma`, `prisma.config.ts`, migraciones y cliente generado).
- S7: Compatibilidad en CI (`ci.yml`, `release.yml`), Dockerfiles (`apps/api`, `apps/web`), `.dockerignore`, `tauri.conf.json` y scripts de versionado (`check-version.ps1`, `package-release.ps1`).
- S8: Verificación integral de la suite completa: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r test`, `cargo test --workspace`, `cargo clippy`, `cargo fmt --check`, E2E desktop y tests de integración.

## Tasks
- [x] T1 (S1) — `packages/domain`: consolidar `packages/domain` (@opencollab/domain) con TS puro; server re-exporta; tests de dominio pasan. [route: direct inline, commit: 83d9cde]
- [x] T2 (S2) — `packages/contracts`: wire contract Zod único y paridad de bytes con Rust verificado; server y apps consumen contracts. [route: direct inline, commit: da245c4]
- [x] T3 (S3) — Mudanza estructural a `apps/*` y `apps/desktop/core/*`: Cargo.toml, pnpm-workspace.yaml, turbo.json. [route: direct inline, commit: 7a5da79]
- [x] T4 (S4) — `packages/ui`: extracción de componentes presentacionales compartidos. [route: direct inline, commit: 51d27d1]
- [x] T5 (S5) — Builds con tsup en packages y empaquetado CJS/ESM. [route: direct inline, commit: 87467f1]
- [x] T6 (S6) — Prisma ubicado en `apps/api`: cliente generado y scripts aislados. [route: direct inline, commit: 7a5da79]
- [x] T7 (S7) — CI/CD, Dockerfiles y scripts de release actualizados. [route: direct inline, commit: fdaaedb]
- [x] T8 (S8) — Verificación integral (builds, unit tests, integración, E2E, Docker). [route: direct inline]

## Log
- L1: 2026-10-13 "sigamos con monorepo-apps" — Retoma de la reestructuración a apps/* y packages/* con domain como autoridad.
- L2: 2026-10-13 Verificación integral completada (T8):
  - pnpm -r build: OK (todos los paquetes y apps compilan).
  - pnpm -r typecheck: OK (0 errores en TS).
  - pnpm -r test: OK (444/444 tests en Vitest).
  - cargo test --workspace: OK (97/97 tests en Rust).
  - cargo clippy: OK (-D warnings sin alertas).
  - cargo fmt --check: OK.
  - shell_integration_e2e: OK (2/2 tests de PTY y shell real).
  - desktop test:e2e: OK (todos los escenarios E2E pasando).
  - Scripts de versionado (check-version.ps1): OK para desktop (0.3.0), server (0.1.0), web (0.1.0).
