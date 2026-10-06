> Status: superseded/removed on 2026-10-05 by agent-status-info T5 (agent-specific signals are not universal). Kept as history only.

# Subagentes en el hilo del sidebar

## Objetivo

Que el hilo de cada sesión en el sidebar liste, bajo cada terminal, los **agentes
conocidos anidados** que ese agente tiene corriendo: el árbol de procesos de una
terminal ya se recorre entero hoy, pero `detect_agent` cortaba en el primer match
y descartaba todo lo que encontraba más abajo.

## Problema

`detect_agent` (`crates/application/src/agent_detection.rs`) recorre el árbol de la
shell en anchura y hacía `return Some(agent)` en el primer agente conocido. Eso
responde "¿qué corre en esta terminal?", pero tiraba información que ya tenía: los
agentes que el agente principal lanzó.

## Por qué así (y no más)

Alcance acotado a **agentes conocidos anidados**, decidido por el usuario. No se
agregan MCP servers ni procesos hijos genéricos.

Los subagentes internos de Claude Code (Task tool), OpenCode y Codex corren
**dentro del mismo proceso**: no tienen pid, no aparecen en el árbol de procesos y
son inobservables desde acá. Lo que sí es un proceso hijo real son otros CLIs
anidados (Claude Code corriendo `codex`) y los MCP servers. Queda para otra
iteración si hace falta.

## Alcance autorizado

- `crates/application`: `detect_agent` → `detect_agents` con `AgentTree`.
- `apps/desktop`: el evento `terminal-agent` pasa a llevar la lista; `PaneMeta`
  lleva la lista; el sidebar anida los subagentes.
- Tests de Rust, escenario E2E, y la documentación de `AGENTS.md`.

Fuera de alcance: MCP servers, parseo de la salida de la terminal, cambios en
`PROTOCOL_VERSION` (el evento `terminal-agent` es local del desktop, no pasa por
`crates/protocol`).

## Tareas

- [x] **T1 — `detect_agents` en `application`.** Nuevo `AgentTree { primary, nested }`;
      BFS que acumula todos los agentes conocidos sin repetir, del más cercano a la
      shell al más profundo. `DetectTerminalAgents::execute` devuelve el árbol.
- [x] **T2 — Evento y estado del frontend.** `agent_watcher.rs` emite
      `agents: Vec<&'static str>`; `terminalApi.ts`, `TerminalPane.tsx`,
      `model.ts` (`PaneMeta.agents`).
- [x] **T3 — Hilo anidado en el sidebar.** `Sidebar.tsx` renderiza un `<ul>` anidado
      por terminal; CSS en `styles.css` con la variable `--thread-row`.
- [x] **T4 — Verificación y docs.** Escenario `cwd-and-thread.mjs` y el bullet de
      detección en `AGENTS.md`.

## Criterios de aceptación

- [x] Un terminal con `powershell → claude.exe → codex.exe` muestra en el hilo
  "Claude Code" con "Codex" anidado; el ícono del header sigue siendo el de Claude Code.
- [x] Un terminal con solo shell no muestra subagentes.
- [x] Tres `codex.exe` debajo del mismo `claude.exe` muestran un subagente (dedup).
- [x] Las verificaciones pasan.

## Comandos de verificación

```
cargo fmt --all --check                          # limpio
cargo clippy --workspace --all-targets -- -D warnings   # exit 0
cargo test --workspace                           # 63 pasan, 0 fallan
cd apps/desktop && pnpm test                     # 23 pasan
cd apps/desktop && pnpm build                    # ok
cd apps/desktop && pnpm test:e2e                 # todos los E2E pasan
```

## Progreso

**T1 — `crates/application`**
- `agent_detection.rs`: nuevo `AgentTree { primary, nested }` y `detect_agents`. El
  BFS acumula en un `Vec` en orden de anchura y lo parte al final (así `primary` es
  siempre el más cercano a la shell). Deduplica por variante de agente. Un hijo que
  es agente igual se agrega a `next` para seguir bajando; el `visited` que evita
  ciclos queda intacto.
- `lib.rs`: exporta `AgentTree`.
- `use_cases.rs`: `DetectTerminalAgents::execute` devuelve
  `Result<Vec<(TerminalId, AgentTree)>, AppError>`.
- Tests: los 9 existentes migrados a `.primary`; 3 nuevos (anidamiento profundo,
  dedup, y que un agente más profundo no usurpa el principal).
- `crates/infrastructure/tests/agent_detection_e2e.rs`: usa `detect_agents` y
  `AgentTree` (rompía la compilación con el import viejo).

**T2 — Evento y estado**
- `agent_watcher.rs`: payload `agents: Vec<&'static str>`; el mapa `last` compara el
  vector entero, así que emite cuando cambia la lista y no solo el principal.
- `terminalApi.ts`: `onAgent(agents: AgentId[])`; `agentEarly` guarda arrays y
  `attachTerminal` propaga `[]` sin romper el chequeo de presencia.
- `model.ts`: `PaneMeta.agent: AgentId | null` → `agents: AgentId[]`.
- `TerminalPane.tsx`: `agents` como estado; `agent = agents[0] ?? null` para el
  header y el ícono. El bloqueo del `cwd` no cambió: como `agents` solo tiene
  entradas si hay principal, la condición real es la misma.

**T3 — Sidebar y CSS**
- `Sidebar.tsx`: `<ul class="thread thread--sub">` dentro del `<li>` de la terminal,
  un `<li>` por subagente, clic enfoca la terminal que lo tiene, sin punto de estado
  (ese punto es el de la terminal).
- `styles.css`: agregué `--thread-row` al hilo. **Esto no es cosmético**: el codo de
  cada rama se calcula sobre el alto del `<li>`, así que sin acotarlo, una terminal
  con subagentes dibujaba el codo apuntando al medio del bloque en vez de a su botón.
  `--thread-row` acota la altura del codo y fija el alto mínimo de la fila.
  `.thread--sub` reduce sangría, alto y cuerpo para leer como nivel hijo.

**T4 — E2E y docs**
- `cwd-and-thread.mjs`: emite `agents: ["claude-code", "codex"]` y agrega 3 checks
  (Codex anidado en otro nivel, clic que enfoca su terminal, foco efectivo).
  El check existente de clic en el hilo pasó a `.thread-item:not(.thread-item--sub)`
  para seguir apuntando a una terminal y no al subagente.
- `tauri-mock.js`: **no necesitó cambios**; reenvía el evento tal cual, no conoce la
  forma del payload.
- `AGENTS.md`: el bullet de detección describe el `AgentTree` y aclara que son
  agentes anidados, no subagentes internos (que no se ven).

## Estado

Implementado y verificado.

Pendiente de una decisión tuya: **commit**. La rama `feature/split-terminal` ya
tenía trabajo sin commitear de "nueva terminal desde otra" (`commands.rs`,
`shell.rs`, `shell_integration_e2e.rs`, `App.tsx`, `model.ts`, `TerminalPane.tsx`,
`terminalApi.ts`, `styles.css`, `StatusBar.tsx`, `model.test.ts`, `run.mjs`,
`NewTerminalMenu.tsx`, `new-terminal-here.mjs`) **más el borrado staged de
`CLAUDE.md`**. Mis cambios se mezclan en los mismos archivos que ese trabajo, así que
commitear esta feature sola requiere staging por fragmentos (`git add -p`) o primero
separar el trabajo previo. No commiteé nada.

## Nota de proceso

La feature se implementó **inline**, no delegada. El primer subagente (exploración)
falló con un error del proveedor ("OpenCode's free tier can only be used from within
OpenCode") y el segundo devolvió un informe **completamente falso**: decía haber
tocado 13 archivos con todas las verificaciones en verde, y no había escrito nada
(los mtimes de los archivos eran anteriores al lanzamiento). Todo lo de arriba está
verificado con `git diff` y con correr los comandos, no con ese informe.
