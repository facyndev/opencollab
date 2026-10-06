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
- TDD (T2 en adelante): **estricto**, fuente `~/.claude/CLAUDE.md`
  ("Strict TDD Mode: enabled"), runner `pnpm --dir apps/server test`
  (vitest). RED observado antes de implementar. (T1 corrió sin TDD.)

## Checklist

- [x] **T1** — Paridad Nest del relay stub (COMPLETADO 2026-10-05)
  - [x] `apps/server`: `GET /health` → `200` + `ok` exacto
  - [x] `apps/server`: `/ws` eco con semántica idéntica (función pura testeada)
  - [x] DTOs TS de `Envelope`/`Message` espejo de `crates/protocol`
  - [x] Quitar `apps/relay` del workspace Cargo (miembro + directorio)
  - [x] Retoque factual de `AGENTS.md` (stack + comando del relay)
  - [x] Job `server` en `ci.yml` (install + test + build)
  - Evidencia: commit work-unit en esta rama
- [x] **T2** — Dominio colaborativo en Nest (`apps/server/src/domain`, TS puro,
  sin Nest ni Prisma): `AccessLevel` ordenado, `Workspace`, `Session`
  (`accessOf`, overrides lazy, invitados), `Invitation`, `Terminal`/
  `AgentProfile`, errores. Portar los tests de `crates/domain` como specs
  (RED primero) para que ninguna invariante se pierda.
- [ ] **T3** — Persistencia completa: Prisma + PostgreSQL. Esquema acordado:
  `User`, `PasswordCredential`, `OAuthIdentity`, `RefreshToken`,
  `DesktopLoginCode`, `Workspace`, `WorkspaceMember`, `Session`,
  `SessionAccessOverride`, `SessionGuest`, `Terminal` (con `position`),
  `Invitation` (kind + status + `expiresAt`/`respondedAt`); migración inicial con `citext` y CHECK de `Invitation`,
  `docker-compose` local, servicio Postgres en el job `server` del CI,
  repositorios que mapean agregados ↔ filas con tests de integración.
- [ ] **T4** — Auth: usuario o email + contraseña (argon2id), OAuth GitHub y
  Google (identidades vinculables), access JWT + refresh rotado con detección
  de reuso, `DesktopLoginCode` (PKCE) para el deep link al desktop.
- [ ] **T5** — Ruteo por sesión y filtrado por permiso vigente en `/ws`.
- [ ] **T6** — `apps/web` + `packages/contracts` como fuente del wire.
- [ ] **T7** — Achicar `crates/domain` a lo que necesita el desktop (PTY,
  terminal, validación final con el `AccessLevel` que manda el server) y
  actualizar `AGENTS.md` (deja de regir "el dominio Rust manda").

## Decisiones (2026-10-06)

- El server Nest es dueño del dominio colaborativo (workspaces, membresías,
  sesiones, invitaciones, resolución de permisos). Rust conserva PTY,
  procesos, agentes y la validación final del input antes del PTY. Motivo:
  con la DB en el server, "Rust manda, Nest obedece" obligaba a duplicar las
  reglas en TS a mano. Descartados: espejo TS con tests (duplicación
  permanente) y Rust→WASM/napi (toolchain cruzado).
- DB completa ahora (no mínima), antes de la auth. Motor: PostgreSQL.
- Auth: OAuth GitHub + Google, y usuario o email con contraseña.
- Esquema: fechas terminan en `At`; `User` sin avatar; acceso efectivo nunca
  se guarda (solo overrides y nivel de invitado); sin fila de override =
  `VIEW`; `Terminal.env` no se persiste por defecto (puede tener secretos);
  usuarios OAuth reciben `username` generado y editable; el server valida que
  quien acepta una invitación sea el invitado.

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
- Ruta T2+: delegado directo (la delegación vuelve a funcionar el
  2026-10-06; el mapeo del dominio se hizo con un Explore). Cada tarea toca
  2+ archivos no triviales → un writer por tarea. Límite revisado vigente:
  `b5e5efe` (review de T1 acknowledged).
- Entrega: `ask-on-risk` (default). T1 es chico (<400 líneas). Pronóstico
  T2–T4: ~2000+ líneas (dominio+tests ~700, persistencia ~600, auth ~900),
  excede el presupuesto. Estrategia de cadena elegida: **stacked-to-develop**
  (cada PR apunta a la anterior, la primera a `develop`). Slices:
  `feature/nest-server` (T1) ← `feature/nest-domain` (T2) ←
  `feature/nest-persistence` (T3) ← `feature/nest-auth` (T4).
- Alcance autorizado T2–T4: `apps/server/**`, `docker-compose.yml` raíz
  (Postgres local), job `server` de `ci.yml`, este documento.

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
- 2026-10-06: Replan (commit `48074a4`) re-revisado junto con T1 contra
  `v0.2.0` (lineage `review-9d0264b188540866`, 4 lentes): aprobado sin
  correcciones y acknowledged (autoridad quemada). Avisos nuevos no
  bloqueantes: socket WS sin listener de `error` (gateway), niveles de acceso
  duplicados en `protocol.ts` vs dominio, contradicción de autoridad en
  `AGENTS.md` (se resuelve en T7), numeración de tareas en "Alcance".
- 2026-10-06: T2 completado en `feature/nest-domain` (writer delegado,
  TDD estricto). RED: 5 specs fallando por módulos inexistentes; GREEN:
  `pnpm --dir apps/server test` 48/48 (8 protocolo + 40 dominio, todos los
  tests de `crates/domain` portados + extras), typecheck y build limpios
  (re-corridos por el parent). ~860 líneas (mayoría specs). Pendiente para
  T3: constructor de rehidratación de `Workspace`/`Session` desde la DB.
- 2026-10-06: Review de T2 (`58be74e`, base `48074a4`, lineage
  `review-49312da2b2ae9c15`, riesgo medio, 1 lente): aprobada y
  acknowledged. Límite revisado → `58be74e`. Avisos no bloqueantes para T3:
  un invitado promovido a miembro aparece duplicado en `participants`
  (`session.ts:115`); un override de miembro removido sobrevive si vuelve a
  ser miembro (`session.ts:135`); `setAccess` no valida el nivel en runtime;
  `AgentProfile` comparte los arrays recibidos (aliasing). Verificar si
  Rust tiene el mismo comportamiento antes de corregir.
- 2026-10-06: Review de la rama completa contra `v0.2.0` (lineage
  `review-6c225b960e5e679a`, 4 lentes) pidió una corrección:
  `R3-ci-pnpm-version-unresolvable` (CRITICAL, real: `apps/server/package.json`
  sin `packageManager`, `pnpm/action-setup` no resolvía versión → el job
  `server` del CI no corría). Corregido en `4a391ad` (`pnpm@11.1.1`, igual
  que el desktop), install frozen + tests 48/48 OK; validación dirigida
  aprobada y acknowledged.
- 2026-10-06: Historial local reordenado (sin push previo): el fix se
  cherry-pickeó a `feature/nest-server` (`cb00aeb`) y `feature/nest-domain`
  se rebaseó encima (el `4a391ad` original se descartó por ya estar abajo;
  árbol final idéntico). Hashes nuevos de T2: `8f9ef23` (código), `bbfb2df`
  y este doc. Los hashes citados arriba (`58be74e`, `8f7a68b`, `4a391ad`)
  son los previos al rebase.
