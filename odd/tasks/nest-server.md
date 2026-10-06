# nest-server — relay NestJS + monorepo TS

## Objetivo

Migrar el relay de Rust (axum) a NestJS y dejar el monorepo con dos workspaces
conviviendo: Cargo (core Rust del desktop) y pnpm (server Nest + frontends).

## Problema

El relay Rust es un stub de ~60 líneas (eco + `/health`) sin auth ni sesiones.
La decisión del proyecto es backend NestJS: más ecosistema (Passport, JWT,
Prisma), mismo lenguaje que los frontends e iteración más rápida en CRUD.
El relay es fan-out de bytes (I/O, no CPU), así que Rust no aporta ahí lo que
sí aporta en el core del desktop (PTYs, procesos del SO).

## Por qué

- Velocidad de desarrollo del backend y auth web vía browser (OAuth exige
  browser real, no webview embebido).
- El swap es barato HOY (stub mínimo); caro en 3 meses con auth encima.
- Se rompe a conciencia la simetría "reglas una vez en Rust": el dominio Rust
  manda, Nest obedece; el wire se vuelve contrato versionado con tests espejo.

## Alcance

- `apps/server`: NestJS con `GET /health` (contrato del probe: `200` + cuerpo
  `ok`) y `/ws` con semántica de eco idéntica a la actual.
- `packages/contracts` y `apps/web`: T5, fuera de este documento por ahora.
- Auth, ruteo por sesión, filtrado por permiso, DB: T2–T4 (futuras).
- `apps/relay` (Rust) se elimina del workspace Cargo en T1.

## Restricciones

- Paridad de wire: frames de texto crudos con `Envelope` JSON; compatible→eco,
  versión vieja→`incompatible_protocol_version`, inválido→`invalid_message`.
- Puerto: `RELAY_ADDR` o `127.0.0.1:8787` (mismo parseo que el relay Rust).
- Sin `pnpm-workspace.yaml` raíz: no cambiar el flujo instalado de
  `apps/desktop` ni su job de CI (`--frozen-lockfile` con su propio lockfile).
  El server lleva su propio `package.json` + lockfile; comandos con
  `pnpm --dir apps/server`.
- Puertos de `application` siguen sincrónicos; el server Nest no los toca.
- TDD: modo sin resolver (no hay registro `sdd-init`); rigen checks funcionales
  ordinarios con tests al lado del código, no TDD estricto.

## Checklist

- [x] **T1** — Paridad Nest del relay stub (COMPLETADO 2026-10-05)
  - [x] `apps/server`: `GET /health` → `200` + `ok` exacto
  - [x] `apps/server`: `/ws` eco con semántica idéntica (función pura testeada)
  - [x] DTOs TS de `Envelope`/`Message` espejo de `crates/protocol`
  - [x] Quitar `apps/relay` del workspace Cargo (miembro + directorio)
  - [x] Retoque factual de `AGENTS.md` (stack + comando del relay)
  - [x] Job `server` en `ci.yml` (install + test + build)
  - Evidencia: commit work-unit en esta rama
- [ ] **T2** — Auth (login, tokens, endpoints para el flujo web + deep link)
- [ ] **T3** — Ruteo por sesión y filtrado por permiso vigente en `/ws`
- [ ] **T4** — DB (Prisma) según `architecture/persistence-seams`
- [ ] **T5** — `apps/web` + `packages/contracts` como fuente del wire

## Alcance autorizado

Rama `feature/nest-server`. Tocar: `apps/server/**` (nuevo), `Cargo.toml`
raíz (una línea), borrar `apps/relay/`, `AGENTS.md` (solo líneas del relay),
`.github/workflows/ci.yml` (solo job server). Nada del desktop ni de crates.

## Criterios de aceptación (T1)

1. `pnpm --dir apps/server install && pnpm test && pnpm build` en verde.
2. `GET /health` responde `200` con cuerpo `ok` (compatible con
   `HttpRelayProbe`: status + `body.trim() == "ok"`).
3. `/ws`: texto compatible→eco byte-identico; otra versión→error de versión;
   no-JSON→error de mensaje; binarios se ignoran (igual que axum).
4. `cargo check --workspace` en verde sin el miembro relay.
5. `git status` sin restos de `apps/relay/`.

## Checks aplicables

`pnpm test` (vitest), `tsc build`, `cargo check --workspace`.
Review: RDD on → `gentle-ai review assess --base-ref 8604838 --committed-only`
sobre el commit work-unit de T1.

## Ruta y estrategia de entrega

- Ruta: exploración por codegraph (delegación a subagentes no disponible en
  este runtime: el transporte falló con error de free-tier; se sigue inline y
  acotado). Writes directos de archivos nuevos del scaffold.
- Entrega: `ask-on-risk` (default). T1 es chico (<400 líneas); T2–T4
  probablemente excedan y se trocean al llegar.

## Progreso

- 2026-10-05: T1 iniciado. Stash previo en `stash@{0}`
  ("wip(agent-adapters)...", sobre la otra rama; recuperar con pop ahí, no acá).
  Rama base: `8604838`.
- 2026-10-05: T1 completado y commiteado (`6c43918`). Checks observados:
  typecheck, vitest (4/4), build, paridad viva contra contratos reales
  (PARITY OK: health 200+`ok` por TCP crudo, eco idéntico, errores de
  versión/mensaje, binarios ignorados), `cargo check --workspace`, gitleaks
  limpio. Hallazgo: Nest 11 exige adapter WS explícito (`@nestjs/platform-ws`;
  sin él el gateway no arranca).
- 2026-10-05: Review del candidato: consent granted, lineage
  `review-49c532c43c7cfddd`, pero las 4 lentes no lanzan
  (`opencode_review_transport_binding_invalid`, defecto conocido de binding
  sesión/proyecto). Reintento de un slot confirmó determinismo. Sin capturas
  no hay acknowledgement ni receipt: el candidato queda NO revisado y el
  límite revisado NO avanza. Transacción preservada sin quemar autoridad.
- 2026-10-05: Upgrade gentle-ai 3.7.0→4.0.0 a pedido del usuario. El `upgrade`
  gestionado falló (construyó `.../v3/cmd/gentle-ai@v4.0.0`, revisión inválida);
  se instaló manual con `go install .../v4/cmd/gentle-ai@v4.0.0` (Go 1.26.5).
  engram 3.0.0→3.1.0 OK; gga queda manual en Windows (fuera de pedido).
  `sync --agent opencode` (28 archivos, incl. `opencode-review-transport.ts`)
  levantó el `stop(managed_assets_outdated)` y el STATUS reofreció los 4 slots,
  pero los 4 revisores fallan idéntico: el plugin lanza el transporte con
  `cwd = worktree || directory` de la SESIÓN, y esta sesión no está bindeada
  al proyecto del repo. Veredicto: defecto ambiental de la sesión, no del
  candidato; la única recuperación es sesión nueva bindeada a opencollab.
- 2026-10-06: Rama rebaseada sobre `develop` (v0.2.0). Review de T1 contra
  `v0.2.0` (lineage `review-85b8d7227cca8c5c`, 4 lentes): pidió una
  corrección por `R3-wire-parity-envelope-validation` (CRITICAL: el TS solo
  miraba `version === 1`; serde valida el `Envelope` completo). Corregido en
  `b5e5efe` (validación completa + `1.0`/`1e0` rechazados vía `context.source`
  del reviver, Node 24), tests 8/8, typecheck y build OK; validación dirigida
  aprobada y acknowledged. Avisos no bloqueantes pendientes: parseo de
  `RELAY_ADDR` más laxo que `SocketAddr`, gateway/health sin test, buffer de
  envío sin límite, versión de pnpm en CI.
