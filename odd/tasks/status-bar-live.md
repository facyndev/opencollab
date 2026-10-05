# Status bar con estado real

## Objetivo

Que la status bar muestre datos reales: si el relay responde, la latencia
medida y cuántos participantes tiene la sesión activa.

## Problema

`StatusBar` tiene por defecto `connected = true`, `syncMs = 24` y
`collaborators = 3`, y `App` la renderiza sin props: la app siempre dice
"Connected · sync 24ms · 3 collaborators" aunque el relay sea un stub y la
sesión tenga un solo usuario. Lo detectó la revisión RDD de `35ac117`
(hallazgo crítico `R3-fake-connected-status`).

## Por qué así

- **Conexión y latencia**: el relay ya expone `GET /health`. El núcleo lo
  sondea periódicamente y mide el tiempo de ida y vuelta. Es la única señal
  real disponible hasta que exista `CollabTransport`; se reemplaza cuando haya
  cliente WebSocket.
- **Colaboradores**: `Session::participants(&workspace)` del dominio, contando
  solo quienes tienen acceso (`can_view`). Hoy da 1 (el usuario local).
- **Dirección del relay**: una constante compartida en `protocol`
  (`DEFAULT_RELAY_ADDR`), usada por el relay y por el desktop, pisable con
  `RELAY_ADDR`. Así el cambio de puerto pendiente (8787 → 38917) es una línea.

## Arquitectura

- `application`: puerto `RelayProbe` (sondeo → latencia o error), caso de uso
  `CheckRelay`, y `SessionCollaborators` (cuenta participantes con acceso).
- `infrastructure`: `HttpRelayProbe` (GET `/health` con `std::net`, timeout
  corto).
- `protocol`: `DEFAULT_RELAY_ADDR`.
- `apps/desktop`: comando `collab_status` + watcher que emite `collab-status`
  solo cuando cambia; hook de React que alimenta `StatusBar`; valores por
  defecto honestos (desconectado, sin latencia, 1 colaborador); mock de Tauri y
  escenario E2E.

## Alcance autorizado

Lo anterior (pedido explícito del usuario: "haz que sean dinámicos").
Fuera de alcance: cliente WebSocket real, cambio del puerto por defecto.

## Restricciones

- TDD estricto: activado (fuente: `~/.claude/CLAUDE.md`). Runners:
  `cargo test --workspace`, `pnpm test` (Vitest), `pnpm test:e2e`.
- El sondeo nunca bloquea la UI ni el núcleo: hilo propio, timeout corto.

## Tareas

- [x] **S1 — `application`**: `RelayProbe`, `CheckRelay`,
      `SessionCollaborators` con tests.
- [x] **S2 — `infrastructure` + `protocol` + relay**: `HttpRelayProbe` con
      tests contra un listener local; `DEFAULT_RELAY_ADDR` usado por el relay.
- [x] **S3 — desktop**: comando, watcher y evento; `StatusBar` alimentada por
      estado real con defaults honestos; Vitest, mock y E2E; `AGENTS.md`.

## Criterios de aceptación

- Sin relay corriendo: "Local · relay no conectado" y "1 collaborator".
- Con `cargo run -p relay`: "Connected · sync <n>ms" con la latencia medida,
  y vuelve a desconectado si el relay se cae.
- Ningún valor de la status bar está hardcodeado.

## Verificación

```
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd apps/desktop && pnpm test && pnpm build && pnpm test:e2e
```

## Entrega

Pronóstico ~500 líneas. Estrategia reutilizada de la feature anterior:
`stacked-to-main` hacia `develop`, un commit por tarea.

## Progreso

- 2026-10-05: documento creado; rama `feature/status-bar-live` desde
  `develop` (`2ac32e6`). La lineage de revisión abierta en el worktree de
  `35ac117` queda sin liberar (requiere autorización de maintainer).

- S1–S3: ruta **delegada** (disparador de escritor: 2+ archivos no triviales
  por tarea), un escritor en orden, un commit por tarea.
  - S1: `collab_status.rs` en application (`CheckRelay` nunca falla: error del
    sondeo → `Disconnected`; latencia ≥ 1 ms), `RelayProbe` en `ports.rs`.
    RED: E0432 → GREEN (application 46).
  - S2: `DEFAULT_RELAY_ADDR` en protocol (usado por el relay),
    `HttpRelayProbe` (deadline total 1 s, éxito solo con `200` + `ok`,
    respuesta ≤ 4 KiB), 7 tests contra listener local. RED parcial (forzado
    temporal); bug de escrituras múltiples encontrado y corregido con un solo
    `write_all`.
  - S3: watcher cada 3 s; emite `collab-status` si es el primero, cambia
    `connected` o `collaborators`, o la latencia se mueve > 5 ms y > 25 %.
    Comando `collab_status` async. Defaults honestos en `collabStatus.ts`.
    Mock + escenario E2E `status-bar-live.mjs` (sin RED: escrito junto al
    código). RED observado en `should_emit` (stub) y en Vitest (módulo
    faltante).
  - Verificación: escritor corrió fmt, clippy, `cargo test --workspace`,
    `pnpm test`, `pnpm build`, `pnpm test:e2e` (todo verde); el padre
    re-corrió fmt check, `cargo test --workspace` y `pnpm test` (28).

## Siguiente paso

Revisión RDD por commit (S1, S2, S3) y verificación manual con
`cargo run -p relay` + `cargo tauri dev`.
