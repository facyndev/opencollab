# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, OpenCode, Codex, etc.) when working with code in this repository.

## Estado del proyecto

Scaffolding inicial. Implementado: modelo de dominio completo con permisos y tests, casos de uso de lanzar / escribir / redimensionar / cerrar terminal y cambiar permisos, adaptador PTY real, y app desktop con la UI de referencia (shells locales reales). Pendiente: cliente WebSocket (`CollabTransport` real), lógica del relay (hoy `/ws` es un stub), persistencia, autenticación, comandos del núcleo para workspaces/sesiones, UI de permisos e invitaciones, y lanzar agentes directamente como perfil (hoy cada terminal abre la shell por defecto y el agente se detecta cuando el usuario lo ejecuta ahí). La sesión del desktop es por ahora una sesión local fija creada en `apps/desktop/src-tauri/src/state.rs`.

## Producto

OpenCollab es una app desktop que centraliza agentes de IA de terminal (Claude Code, OpenCode, Codex, Gemini CLI o cualquier CLI). Permite abrir múltiples terminales dispuestas en una grilla para ver en paralelo qué hace cada agente.

El diferencial es la **colaboración en tiempo real**: un usuario puede sumar compañeros a un workspace o a una sesión puntual y todos ven sus terminales en vivo.

### Modelo de dominio: Workspace → Session → Terminal

- **Workspace:** contenedor de organización (por ejemplo, un proyecto). Tiene un dueño y agrupa sesiones.
- **Session:** grupo de **varias terminales** que se ven juntas en una grilla. Es la unidad que se comparte en vivo.
- **Terminal:** un PTY dentro de una sesión, que ejecuta un `AgentProfile` o una shell.

### Dos formas de colaborar: miembro del workspace vs. invitado de sesión

| | **Miembro del workspace** | **Invitado de sesión** |
|---|---|---|
| Para qué | Equipo estable del proyecto | Colaboración puntual |
| Duración | Permanente, hasta que el dueño lo quite | Temporal: vale solo para esa sesión |
| Alcance | Las sesiones del workspace | Únicamente la sesión a la que fue invitado; no ve el resto del workspace |
| Se invita desde | El workspace | La sesión |

Son conceptos distintos en el dominio (no modelar al invitado como un miembro con fecha de vencimiento, ni al miembro como invitado de todas las sesiones). Un miembro del workspace no necesita ser re-invitado a cada sesión nueva.

**Permiso base "Ver":**

- Al crearse una sesión, cada miembro del workspace tiene **Ver activo por defecto**. El dueño puede desactivarlo para un miembro en una sesión concreta.
- **Ver es el permiso mínimo para compartir:** un participante sin Ver no tiene acceso a la sesión (no recibe streams ni la ve listada). Cualquier permiso superior (por ejemplo, Escribir) requiere Ver; desactivar Ver quita también los superiores, y activar Escribir activa Ver.
- Se modela como un único nivel ordenado `AccessLevel { None < View < Write }` (`crates/domain/src/permission.rs`), no como flags independientes: así "Escribir sin Ver" es irrepresentable. `Session` resuelve el permiso efectivo de cada usuario (override de la sesión o `View` por defecto para miembros) y expone `can_view` / `can_write` como única fuente de verdad.
- Este invariante vive en `domain` (no en la UI ni en el relay) y debe estar cubierto por tests: un miembro nuevo arranca con Ver activo, no existe un estado con Escribir sin Ver, y quitar Ver revoca el acceso.
- La UI debe mostrar explícitamente que Ver viene activo por defecto y que es el mínimo para que la sesión esté compartida con esa persona (por ejemplo, el toggle de Ver marcado de entrada y un texto que lo indique al desactivarlo).

**Permisos en vivo:** los permisos (ver / escribir) de cualquier participante de una sesión, sea miembro o invitado, se pueden **modificar en cualquier momento mientras la sesión está activa**, y el cambio aplica en caliente a quien ya está conectado (quitarle la escritura corta su input de inmediato; revocar el acceso lo desconecta). No asumir que los permisos se fijan al unirse ni cachearlos por conexión: cada input entrante se valida contra el permiso vigente.

Evitar nombrar "sesión" a otra cosa (por ejemplo, la sesión de login o el PTY) para no confundir el concepto central.

Los agentes son **agnósticos**: el sistema no debe tener lógica específica de un agente en el dominio. Un agente es un perfil (comando, args, env, cwd) que se lanza dentro de un PTY.

## Stack

- **Desktop:** Tauri 2, backend en Rust (PTYs con `portable-pty`).
- **Frontend:** React + TypeScript, terminales con `xterm.js`.
- **Colaboración:** servidor relay propio en Rust sobre WebSockets (autenticación, sesiones compartidas, invitaciones y retransmisión de streams de PTY).
- **Monorepo:** Cargo workspace para todo el código Rust; el dominio y los casos de uso se comparten entre la app desktop y el relay.

## Arquitectura (Clean Architecture)

Regla de dependencias: las dependencias apuntan siempre hacia adentro. `domain` no depende de nada; `application` solo de `domain`; la infraestructura y los adaptadores implementan los puertos definidos en `application`.

Estructura:

```
crates/
  domain/          # Entidades y reglas puras: Workspace, Session, Terminal, WorkspaceMember, SessionGuest, Invitation, AgentProfile. Sin I/O, sin Tauri, sin tokio.
  application/     # Casos de uso + puertos (traits): PtyPort, WorkspaceRepository, CollabTransport, etc.
  protocol/        # Mensajes del wire (serde) compartidos entre desktop y relay. Versionados.
  infrastructure/  # Adaptadores concretos: portable-pty, persistencia, cliente WebSocket.
apps/
  desktop/
    src-tauri/     # Composition root de la app: wiring de dependencias + comandos/eventos Tauri (adaptadores de entrada delgados).
    src/           # Frontend React: grilla de terminales, xterm.js, UI de workspaces.
  relay/           # Servidor de colaboración: composition root + adaptadores WebSocket/HTTP sobre los mismos casos de uso.
```

Principios clave:

- Los comandos Tauri y los handlers del relay solo traducen entrada/salida y delegan en casos de uso; no contienen lógica de negocio.
- El frontend no conoce detalles de PTY ni del relay: habla con el backend vía comandos/eventos Tauri.
- Todo lo que cruza la red se define en `protocol`; desktop y relay nunca serializan tipos de dominio directamente.

### Flujos principales

- **Terminal local:** caso de uso lanza un `AgentProfile` vía `PtyPort` → la salida del PTY se emite como evento Tauri → el frontend la escribe en la instancia de xterm.js correspondiente. El input del usuario sigue el camino inverso.
- **Sesión compartida:** el host, además de emitir localmente, envía el stream de cada terminal de la sesión al relay vía `CollabTransport`; el relay lo retransmite solo a los miembros de esa sesión. Los permisos (quién puede ver / escribir en una terminal) se deciden en `application`, no en el transporte.
- **Cambio de permisos en vivo:** el dueño modifica el permiso de un miembro → caso de uso en `application` actualiza la sesión → se propaga por `protocol` al relay y a los clientes conectados (para que la UI refleje el nuevo estado) → desde ese momento el input del miembro se acepta o rechaza según el permiso nuevo. La validación final ocurre en la máquina del host antes de escribir en el PTY; el relay también filtra, pero no es la única barrera.

## Flujo de ramas: Git Flow

El repo se maneja con **Git Flow**:

- `main`: solo código liberado. Cada merge a `main` es una versión y se etiqueta (`vX.Y.Z`). Nunca se commitea directo.
- `develop`: rama de integración; de acá salen y acá vuelven las features.
- `feature/<nombre>`: sale de `develop`, vuelve a `develop`. Una por funcionalidad (p. ej. `feature/relay-websocket`).
- `release/<versión>`: sale de `develop` para preparar una versión (solo ajustes, versión y fixes); se mergea a `main` (con tag) **y** de vuelta a `develop`.
- `hotfix/<versión>`: sale de `main` para un arreglo urgente; se mergea a `main` (con tag) **y** a `develop`.

No trabajar ni commitear directo en `main` ni en `develop`: antes de cambiar código, crear o usar la rama `feature/*` (o `hotfix/*`) que corresponda.

Remoto: `origin` → https://github.com/facyndev/opencollab (licencia MIT).

## Versionado

**Versionado semántico** (`MAJOR.MINOR.PATCH`), con tag `vX.Y.Z` en `main` por cada versión liberada.

- `PATCH`: arreglos sin cambios de comportamiento visibles (lo típico de un `hotfix/*`).
- `MINOR`: funcionalidades nuevas compatibles.
- `MAJOR`: cambios incompatibles. Mientras estemos en `0.y.z` (antes de la 1.0), un cambio incompatible sube `MINOR`.

La versión de la app vive en **tres lugares que tienen que coincidir** (hoy `0.1.0`):

- `Cargo.toml` raíz → `[workspace.package] version` (todos los crates la heredan con `version.workspace = true`).
- `apps/desktop/package.json` → `version`.
- `apps/desktop/src-tauri/tauri.conf.json` → `version` (es la que muestra el instalador).

La versión se sube **solo** en la rama `release/*` o `hotfix/*`, como un commit propio, nunca dentro de una feature. El tag se crea sobre el merge a `main`.

`pwsh scripts/check-version.ps1` verifica que las tres coincidan (y con `-Tag vX.Y.Z`, que coincidan con el tag); el CI lo corre en cada push.

## CI/CD (GitHub Actions)

- **`.github/workflows/ci.yml`**: en cada push a las ramas de Git Flow y en cada PR, sobre `windows-latest`. Job `frontend`: Vitest → `pnpm build` (typecheck + Vite) → E2E de la interfaz. Job `rust` (usa el `dist/` del anterior, porque la app desktop lo embebe al compilar): `fmt --check` → clippy → `cargo test --workspace` → E2E de PTY real (`shell_integration_e2e`) → consistencia de versión.
- **`.github/workflows/release.yml`**: al pushear un tag `vX.Y.Z` (sobre `main`). Verifica tag = versión de la app, corre **todo el CI** (si falla no se construye nada), hace `pnpm tauri build` y `scripts/package-release.ps1`, y publica la release de GitHub. Tags con sufijo (`v1.0.0-beta.1`) salen como pre-release.
- **Releases: solo Windows** por ahora. Convención de nombre de todo build: **`<os>_<versión>.<extensión>`** → `windows_0.1.0.exe` (NSIS) y `windows_0.1.0.msi`. Junto a cada uno va `<archivo>.sha256` y un `SHA256SUMS.txt` con todos (formato de `sha256sum`, finales LF: con CRLF `sha256sum -c` falla). La tabla de descargas con los hashes queda en el cuerpo de la release.
- Para publicar una versión: `release/X.Y.Z` desde `develop` → subir la versión en las tres fuentes → merge a `main` → `git tag vX.Y.Z` → `git push origin vX.Y.Z` → merge de vuelta a `develop`.

El **protocolo de red** tiene su propia versión, independiente de la de la app: `PROTOCOL_VERSION` en `crates/protocol/src/lib.rs`. Se incrementa solo cuando cambia el formato de los mensajes de forma incompatible (desktop y relay rechazan mensajes de otra versión).

## Comandos

Rust (desde la raíz del repo):

- `cargo build --workspace`
- `cargo test --workspace`
- Test puntual: `cargo test -p domain removing_view_revokes_write_and_access` (el filtro es un substring del nombre; `cargo test -p <crate> -- --list` lista los tests)
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo fmt --all` (en CI: `cargo fmt --all --check`)

Desktop (desde `apps/desktop`, usa pnpm):

- `pnpm install`
- `cargo tauri dev`: levanta Vite en `localhost:1420` y abre la ventana.
- `pnpm build`: typecheck (`tsc --noEmit`) + build de Vite.
- `pnpm test`: tests unitarios del frontend (Vitest, archivos `src/**/*.test.ts`). Uno puntual: `pnpm test -- -t "parseOsc7"`.
- `pnpm test:e2e`: E2E de la interfaz sobre el build de producción (correr `pnpm build` antes). Levanta `vite preview` en el puerto 4173, abre Chrome headless (el del sistema, o `CHROME_PATH`) e inyecta un **núcleo de Tauri simulado** (`e2e/tauri-mock.js`) que responde los mismos comandos y eventos que el real. Escenarios en `e2e/scenarios/`; para sumar uno, registrarlo en `e2e/run.mjs`. Si cambia un comando o evento del núcleo, actualizar también el mock.
- `cargo tauri build`: instaladores en `target/release/bundle/{nsis,msi}`; `pwsh scripts/package-release.ps1 -Version X.Y.Z` los deja en `release/` con el nombre y los hashes de release.

Relay: `cargo run -p relay` (escucha en `127.0.0.1:8787`, configurable con `RELAY_ADDR`; expone `/health` y `/ws`).

### Particularidades

- En Windows, ConPTY envía una consulta de posición de cursor (`ESC[6n`) y retiene la salida hasta recibir respuesta. En la app la contesta xterm.js vía `onData` → `write_terminal`. Cualquier test o cliente que lea un PTY sin xterm debe responderla (ver el test de `crates/infrastructure/src/pty.rs`).
- **Detección de agentes:** el panel muestra qué agente corre en cada terminal (Claude Code, OpenCode, Codex, Antigravity CLI, Grok). No se parsea lo que el usuario escribe: `agent_watcher.rs` (desktop) llama cada 1 s a `DetectTerminalAgents`, que toma una foto de procesos (`ProcessInspector`, implementado con `sysinfo`) y recorre en anchura los descendientes de la shell de cada terminal. `detect_agents` devuelve un `AgentTree`: `primary` es el agente más cercano a la shell (el que lanzó el usuario, y el que muestra el ícono del panel) y `nested` son los agentes conocidos que ese tiene corriendo debajo, sin repetir. El sidebar los lista anidados bajo su terminal; el evento `terminal-agent` lleva la lista completa y solo se emite cuando cambia. El catálogo (`crates/application/src/agent_detection.rs`) reconoce por nombre de ejecutable (`claude`, `opencode`, `codex`, `agy`/`antigravity`, `grok`) o, si el proceso es `node`/`bun`/`deno`, por el paquete npm en los argumentos (`@openai/codex`, `@xai-official/grok`, etc.). Para sumar un agente: agregarlo al enum `KnownAgent` en Rust y al catálogo de `apps/desktop/src/agents.ts` con el mismo id.
  - Ojo con el nombre: son agentes **anidados**, no los subagentes internos de un agente. Claude Code, OpenCode y Codex corren sus subagentes (Task tool y similares) **dentro del mismo proceso**, así que no aparecen en el árbol de procesos y esta detección no los ve. Lo que sí aparece son otros CLIs que el agente lanza como herramienta. Los MCP servers son otro tema: son procesos hijos reales, pero hoy no se listan.
- **Info agnóstica bajo cada terminal del hilo** (`ThreadMeta.tsx`, línea secundaria): no depende de ningún agente.
  - **Actividad** (`working` / `idle` / `needs attention`): se infiere de la salida del PTY. `ActivityTracker` (`application/src/activity.rs`, puro, con instante inyectado) registra cuándo emitió bytes cada terminal (`TauriOutputSink::output`); `agent_watcher.rs` hace `tick` cada 1 s y emite `terminal-activity` (`{ terminalId, state }`) solo cuando cambia (sin salida por 3 s = `idle`). "Needs attention" es estado de UI (`src/activity.ts`, testeado): working -> idle con el panel sin foco, hasta que se enfoca. Solo se muestra si la terminal tiene un agente detectado. No distingue "terminó" de "pide aprobación": ambos significan "andá a mirar".
  - **Tiempo corriendo del agente**: `ProcessInspector` expone el arranque de cada proceso (`ProcessInfo.started_at`, de `sysinfo::Process::start_time`, segundos Unix; `None` si no se conoce) y `detect_agents` lo copia del proceso del agente principal a `AgentTree.primary_started_at`. El evento `terminal-agent` lleva `startedAt` (`null` sin agente). El frontend lo formatea con `src/duration.ts` (`45s`, `12m`, `1h 05m`) y se actualiza con un único temporizador compartido (`src/useNow.ts`) que solo re-renderiza el fragmento de uptime.
- **Directorio actual de cada terminal (shell integration):** la shell por defecto (`crates/infrastructure/src/shell.rs`) arranca PowerShell con `-NoExit -Command` envolviendo su `prompt` para emitir `OSC 7` (`ESC]7;file://localhost/C:/ruta ESC\`) antes de cada prompt; xterm lo lee (`registerOscHandler(7)`) y el header muestra la carpeta real en vivo. No se puede leer desde afuera porque PowerShell no cambia el cwd del proceso al hacer `cd`. Test real: `cargo test -p infrastructure --test shell_integration_e2e -- --ignored`. En Unix todavía no hay integración (solo se muestra la carpeta inicial).
- **Cambiador de ruta** (`CwdSwitcher.tsx`): menú con subcarpetas (adelante, vía `list_subdirectories` → `ListSubdirectories` → `DirectoryBrowser`), `..` y directorios padre (atrás). Navegar = escribirle un `cd` a la shell (`cdCommand` en `src/cwd.ts`, según la shell), así que se desactiva mientras corre un agente: el texto le llegaría al agente. El menú va en un portal con posición fija porque el panel tiene `overflow: hidden`, y se cierra con `resize`.
- **Nueva terminal desde otra** (`NewTerminalMenu.tsx`, botón `+` del header): abre otra al lado de la de origen, en su carpeta actual (la última que reportó OSC 7) o en la por defecto; `Ctrl/⌘+Shift+T` hace lo primero con la terminal enfocada. La carpeta viaja como `cwd` opcional de `open_shell` → `default_shell_profile(cwd)`, que cae al home si la carpeta ya no existe. Cada panel guarda su carpeta inicial en `Pane.initialCwd` y reporta la actual en `PaneMeta.cwd`.
- **`Panel`** (`components/Panel.tsx`): wrapper visual reutilizable (marco + barra de título + bloque interno oscuro con radio). Lo usan el panel de una terminal y la sesión del sidebar; cualquier contenedor nuevo con ese look debe usarlo en vez de copiar estilos. Se ajusta con variables CSS (`--panel-pad`, `--panel-bg`, `--panel-border`, `--panel-body-radius`) y `plain` lo deja sin marco.
- **Hilo de terminales en el sidebar:** cada sesión lista sus terminales en el orden de la grilla, con el mismo `TerminalIcon` que el header (logo del agente detectado o ícono de la shell). Cada panel reporta qué corre en él con `onMeta` hacia `App`. Clic en una terminal del hilo → va a su sesión y la enfoca.
- Logos de agentes: `apps/desktop/src/assets/agents/{claudecode,opencode,codex,antigravitycli,grok-xai}-logo.svg`. Se cargan con `import.meta.glob`, así que si falta uno el build no falla y el panel muestra un badge de texto. Se pintan como máscara CSS (`.pane-logo`: `mask` + `background-color: var(--text)`), no con `<img>`: el SVG solo aporta la forma y el color sale siempre del token, sin importar el `fill` del archivo.
- **Títulos de sesión de agentes en vivo (hooks):** el título de sesión de OpenCode (`info.title`) y el prompt inicial de Claude Code o Codex (`UserPromptSubmit`) llegan por hooks. `state.rs` arranca un `HookReceiver` (HTTP en `127.0.0.1`, puerto aleatorio, token) y `LaunchTerminal::with_hook_endpoint` inyecta en cada PTY `OPENCOLLAB_TERMINAL_ID`, `OPENCOLLAB_HOOK_URL` y `OPENCOLLAB_HOOK_TOKEN`. El hook (sidecar `opencollab-hook` o el plugin de OpenCode) hace `POST /hook/<agent-id>` con el payload crudo; el sink llama a `TrackAgentSessionTitle` y, si el título cambió, emite `terminal-agent-session` (`{ terminalId, title }`), mostrándose en el hilo del sidebar bajo la terminal. Al cerrar la terminal (✕ o `terminal-exit`) se descarta su título y se emite `title: null`. Comandos: `agent_session_title(terminalId)`, `hook_status()`, `install_agent_hooks(agent)` y `uninstall_agent_hooks(agent)`. Lado frontend: `src/agentHooksApi.ts` y eventos en `terminalApi.ts` (con su mock en `e2e/tauri-mock.js`).
- Test end-to-end de detección con los CLIs reales instalados: `cargo test -p infrastructure --test agent_detection_e2e -- --ignored --nocapture --test-threads=1` (está `#[ignore]` porque depende de la máquina).
- Cerrar una terminal mata el **árbol de procesos completo** por pid (`taskkill /T /F` en Windows, `kill -KILL -<pgid>` en Unix), para que el agente que corre dentro de la shell no quede huérfano. No usar `ChildKiller::kill` de portable-pty: en Windows falla con "handle inválido" (os error 6) o devuelve un falso error con código 0.
- El frontend no usa `React.StrictMode`: su doble montaje en dev abriría un PTY extra por terminal (un panel solo cierra su PTY con el botón ✕ → `close_terminal`, no al desmontarse).
- **Salir desde la shell** (`exit` o cualquier forma de terminar el proceso): el núcleo emite `terminal-exit` y el panel sigue el mismo camino que el ✕ (`close_terminal` + se quita de la grilla). `close` es idempotente porque el ✕ también dispara `terminal-exit` al matar el PTY. E2E: `e2e/scenarios/exit-closes-pane.mjs`.
- Frontend: los workspaces y las sesiones del sidebar son por ahora estado de UI (`apps/desktop/src/model.ts`), porque el núcleo todavía no expone comandos para ellos; todas las terminales corren dentro de la única sesión del núcleo. Las terminales de sesiones no activas quedan montadas y ocultas (atributo `hidden`) para no perder sus PTY; xterm solo hace `fit()` si su contenedor tiene tamaño. Al agregar comandos de workspaces/sesiones en el núcleo, reemplazar ese estado local en lugar de duplicarlo.
- **Arrastrar paneles** (`apps/desktop/src/usePaneDrag.ts`): se arrastran por el header y se intercambian en vivo con el panel que está bajo el puntero, con animación FLIP. Regla clave: **nunca reordenar el DOM de los paneles** (mover el nodo de una xterm puede resetear su scroll/estado). El DOM se renderiza siempre por `Pane.seq` (orden de creación) y la posición visual sale del orden de `Session.panes` aplicado con la propiedad CSS `order`. El hit-testing usa `offsetLeft/Top` (posición de layout, sin transforms) para no oscilar mientras los demás paneles se animan. El arrastre se desactiva con un solo panel visible (maximizado o layout single).
- Íconos: los de UI genéricos vienen de `react-icons` (set Codicons, `react-icons/vsc`): `VscTerminal` en el contador de terminales de cada sesión, y en el header del panel el ícono de la shell (`VscTerminalPowershell`, `VscTerminalCmd`, `VscTerminalBash` o `VscTerminal`) cuando no corre un agente conocido. Los trazos simples propios están en `src/icons.tsx`; SVGs propios del proyecto en `src/assets/opencollab/` (pintados como máscara CSS para heredar el color del texto).
- Tipografía: **Google Sans**, empaquetada con la app vía `@fontsource-variable/google-sans` (funciona sin conexión; pesos 400–700). Se usa por el token `--font`; el código monoespaciado sigue con `--mono`.
- Diseño de referencia: tema oscuro, tipografía Google Sans, acento violeta (`--accent: #7c5cff`), sidebar (selector de workspace, búsqueda, sesiones, usuario), topbar (breadcrumb, Invite, layouts grid/columns/single, New terminal), paneles con header (badge, nombre, cwd, estado, controles) y status bar con atajos (`Ctrl/⌘+T`, `+1-4`, `+Shift+M`, `+K`).
