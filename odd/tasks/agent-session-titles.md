> Status: superseded/removed on 2026-10-05 by agent-status-info T5 (agent-specific signals are not universal). Kept as history only.

# Títulos de sesión de agentes en el Sidebar vía hooks

## Objetivo

Mostrar en el hilo del sidebar, bajo cada terminal, el título de la sesión o prompt inicial que el agente está trabajando (OpenCode: `session.title`; Claude Code / Codex: prompt inicial del usuario), descartando el seguimiento de árboles de subagentes internos.

## Problema

El panel y el sidebar hoy solo muestran el nombre estático del agente o shell ("Claude Code", "OpenCode", etc.). El usuario necesita ver el contexto/tema de la sesión activa en el hilo del sidebar para saber de qué trata cada terminal sin tener que enfocarla.

## Por qué así

Reutilizamos el canal de hooks existente (`HookReceiver` HTTP local + sidecar `opencollab-hook` + plugin de OpenCode):
- Claude Code y Codex envían su evento de inicio / prompt de usuario (`UserPromptSubmit`).
- OpenCode emite `session.created` y `session.updated` con `info.title`.
- Se retira el rastreo complejo de subagentes anidados (`SubagentTree`, `SubagentStart`/`Stop`), simplificando el dominio a un estado plano: qué título de sesión tiene cada terminal.

## Arquitectura

- `application`:
  - Modelo `TerminalAgentSession { terminal_id, agent, title }`.
  - Puerto `SessionTitleTranslator`: traduce eventos crudos de hook a un título de sesión.
  - Caso de uso `TrackAgentSessionTitle`: actualiza el título vigente por terminal.
- `infrastructure`:
  - `session_title_translators.rs` para Claude Code, OpenCode y Codex.
  - `hook_installers.rs`: instala hooks de prompts/títulos en vez de eventos de subagentes.
- `apps/desktop`:
  - `src-tauri`: emisión de `terminal-agent-session` hacia el frontend.
  - `src/components/Sidebar.tsx`: muestra el título de la sesión bajo la terminal en el hilo.

## Restricciones

- Sin residuos de la lógica anterior de subagentes (`SubagentTree`, `SubagentStart/Stop`).
- Tests en Rust y Frontend verificados.
- TDD estricto y Git Flow.

## Tareas

- [x] **T1 — Limpieza de subagentes y modelo de títulos de sesión en `application`.** Retirar `subagents.rs` y crear `agent_session.rs` con caso de uso y tests.
- [x] **T2 — Traductores e instaladores en `infrastructure`.** Traductores para Claude, OpenCode y Codex + actualización de hooks instalados.
- [x] **T3 — Wiring en Desktop (Tauri).** Estado, comandos y eventos para títulos de sesión.
- [x] **T4 — Frontend e integración en Sidebar.** Hilo con título en `Sidebar.tsx`, limpieza de subagentes en frontend y tests.

## Verificación

```
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd apps/desktop && pnpm test && pnpm build && pnpm test:e2e
```
