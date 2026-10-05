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

- [ ] **T1 — Modelo y hub en `application`.** `SubagentEvent`, `SubagentTree`,
      puerto `SubagentEventTranslator`, caso de uso `TrackSubagents` con tests
      (inicio, fin, error, anidamiento por `parent_id`, terminal cerrada).
- [x] **T2 — Traductores en `infrastructure`.** Claude Code, OpenCode, Codex,
      con fixtures de payloads documentados.
- [ ] **T3 — Receptor HTTP local + inyección de entorno en el PTY.**
- [ ] **T4 — Sidecar `opencollab-hook`.**
- [ ] **T5 — Instaladores** (puerto `HookInstaller` + 4 adaptadores) con tests
      sobre directorios temporales (merge sin pisar, idempotencia, uninstall).
- [ ] **T6 — Wiring en desktop**: hub, evento `terminal-subagents`, comandos de
      estado/instalación.
- [ ] **T7 — Frontend**: árbol de subagentes con estado en el sidebar, panel de
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

## Siguiente paso

T3 (receptor HTTP local + inyección de entorno en el PTY). Nota para T5: los
formatos OpenCode son contrato propio del futuro plugin `opencollab.ts`; si el
JSON real de Claude/Codex difiere, mapearlo en los traductores sin tocar
`application`.
