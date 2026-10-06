> Status: superseded/removed on 2026-10-05 by agent-status-info T5 (agent-specific signals are not universal). Kept as history only.

# Subagentes en tiempo real vía adaptadores por agente

## Objetivo

Mostrar en el hilo del sidebar, en tiempo real, los subagentes que lanza cada
agente (Task/Agent de Claude Code, `task` de OpenCode, `spawn_agent` de Codex),
con su estado (corriendo / terminado / error), anidados bajo la terminal que los
tiene.

## Problema

`detect_agents` solo ve el árbol de procesos. Los subagentes de Claude Code,
OpenCode y Codex corren dentro del mismo proceso: no tienen pid y son
inobservables desde ahí (probado por el usuario con un subagente de OpenCode).

## Por qué así

Investigación (2026-10-05): ningún agente expone una API en vivo por defecto,
pero tres de cuatro tienen un mecanismo de extensión con eventos de subagente.
El usuario aceptó instalar hooks/plugins opt-in.

| Agente | Mecanismo | Dónde | Inicio | Fin |
|---|---|---|---|---|
| Claude Code 2.1.x | hooks `SubagentStart` / `SubagentStop` | `~/.claude/settings.json` (append, no pisa) | sí | sí |
| OpenCode 1.18 | plugin `opencollab.ts` (`event`: `session.created` con `parentID`; `tool.execute.after` de `task`) | `~/.config/opencode/plugins/` | sí | a verificar |
| Codex 0.160 | hooks command `SubagentStart` / `SubagentStop` (`async: true`) | `~/.codex/hooks.json` (append; Codex pide aprobarlos) | sí | sí |
| Antigravity 1.2 | sus hooks no tienen eventos de subagente | nada | no | no |

**Centralización**: OpenCollab inyecta en cada PTY `OPENCOLLAB_TERMINAL_ID`,
`OPENCOLLAB_HOOK_URL` y `OPENCOLLAB_HOOK_TOKEN`. Los hooks heredan ese entorno y
mandan el payload crudo a **un único receptor HTTP local** (`127.0.0.1`, puerto
aleatorio, token). Así cada evento ya viene atado a su terminal, sin mapear
pid/cwd. Fuera de OpenCollab las variables no existen y el hook no hace nada.

**Transporte de los hooks**: un binario chico `opencollab-hook` (sidecar) que
lee stdin, lee el entorno y hace el POST. Evita depender de `curl`, `node` o de
la sintaxis de cada shell. Claude Code y Codex lo invocan como hook `command`;
el plugin de OpenCode usa `fetch` directo.

## Arquitectura (Clean / Hexagonal)

- `application`:
  - Modelo `SubagentEvent { terminal, agent, subagent_id, parent_id, kind, label, status }`
    y el árbol `SubagentTree` por terminal.
  - Puerto `SubagentEventTranslator` (uno por agente): payload crudo → `SubagentEvent`.
  - Puerto `HookInstaller` (uno por agente): `status` / `install` / `uninstall`.
  - Caso de uso **hub** `TrackSubagents`: recibe eventos crudos, elige el
    traductor por agente, actualiza el árbol, devuelve los cambios por terminal.
  - Casos de uso `InspectHookInstallation` / `InstallAgentHooks`.
- `infrastructure`:
  - Receptor HTTP local (sync, coherente con los puertos sincrónicos).
  - Traductores `ClaudeCodeTranslator`, `OpenCodeTranslator`, `CodexTranslator`.
  - Instaladores `ClaudeCodeHookInstaller`, `OpenCodePluginInstaller`,
    `CodexHookInstaller`, `AntigravityHookInstaller` (este reporta "no soportado").
  - Inyección de variables de entorno en el PTY.
- `apps/hook-relay` (nuevo bin): el sidecar `opencollab-hook`.
- `apps/desktop`: wiring del receptor y el hub, evento `terminal-subagents`,
  comandos para ver/instalar hooks (siempre con confirmación del usuario), UI.

Reglas: `domain` no cambia (los agentes son agnósticos); `application` sin
serde ni I/O; los comandos Tauri solo traducen y delegan.

## Alcance autorizado

Implementación de lo anterior. La instalación real de hooks en la config del
usuario ocurre solo desde la app y con confirmación explícita en cada agente.

Fuera de alcance: Antigravity (más que reportar "no soportado"), lectura de
transcripciones/conversaciones (solo metadatos), cambios en `protocol`.

## Restricciones

- TDD estricto: activado (fuente: `~/.claude/CLAUDE.md` global, "Strict TDD
  Mode: enabled"). Runner: `cargo test --workspace`, `pnpm test` (Vitest).
- Instaladores idempotentes, solo agregan entradas propias, backup antes de escribir.
- Los hooks nunca bloquean al agente: timeout corto, fallan en silencio.

## Tareas

- [x] **T1 — Modelo y hub en `application`.** `SubagentEvent`, `SubagentTree`,
      puerto `SubagentEventTranslator`, caso de uso `TrackSubagents` con tests
      (inicio, fin, error, anidamiento por `parent_id`, terminal cerrada).
- [x] **T2 — Traductores en `infrastructure`.** Claude Code, OpenCode, Codex,
      con fixtures de payloads documentados.
- [x] **T3 — Receptor HTTP local + inyección de entorno en el PTY.**
- [x] **T4 — Sidecar `opencollab-hook`.**
- [x] **T5 — Instaladores** (puerto `HookInstaller` + 4 adaptadores) con tests
      sobre directorios temporales (merge sin pisar, idempotencia, uninstall).
- [x] **T6 — Wiring en desktop**: hub, evento `terminal-subagents`, comandos de
      estado/instalación.
- [x] **T7 — Frontend**: árbol de subagentes con estado en el sidebar, panel de
      instalación con confirmación, mock y escenario E2E.
- [ ] **T8 — Verificación real y docs**: probar con cada agente instalado,
      actualizar `AGENTS.md`.

## Criterios de aceptación

- Un subagente de Claude Code / OpenCode / Codex aparece bajo su terminal al
  lanzarse y cambia a terminado al cerrar.
- Subagentes anidados se muestran como árbol.
- Instalar dos veces no duplica entradas; desinstalar deja la config como estaba.
- Fuera de OpenCollab los hooks no hacen nada y no fallan.
- Antigravity se muestra como "no soportado".

## Verificación

```
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd apps/desktop && pnpm test && pnpm build && pnpm test:e2e
```

## Entrega

Pronóstico: ~1500–2000 líneas → supera el presupuesto de ~400. Estrategia:
`ask-on-risk`; encadenado elegido por el usuario: **`stacked-to-main`** (PRs
apilados que se integran en orden hacia `develop`, la rama de integración de
Git Flow). Cortes de PR: se registran acá a medida que se cierran tareas.

## Progreso

- 2026-10-05: investigación hecha, documento creado.
- 2026-10-05: rama `feature/subagent-adapters` creada desde `62ad3ea`
  (`feature/split-terminal`, ya commiteada por el usuario).
- T1: ruta **delegada** (disparador de escritor: 2+ archivos no triviales en
  `application`). Cerrado y mergeado a `develop` (`def99cc`).
- T2: ruta **delegada** (disparador de escritor: 2+ archivos no triviales en
  `infrastructure`). Cerrado en rama `feature/subagent-adapters-t2`: un módulo
  `crates/infrastructure/src/subagent_translators.rs` (481 líneas) con
  `ClaudeCodeTranslator`, `OpenCodeTranslator`, `CodexTranslator` + fixtures
  en `mod fixtures` (9 payloads JSON con suposiciones documentadas) + 19 tests
  (inicio/fin/error por traductor, anidamiento por `parent_id`, inválido→Err,
  `tool` irrelevante de OpenCode→`Ok(vec![])`, integración con `TrackSubagents`
  real). TDD estricto (fuente: este documento): RED→GREEN→REFACTOR observado.
  Verificación observada por el padre: `cargo test -p infrastructure` → 29
  pasan, 0 fallan; `cargo fmt --all --check` → limpio (reporte del escritor:
  clippy limpio y `cargo test --workspace` todo verde). `serde_json` ya estaba
  en `workspace.dependencies`, solo se referenció desde
  `crates/infrastructure/Cargo.toml`.

- T3: ruta **delegada** (disparador de escritor: receptor + inyección en 2+
  archivos no triviales). Rama `feature/subagent-adapters-t3` (apilada sobre
  T2). `crates/infrastructure/src/hook_receiver.rs` (HTTP/1.1 a mano, sync,
  `127.0.0.1:0`, hilo por conexión con timeout 2 s, token uuid). Contrato para
  T4/T5: `POST /hook/<KnownAgent::id>`, `Authorization: Bearer <token>`,
  `X-OpenCollab-Terminal: <uuid>`, cuerpo crudo ≤ 1 MiB; 204 / 400 / 401 / 404
  / 405 / 413. Sink `Fn(RawSubagentEvent)`. Inyección en
  `LaunchTerminal::execute` vía builder `with_hook_endpoint(HookEndpoint)`:
  solo el perfil que va al PTY lleva las 3 variables (el token no se guarda en
  la sesión). `KnownAgent::from_id` agregado. TDD: RED observado (errores de
  compilación E0599/E0433/E0432 por APIs inexistentes) → GREEN. Verificación:
  escritor reportó fmt/clippy/test limpios; el padre re-corrió `cargo fmt
  --all --check` (limpio) y `cargo test --workspace` (application 40,
  infrastructure 38, 0 fallan). Commit `2452d1a`. RDD: riesgo `medium`
  (`slice_budget_reached`), consentido por el usuario, lente reliability →
  **aprobado** y acknowledged (`review-4b1093c29501c28a`, autoridad quemada).
  Hallazgos no bloqueantes, pendientes de decisión: R3-001 hilos por conexión
  sin límite ni join (el sink puede llamarse tras `shutdown`); R3-002 `Drop`
  puede colgarse si falla el self-connect; R3-003 faltan tests de cuerpo en
  varias lecturas, sin `Content-Length`, cuerpo corto y header de terminal
  ausente; R3-004 404/405 antes de 401 y `Bearer` sensible a mayúsculas.
- T3 (correcciones R3-001..003, autorizadas por el usuario): ruta **delegada**
  (un archivo no trivial con diseño de concurrencia). Solo
  `hook_receiver.rs` (+280/−30). R3-002: listener no bloqueante con sondeo de
  10 ms, sin self-connect. R3-001: tope de 32 conexiones (`503` inmediato al
  excederlo, guard `Slot`), compuerta `Mutex<bool>` que llama al sink bajo el
  lock: tras `shutdown` el sink nunca se invoca (los workers no se joinean
  para no reintroducir el cuelgue; terminan por timeout). R3-003: 8 tests
  nuevos; RED observado en `sink_is_never_called_after_shutdown_returns` y
  `connections_over_the_cap_get_503`, el resto verde al llegar (cubren
  comportamiento existente). Contrato HTTP sin cambios salvo `503`.
  Verificación: el padre re-corrió fmt check, clippy y `cargo test
  --workspace` (infrastructure 46, 0 fallan); el escritor corrió los tests del
  receptor 3 veces sin intermitencias. R3-004 queda pendiente. Commit
  `45038ef`; assess vs `103a88b`: `medium`, `under_budget` (pendiente en el
  corte). T2+T3 mergeados a `develop` por el usuario (`2ac32e6`).
- RDD del stop hook: compara contra `af87b898` (merge-base con `main`), así que
  su candidato es todo lo no liberado y da `lens_context_budget_exceeded`.
  Decisión del usuario: seguir revisando por commit con `assess --base-ref`
  hasta liberar al cerrar la feature.
- T4: ruta **delegada** (crate nuevo con lib, bin y tests de integración). Rama
  `feature/subagent-adapters-t4` desde `develop`. `apps/hook-relay` (bin
  `opencollab-hook`, ~424 líneas): solo depende de `application` en runtime
  (`infrastructure` es dev-dependency). `opencollab-hook <agent-id>`: lee stdin
  (≤ 1 MiB), las 3 variables `OPENCOLLAB_*`, y hace el POST del contrato de T3;
  solo acepta `http://127.0.0.1:<puerto>/...`, rechaza CR/LF en token y
  terminal, timeouts de 500 ms, sin salida y siempre exit 0. TDD: 7 unit tests
  RED (stubs `todo!()`) → GREEN; 8 tests de integración escritos después
  (contra `HookReceiver` real y el binario compilado; no pasaron por RED).
  Verificación: el padre re-corrió `cargo fmt --all --check` y `cargo test
  --workspace` (hook-relay 7+8, infrastructure 46, 0 fallan); escritor reportó
  clippy limpio. Commit `d5f80f1`. RDD del corte `103a88b..d5f80f1` (R3-fixes +
  T4, 801 líneas, `medium`): consentido, lente reliability → **aprobado** y
  acknowledged (`review-5ebec51754a82336`). Hallazgos no bloqueantes,
  pendientes de decisión (prefijo T4-): T4-001 `run_bin` hace unwrap del
  write a stdin y puede fallar por broken pipe (tests intermitentes); T4-002 el
  socket se cierra antes de liberar el `Slot` → falso 503 bajo el tope; T4-003
  el sink corre bajo el mutex (serializa y frena el shutdown si es lento);
  T4-004 el 503 sin leer el pedido puede llegar como reset; T4-005 sin test de
  receptor que acepta y no responde; T4-006 URL con path vacío aceptada.
  Último límite revisado: `d5f80f1`.
- T4-001/T4-002 (autorizados por el usuario): ruta **inline** (dos cambios
  chicos ya entendidos). T4-002: el `Slot` se pasa a `handle_connection` y se
  suelta antes de `respond`. Test nuevo
  `slot_is_free_once_the_client_sees_the_response` (200 pedidos con tope 1,
  verifica `active == 0` al recibir EOF): RED 3/3 corridas (`left: 1`) →
  GREEN 3/3. T4-001: `run_bin` ignora el error de escritura a stdin (sin RED
  determinista: es una carrera). Verificación del padre: fmt check, clippy
  limpio, `cargo test --workspace` (infrastructure 47, hook-relay 7+8, 0
  fallan). T4-003..006 siguen pendientes. Commit `d86c3b2`.
- 2026-10-05: el usuario **desactivó RDD** (`gentle-ai review mode disable`,
  global). Desde acá la entrega es `disabled/unmanaged`: sin revisiones, solo
  checks funcionales.
- T5: ruta **delegada** (puerto + 4 adaptadores). Rama
  `feature/subagent-adapters-t5` apilada sobre T4. `application/hooks.rs`
  (`HookStatus`, `InspectHookInstallation`, `Install/UninstallAgentHooks`,
  `AppError::NoHookInstaller`) y `infrastructure/hook_installers.rs` (Claude
  Code → `settings.json`, Codex → `hooks.json` con `async: true`, OpenCode →
  `plugins/opencollab.ts` con marcador `// opencollab-managed-plugin`,
  Antigravity → `Unsupported`). Propiedad por comando con `opencollab-hook`;
  idempotente, preserva lo ajeno, rechaza JSON mal formado sin tocarlo, backup
  `.opencollab.bak`, escritura atómica. `serde_json` con `preserve_order` para
  no reordenar las claves del usuario. Esquemas verificados: Claude
  (code.claude.com/docs/en/hooks), Codex (learn.chatgpt.com/docs/hooks:
  anidado y eventos; campos de stdin de subagente NO documentados), OpenCode
  (opencode.ai/docs/plugins: forma del plugin). **Supuestos a verificar en
  T8**: `session.created` trae `properties.info.{id,parentID}`; el `task`
  terminado trae el id hijo en `output.metadata.sessionId`; OpenCode nunca
  reporta error; Claude no trae `description` (sin etiqueta). TDD: RED
  application 5/5, infrastructure 25 de 32 (los 7 restantes cubren casos que
  no requieren implementación) → GREEN. Extra: el `.ts` generado se corrió en
  Node 24 contra un servidor local. Verificación del padre: fmt check y
  `cargo test --workspace` (application 45, infrastructure 79, 0 fallan);
  escritor reportó clippy limpio.

- T5 commit `b16b6bb`.
- T6: ruta **delegada** (wiring en varios archivos del desktop). Rama
  `feature/subagent-adapters-t6` apilada sobre T5. `src-tauri/src/subagents.rs`
  (DTOs camelCase, `apply_hook_event` y `forget_terminal` puros,
  `hook_binary_path`, decorador `RequireHookBinary`), `state.rs`
  (`AppState::bootstrap(&AppHandle)` en `setup`: hub con 3 traductores,
  `HookReceiver` cuyo sink emite `terminal-subagents`; si no arranca, las
  terminales se lanzan sin endpoint), `commands.rs` (`subagent_snapshot`,
  `hook_status`, `install_agent_hooks`, `uninstall_agent_hooks`; raíces reales
  desde `home_dir`), `subagentsApi.ts`, mock de Tauri, `AGENTS.md`.
  `opencollab-hook` se busca junto a `current_exe()`; **empaquetado
  (`externalBin`) pendiente para T8**. TDD: RED 11/11 (stubs `todo!()`) →
  GREEN 11/11, incluye integración receptor real + hub + sink. Sin Vitest
  (no hay lógica TS pura); ningún E2E usa todavía los comandos nuevos.
  Verificación del padre: fmt check, `cargo test --workspace` (desktop 11,
  infrastructure 79, 0 fallan), `pnpm test` 23; escritor: clippy, `pnpm
  build` y `pnpm test:e2e` en verde. No se corrió la app real.

- T7: ruta **delegada** (frontend completo: árbol de subagentes con estado en el
  sidebar, panel de instalación con confirmación, mock y escenario E2E). Rama
  `feature/subagent-adapters-t7`. Archivos: `apps/desktop/src/subagents.ts`
  (`buildSubagentTree` con soporte para raíces y anidamiento jerárquico),
  `apps/desktop/src/subagents.test.ts` (5 tests nuevos de Vitest),
  `apps/desktop/src/components/SettingsModal.tsx` (consulta de hooks, lista de
  los 4 agentes con badges, confirmación explícita antes de modificar disco con
  `installAgentHooks`/`uninstallAgentHooks`, feedback de resultado y atajos
  Escape/backdrop/✕), `apps/desktop/src/components/Sidebar.tsx` (renderizado de
  subagentes con `TerminalIcon`, etiquetas y puntos de estado; apertura de
  SettingsModal), `apps/desktop/src/App.tsx` (suscripción a `onTerminalSubagents`
  y cleanup en `removePane`), `apps/desktop/src/components/TerminalPane.tsx` y
  `apps/desktop/src/model.ts` (propagación de `terminalId` en `PaneMeta` para
  enlazar eventos con el hilo del sidebar), `apps/desktop/src/styles.css`
  (estilos de modal, badges de hooks, diálogo de confirmación y feedback),
  `apps/desktop/e2e/scenarios/subagents-and-hooks.mjs` y `apps/desktop/e2e/run.mjs`
  (escenario E2E con 16 verificaciones que cubren subagentes en vivo, anidamiento,
  foco por clic, apertura de Settings, badges, confirmación de instalación y
  desinstalación sin llamadas prematuras, y cierre).
  Verificación observada: `cargo fmt --all --check` limpio; `cargo clippy
  --workspace --all-targets -- -D warnings` limpio; `cargo test --workspace`
  (86 infrastructure + 11 desktop + 45 application + domain + protocol, 0 fallan);
  `pnpm test` (33 tests pasando en 4 archivos); `pnpm build` (typecheck y bundle
  Vite sin errores); `pnpm test:e2e` (los 6 escenarios pasando con código 0).
  Commit `2842692`.

## Siguiente paso

T8 — Verificación real y docs: probar con cada agente instalado (Claude Code,
OpenCode, Codex, Antigravity CLI), empaquetado del sidecar `opencollab-hook`
como `externalBin` en Tauri, y actualización de `AGENTS.md`.
