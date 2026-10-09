# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, OpenCode, Codex, etc.) when working with code in this repository.

## Estado del proyecto

Scaffolding inicial. Implementado: modelo de dominio completo con permisos y tests, casos de uso de lanzar / escribir / redimensionar / cerrar terminal y cambiar permisos, adaptador PTY real, y app desktop con la UI de referencia (shells locales reales), con agentes que se lanzan como perfil desde el menú `+` (corren dentro de la shell) y estado de agente como `AgentEvent`s. Login del desktop vía la web (PKCE + deep link). Pendiente: cliente WebSocket (`CollabTransport` real), lógica del server (hoy `/ws` en NestJS autentica el upgrade con el access JWT, enruta por sesión con `join_session` y filtra por el permiso vigente), persistencia, comandos del núcleo para workspaces/sesiones, UI de permisos e invitaciones, y los adaptadores ricos por agente (Claude Code, OpenCode: hoy solo rige el genérico). La sesión del desktop es por ahora una sesión local fija creada en `packages/desktop/src-tauri/src/state.rs`.

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
- **Colaboración:** servidor relay en NestJS sobre WebSockets (autenticación, sesiones compartidas, invitaciones y retransmisión de streams de PTY).
- **Web:** Vite + React + TypeScript (`packages/web`), puerta de autenticación del navegador; mismo toolchain que el desktop.
- **Monorepo:** Cargo workspace para el core Rust del desktop + paquetes pnpm para el server Nest y los frontends; desktop y server comparten el wire como contrato versionado, no como código.

## Arquitectura (Clean Architecture)

Regla de dependencias: las dependencias apuntan siempre hacia adentro. `domain` no depende de nada; `application` solo de `domain`; la infraestructura y los adaptadores implementan los puertos definidos en `application`.

Estructura:

```
crates/
  domain/          # Entidades y reglas puras: Workspace, Session, Terminal, WorkspaceMember, SessionGuest, Invitation, AgentProfile. Sin I/O, sin Tauri, sin tokio.
  application/     # Casos de uso + puertos (traits): PtyPort, WorkspaceRepository, CollabTransport, etc.
  protocol/        # Mensajes del wire (serde) compartidos entre desktop y relay. Versionados.
  infrastructure/  # Adaptadores concretos: portable-pty, persistencia, cliente WebSocket.
packages/
  desktop/
    src-tauri/     # Composition root de la app: wiring de dependencias + comandos/eventos Tauri (adaptadores de entrada delgados).
    src/           # Frontend React: grilla de terminales, xterm.js, UI de workspaces.
  server/          # Servidor NestJS: auth, sesiones compartidas, invitaciones y fan-out WebSocket (paridad de wire con protocol/).
  web/             # Web React: login, registro, cuenta y entrega de sesión al desktop. Habla solo con /auth del server (mismo origen).
```

Principios clave:

- Los comandos Tauri solo traducen entrada/salida y delegan en casos de uso; no contienen lógica de negocio. Los handlers del server Nest traducen el wire y obedecen las reglas del dominio (definidas en Rust).
- El frontend no conoce detalles de PTY ni del relay: habla con el backend vía comandos/eventos Tauri.
- Todo lo que cruza la red se define en `protocol`; desktop y server nunca serializan tipos de dominio directamente.

### Flujos principales

- **Terminal local:** caso de uso lanza un `AgentProfile` vía `PtyPort` → la salida del PTY se emite como evento Tauri → el frontend la escribe en la instancia de xterm.js correspondiente. El input del usuario sigue el camino inverso.
- **Sesión compartida:** el host, además de emitir localmente, envía el stream de cada terminal de la sesión al relay vía `CollabTransport`; el relay lo retransmite solo a los miembros de esa sesión. Los permisos (quién puede ver / escribir en una terminal) se deciden en `application`, no en el transporte.
- **Cambio de permisos en vivo:** el dueño modifica el permiso de un miembro → caso de uso en `application` actualiza la sesión → se propaga por `protocol` al relay y a los clientes conectados (para que la UI refleje el nuevo estado) → desde ese momento el input del miembro se acepta o rechaza según el permiso nuevo. La validación final ocurre en la máquina del host antes de escribir en el PTY; el relay también filtra, pero no es la única barrera.

## Flujo de ramas: Git Flow

El repo se maneja con **Git Flow**:

- `main`: solo código liberado. Cada merge a `main` es una versión y se etiqueta (`vX.Y.Z` para el desktop, `server-vX.Y.Z` / `web-vX.Y.Z` para los otros paquetes, ver "Versionado"). Nunca se commitea directo.
- `develop`: rama de integración; de acá salen y acá vuelven las features.
- `feature/<nombre>`: sale de `develop`, vuelve a `develop`. Una por funcionalidad (p. ej. `feature/relay-websocket`).
- `release/<versión>`: sale de `develop` para preparar una versión (solo ajustes, versión y fixes); se mergea a `main` (con tag) **y** de vuelta a `develop`. Una por paquete: `release/X.Y.Z` (desktop), `release/server-X.Y.Z`, `release/web-X.Y.Z`.
- `hotfix/<versión>`: sale de `main` para un arreglo urgente; se mergea a `main` (con tag) **y** a `develop`. Mismo esquema de nombres: `hotfix/X.Y.Z`, `hotfix/server-X.Y.Z`, `hotfix/web-X.Y.Z`.

No trabajar ni commitear directo en `main` ni en `develop`: antes de cambiar código, crear o usar la rama `feature/*` (o `hotfix/*`) que corresponda.

Remoto: `origin` → https://github.com/facyndev/opencollab (licencia MIT).

## Versionado

**Versionado semántico** (`MAJOR.MINOR.PATCH`) **por paquete**: desktop, server y web evolucionan a su ritmo y cada uno tiene su propia versión y su propio tag en `main`.

- `PATCH`: arreglos sin cambios de comportamiento visibles (lo típico de un `hotfix/*`).
- `MINOR`: funcionalidades nuevas compatibles.
- `MAJOR`: cambios incompatibles. Mientras un paquete esté en `0.y.z` (antes de la 1.0), un cambio incompatible sube `MINOR`.

| Paquete | Dónde vive la versión | Tag | Qué dispara el tag |
|---|---|---|---|
| **desktop** (app Tauri) | Tres fuentes que tienen que coincidir: `Cargo.toml` raíz (`[workspace.package] version`, los crates la heredan con `version.workspace = true`), `packages/desktop/package.json` y `packages/desktop/src-tauri/tauri.conf.json` (la que muestra el instalador) | `vX.Y.Z` (sin prefijo) | `release.yml`: CI completo, build de Tauri y release de GitHub |
| **server** (relay NestJS) | `packages/server/package.json` | `server-vX.Y.Z` | Nada por ahora (sin release de GitHub) |
| **web** | `packages/web/package.json` | `web-vX.Y.Z` | Nada por ahora (sin release de GitHub); el paquete aún no existe en el repo |

Solo el desktop genera releases de GitHub: `release.yml` escucha `v*.*.*` y los tags `server-v*` / `web-v*` no lo disparan.

La versión de un paquete se sube **solo** en la rama `release/*` o `hotfix/*` de ese paquete, como un commit propio, nunca dentro de una feature. El tag se crea sobre el merge a `main`.

`pwsh scripts/check-version.ps1 -Package desktop|server|web` verifica las fuentes del paquete (por defecto `desktop`) y, con `-Tag <tag>`, que el tag tenga el formato de la tabla y sea esa versión. El CI chequea desktop siempre; server y web, solo si existe su `package.json` (si no, lo informa en el log y lo saltea). Invocado a mano con un paquete inexistente, el script falla con un mensaje claro.

El **protocolo de red** tiene su propia versión, independiente de las tres: `PROTOCOL_VERSION` en `crates/protocol/src/lib.rs`. Se incrementa solo cuando cambia el formato de los mensajes de forma incompatible (desktop y relay rechazan mensajes de otra versión).

## CI/CD (GitHub Actions)

- **`.github/workflows/ci.yml`**: en cada push a las ramas de Git Flow y en cada PR, sobre `windows-latest`. Job `frontend`: Vitest → `pnpm build` (typecheck + Vite) → E2E de la interfaz. Job `rust` (usa el `dist/` del anterior, porque la app desktop lo embebe al compilar): `fmt --check` → clippy → `cargo test --workspace` → E2E de PTY real (`shell_integration_e2e`) → consistencia de versión (desktop; server y web si existen). Job `server`: Vitest + typecheck + build del relay Nest.
- **`.github/workflows/release.yml`**: al pushear un tag `vX.Y.Z` del desktop (sobre `main`; `server-v*` y `web-v*` no lo disparan). Verifica tag = versión del desktop (`check-version.ps1 -Package desktop`), corre **todo el CI** (si falla no se construye nada), hace `pnpm tauri build` y `scripts/package-release.ps1`, y publica la release de GitHub. Tags con sufijo (`v1.0.0-beta.1`) salen como pre-release.
- **Releases: solo Windows** por ahora. Convención de nombre de todo build: **`opencollab-<os>-<versión>.<extensión>`** → `opencollab-windows-0.2.0.exe` (NSIS) y `opencollab-windows-0.2.0.msi`. Junto a cada uno va `<archivo>.sha256` y un `SHA256SUMS.txt` con todos (formato de `sha256sum`, finales LF: con CRLF `sha256sum -c` falla). La tabla de descargas con los hashes queda en el cuerpo de la release.
- Para publicar una versión del **desktop**: `release/X.Y.Z` desde `develop` → subir la versión en las tres fuentes → merge a `main` → `git tag vX.Y.Z` → `git push origin vX.Y.Z` → merge de vuelta a `develop`.
- Para versionar el **server** (o la **web**, igual con `web-`): `release/server-X.Y.Z` desde `develop` → subir la versión en `packages/server/package.json` → merge a `main` → `git tag server-vX.Y.Z` → `git push origin server-vX.Y.Z` → merge de vuelta a `develop`. No genera release de GitHub.

## Comandos

Rust (desde la raíz del repo):

- `cargo build --workspace`
- `cargo test --workspace`
- Test puntual: `cargo test -p domain removing_view_revokes_write_and_access` (el filtro es un substring del nombre; `cargo test -p <crate> -- --list` lista los tests)
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo fmt --all` (en CI: `cargo fmt --all --check`)

Desktop (desde `packages/desktop`, usa pnpm):

- `pnpm install`
- `cargo tauri dev`: levanta Vite en `localhost:1420` y abre la ventana.
- `pnpm build`: typecheck (`tsc --noEmit`) + build de Vite.
- `pnpm test`: tests unitarios del frontend (Vitest, archivos `src/**/*.test.ts`). Uno puntual: `pnpm test -- -t "parseOsc7"`.
- `pnpm test:e2e`: E2E de la interfaz sobre el build de producción (correr `pnpm build` antes). Levanta `vite preview` en el puerto 4173, abre Chrome headless (el del sistema, o `CHROME_PATH`) e inyecta un **núcleo de Tauri simulado** (`e2e/tauri-mock.js`) que responde los mismos comandos y eventos que el real. Escenarios en `e2e/scenarios/`; para sumar uno, registrarlo en `e2e/run.mjs`. Si cambia un comando o evento del núcleo, actualizar también el mock.
- `cargo tauri build`: instaladores en `target/release/bundle/{nsis,msi}`; `pwsh scripts/package-release.ps1 -Version X.Y.Z` los deja en `release/` con el nombre y los hashes de release.

Server: corre solo en Docker (ver abajo; no hay `.env` para correrlo suelto). Escucha en `127.0.0.1:8787` (dentro del contenedor, `RELAY_ADDR=0.0.0.0:8787`); expone `/health` y `/ws`; el cliente WS manda `Sec-WebSocket-Protocol: opencollab.v1, bearer.<access JWT>` y sin token válido se rechaza el upgrade con 401. Tests: `pnpm --dir packages/server test` (Vitest).

Web: `pnpm --dir packages/web dev` (puerto 1421, hace proxy de `/auth` al server en `127.0.0.1:8787`, o a `OPENCOLLAB_API`), `pnpm --dir packages/web test` (Vitest + Testing Library), `pnpm --dir packages/web build` (typecheck + Vite).

Docker (server + web + Postgres; el desktop **no** va en contenedor: se instala la release y corre nativo contra este server):

- `cp .env.example .env`, completar `JWT_SECRET` (32+ caracteres: `openssl rand -base64 48`) y las credenciales OAuth de **GitHub y Google** (`GITHUB_CLIENT_ID`/`_SECRET`, `GOOGLE_CLIENT_ID`/`_SECRET`; callback a registrar en cada proveedor: `<PUBLIC_BASE_URL>/auth/oauth/<github|google>/callback`), y `docker compose up -d --build`. El `.env` raíz está ignorado. Todas son obligatorias: si falta alguna, el contenedor del server sale al arrancar (`docker compose logs server` dice cuál). Las migraciones de Prisma se aplican al iniciar el contenedor del server (`prisma migrate deploy`).
- Puertos, todos solo en `127.0.0.1`: web `8080` (nginx: SPA con fallback a `index.html`, proxy de `/auth` y `/ws` al server, misma CSP que `vite preview`), server `8787` (`/health`, `/auth/desktop/token`; el desktop habla directo con él), Postgres `5432`.
- El server corre con `TRUST_PROXY=1` (nginx es un salto) y `WEB_ORIGIN`/`PUBLIC_BASE_URL` = `http://localhost:8080`: los callbacks de OAuth pasan por la web.
- Apuntar el desktop a la web del contenedor: `OPENCOLLAB_WEB_ORIGIN=http://localhost:8080` (la dirección del server por defecto, `127.0.0.1:8787`, ya coincide).
- `docker compose up -d postgres` levanta solo la base para los tests de integración del server: `DATABASE_URL=postgresql://opencollab:opencollab@127.0.0.1:5432/opencollab pnpm --dir packages/server test:integration` (usan la base `opencollab_test`, nunca la de desarrollo).
- La CSP vive en dos lugares (`CSP` en `packages/web/vite.config.ts` y `packages/web/nginx.conf`); `packages/web/src/nginx.test.ts` falla si divergen.

### Particularidades

- En Windows, ConPTY envía una consulta de posición de cursor (`ESC[6n`) y retiene la salida hasta recibir respuesta. En la app la contesta xterm.js vía `onData` → `write_terminal`. Cualquier test o cliente que lea un PTY sin xterm debe responderla (ver el test de `crates/infrastructure/src/pty.rs`).
- **Detección de agentes:** el panel muestra qué agente corre en cada terminal (Claude Code, OpenCode, Codex, Antigravity CLI, Grok). No se parsea lo que el usuario escribe: `agent_watcher.rs` (desktop) llama cada 1 s a `DetectTerminalAgents`, que toma una foto de procesos (`ProcessInspector`, implementado con `sysinfo`) y recorre en anchura los descendientes de la shell de cada terminal. `detect_agents` devuelve un `AgentTree`: `primary` es el agente más cercano a la shell (el que lanzó el usuario, y el que muestra el ícono del panel) y `nested` son los agentes conocidos que ese tiene corriendo debajo, sin repetir. El recorrido **se detiene en otra instancia de OpenCollab** (proceso con el mismo nombre de ejecutable que la app, tomado de `current_exe()` en el composition root y pasado con `DetectTerminalAgents::stopping_at`; sin distinguir mayúsculas ni `.exe`): esa instancia aloja sus propias terminales, así que sus agentes no se cuentan como anidados del agente que la lanzó (p. ej. Claude Code corriendo `cargo tauri dev`). El sidebar **no lista los anidados**: cada terminal muestra solo su agente principal; el evento `terminal-agent` igual lleva la lista completa (principal + anidados) y solo se emite cuando cambia. El catálogo (`crates/application/src/agent_detection.rs`) reconoce por nombre de ejecutable (`claude`, `opencode`, `codex`, `agy`/`antigravity`, `grok`) o, si el proceso es `node`/`bun`/`deno`, por el paquete npm en los argumentos (`@openai/codex`, `@xai-official/grok`, etc.). Para sumar un agente: agregarlo al enum `KnownAgent` en Rust y al catálogo de `packages/desktop/src/agents.ts` con el mismo id.
  - Ojo con el nombre: son agentes **anidados**, no los subagentes internos de un agente. Claude Code, OpenCode y Codex corren sus subagentes (Task tool y similares) **dentro del mismo proceso**, así que no aparecen en el árbol de procesos y esta detección no los ve. Lo que sí aparece son otros CLIs que el agente lanza como herramienta. Los MCP servers son otro tema: son procesos hijos reales, pero hoy no se listan.
- **Info agnóstica en cada terminal del hilo** (`ThreadMeta.tsx`): no depende de ningún agente. El **estado** (`ThreadState`) va junto al título (`Claude Code · Working`, con el color/ícono del tono de `describeAgent`) y reemplaza al punto cuando hay un agente con estado conocido; sin agente queda el punto. La línea secundaria (`ThreadMeta`) lleva solo herramienta en curso/detalle de error y tiempo corriendo. La **rama** (`ThreadBranch`) cuelga del hilo como hijo, como único hijo del hilo.
  - **Actividad** (`working` / `idle` / `needs attention`): sale del adaptador genérico. `ActivityTracker` (`application/src/activity.rs`, puro, con instante inyectado) registra cuándo emitió bytes cada terminal (`TauriOutputSink::output`); `agent_watcher.rs` hace `tick` cada 1 s y lo traduce a un `AgentEvent::StatusChanged` (sin salida por 3 s = `idle`). "Needs attention" es estado de UI (`src/activity.ts`, testeado): working -> idle sin que el usuario esté mirando el panel, hasta que lo mira. "Enfocado" significa `isWatching`: panel enfocado, visible (su sesión activa, sin minimizar) y con la ventana de la app en primer plano (`useWindowFocus`); volver a la ventana, a su sesión o restaurarlo también lo limpia. Solo se muestra si la terminal tiene un agente detectado (junto al título). El genérico no distingue "terminó" de "pide aprobación": eso lo informan los adaptadores ricos (ver abajo).
  - **Tiempo corriendo del agente**: `ProcessInspector` expone el arranque de cada proceso (`ProcessInfo.started_at`, de `sysinfo::Process::start_time`, segundos Unix; `None` si no se conoce) y `detect_agents` lo copia del proceso del agente principal a `AgentTree.primary_started_at`. El evento `terminal-agent` lleva `startedAt` (`null` sin agente). El frontend lo formatea con `src/duration.ts` (`45s`, `12m`, `1h 05m`) y se actualiza con un único temporizador compartido (`src/useNow.ts`) que solo re-renderiza el fragmento de uptime.
  - **Rama de git de la carpeta actual** (cualquier terminal, con o sin agente): puerto `RepositoryInspector` (`application/src/ports.rs`), caso de uso `InspectBranch`, y adaptador `FsRepositoryInspector` (`infrastructure/src/repository_inspector.rs`) que sube desde la carpeta hasta el primer `.git` (carpeta, o archivo `gitdir: <ruta>` de worktrees/submódulos) y lee `HEAD` sin el binario `git`. `application::git::parse_head` (puro): `ref: refs/heads/<rama>` es la rama; un SHA crudo es HEAD desacoplado y se muestra con 7 caracteres. Comando `git_branch(path)` -> `{ name, detached }` o `null` fuera de un repo. El frontend (`useGitBranch.ts` + `branchWatch.ts`, puro y testeado con timers falsos) lo consulta al cambiar el cwd (OSC 7 o carpeta inicial), al pasar a `idle` y **cada 3 s** (`BRANCH_POLL_MS`): OSC 7 solo se emite en el prompt, así que un cambio de rama mientras corre un agente, o hecho desde otra terminal en la misma carpeta, no avisa por otro lado. Las consultas pueden superponerse, así que una respuesta más vieja que la última aplicada se ignora; si una consulta falla se conserva la última rama conocida (solo se informa `null` si todavía no se conoce ninguna), para que un error transitorio no la haga parpadear. Mock de e2e: `window.__mock.branches`.
- **Status bar con estado real:** nada está hardcodeado. El núcleo sondea al relay (`HttpRelayProbe`, `GET /health` con `std::net`, timeout total de 1 s, éxito solo con `200` y cuerpo `ok`; caso de uso `CheckRelay`) y cuenta los participantes de la sesión con acceso (`SessionCollaborators`, `Session::participants` filtrado por `can_view`). `collab_status.rs` (desktop) lo expone como comando `collab_status` y como evento `collab-status` (`{ connected, syncMs, collaborators }`), emitido por un hilo propio que sondea cada 3 s. Regla de emisión (`should_emit`): siempre que cambie conectado o colaboradores; la latencia solo si se movió más de 5 ms y más de 25 % respecto de la última emitida, para no emitir en cada sondeo. La dirección sale de `RELAY_ADDR` o de `protocol::DEFAULT_RELAY_ADDR` (el server Nest usa el mismo default). En el frontend, `useCollabStatus` alimenta `StatusBar`; el valor inicial y los defaults son honestos (`DEFAULT_COLLAB_STATUS`: desconectado, sin latencia, 1 colaborador). Es la única señal real hasta que exista el `CollabTransport` WebSocket, que la reemplazará. El mock de Tauri responde `collab_status` desconectado; los E2E emiten `collab-status` con `window.__mock.emit`.
- **Directorio actual de cada terminal (shell integration):** la shell por defecto (`crates/infrastructure/src/shell.rs`) arranca PowerShell con `-NoExit -Command` envolviendo su `prompt` para emitir `OSC 7` (`ESC]7;file://localhost/C:/ruta ESC\`) antes de cada prompt; xterm lo lee (`registerOscHandler(7)`) y el header muestra la carpeta real en vivo. No se puede leer desde afuera porque PowerShell no cambia el cwd del proceso al hacer `cd`. Test real: `cargo test -p infrastructure --test shell_integration_e2e -- --ignored`. En Unix todavía no hay integración (solo se muestra la carpeta inicial).
- **Cambiador de ruta** (`CwdSwitcher.tsx`): menú con subcarpetas (adelante, vía `list_subdirectories` → `ListSubdirectories` → `DirectoryBrowser`), `..` y directorios padre (atrás). Navegar = escribirle un `cd` a la shell (`cdCommand` en `src/cwd.ts`, según la shell), así que se desactiva mientras corre un agente: el texto le llegaría al agente. El menú va en un portal con posición fija porque el panel tiene `overflow: hidden`, y se cierra con `resize`.
- **Nueva terminal desde otra** (`NewTerminalMenu.tsx`, botón `+` del header): abre otra al lado de la de origen, en su carpeta actual (la última que reportó OSC 7) o en la por defecto; `Ctrl/⌘+Shift+T` hace lo primero con la terminal enfocada. La carpeta viaja como `cwd` opcional de `open_shell` → `default_shell_profile(cwd)`, que cae al home si la carpeta ya no existe. Cada panel guarda su carpeta inicial en `Pane.initialCwd` y reporta la actual en `PaneMeta.cwd`.
- **`Panel`** (`components/Panel.tsx`): wrapper visual reutilizable (marco + barra de título + bloque interno oscuro con radio). Lo usan el panel de una terminal y la sesión del sidebar; cualquier contenedor nuevo con ese look debe usarlo en vez de copiar estilos. Se ajusta con variables CSS (`--panel-pad`, `--panel-bg`, `--panel-border`, `--panel-body-radius`) y `plain` lo deja sin marco.
- **Hilo de terminales en el sidebar:** cada sesión lista sus terminales en el orden de la grilla, con el mismo `TerminalIcon` que el header (logo del agente detectado o ícono de la shell). Cada panel reporta qué corre en él con `onMeta` hacia `App`. Clic en una terminal del hilo → va a su sesión y la enfoca.
- Logos de agentes: `packages/desktop/src/assets/agents/{claudecode,opencode,codex,antigravitycli,grok-xai}-logo.svg`. Se cargan con `import.meta.glob`, así que si falta uno el build no falla y el panel muestra un badge de texto. Se pintan como máscara CSS (`.pane-logo`: `mask` + `background-color: var(--text)`), no con `<img>`: el SVG solo aporta la forma y el color sale siempre del token, sin importar el `fill` del archivo.
- **`AgentEvent` y adaptadores de agentes:** todo lo que se sabe de un agente llega como `AgentEvent`s (`application/src/agent_event.rs`: `status_changed`, `tool_started`, `tool_finished`, `approval_required`, `message`, `completed`, `error`; `AgentStatus` es solo `working`/`idle`, "necesita aprobación" es un dato aparte). `AgentState::reduce` (`agent_state.rs`, puro, con las reglas documentadas arriba) los reduce a un estado por terminal (estado, herramienta con resumen de su entrada, aprobación pendiente, último mensaje truncado, completado / error). `AgentStates` lo guarda por terminal y `TauriAgentEvents` (`src-tauri/src/agent_events.rs`, un `AgentEventSink`) emite **un solo evento**, `terminal-agent-state { terminalId, state }`, con el estado ya reducido y solo si cambió: el frontend no duplica el reductor (`src/agentState.ts` solo decide cómo mostrarlo, con tests). Un `AgentAdapter` (`agent_adapter.rs`) aporta args/env al lanzar su agente (`prepare`) y produce eventos una vez creada la terminal (`bind`); se registra en `AgentAdapters`. Sin adaptador rige el genérico (`activity_event`, `exit_event`). El puerto del PTY todavía no expone el código de salida: `terminal-exit` se informa como `completed`.
- **Lanzar un agente como perfil:** el menú `+` del header (`NewTerminalMenu.tsx`) ofrece, además de la shell, los agentes conocidos instalados (`available_agents`: comando de `KnownAgent::launch_command` encontrado en el `PATH`, con `PATHEXT` en Windows). Elegir uno llama a `open_shell` con `agent` (id de `KnownAgent`). El agente corre **dentro de la shell por defecto** (`infrastructure/src/agent_launch.rs`, `agent_shell_profile`): en PowerShell se encadena `; <comando> '<args>'` al `-Command` de la integración OSC 7; en Unix, `-c '<comando>; exec $SHELL'`. Así al salir del agente el panel vuelve a la shell y la carpeta actual sigue reportándose. El dominio sigue agnóstico: es un `AgentProfile` más. La costura para los adaptadores es `AgentAdapters::prepare(agent)` en `open_shell` (agrega args/env antes de lanzar y devuelve un `PreparedLaunch` cuyo `bind(terminal, sink)` se llama con la terminal ya creada); `AppState.adapters` (registro en `state.rs::agent_adapters`) tiene los adaptadores ricos; sumar uno es implementar `AgentAdapter` y registrarlo ahí. Test real: `cargo test -p infrastructure --test shell_integration_e2e -- --ignored`.
- **Adaptador rico = fuente autoritativa:** si la terminal se lanzó con un adaptador (`PreparedLaunch::is_rich`), `open_shell` la marca con `AgentStates::mark_rich` y los `status_changed` del camino genérico (actividad del PTY, que entra por `apply_generic` / `TauriAgentEvents::emit_generic`) se ignoran para ella; la salida del proceso (`completed`) sigue valiendo. Al cerrarse la terminal, `AgentAdapters::release` deja que cada adaptador suelte lo suyo. Límite conocido: si el agente rico termina pero la terminal (shell) sigue, la marca persiste hasta cerrarla y un agente lanzado a mano ahí no tiene estado genérico.
- **Adaptador de Claude Code** (`infrastructure/src/claude_adapter.rs`, `claude_hooks.rs`, `hook_receiver.rs`): Claude se lanza con `--settings <archivo>`, que **suma** hooks HTTP a la configuración del usuario sin tocarla (nada en `~/.claude` ni en el proyecto). `prepare` escribe `claude-settings-<token>.json` en `<tmp>/opencollab/` (archivo y no JSON en línea, por el entrecomillado de PowerShell; se borra al cerrar la terminal y los de más de 24 h, al arrancar) con un hook `type: "http"` por evento (`UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `Notification`, `PostToolUse`, `Stop`, `StopFailure`; timeout de 2 s). `HookReceiver` es un único listener HTTP en `127.0.0.1`, puerto aleatorio, sin runtime async (un hilo por conexión, tope de 16, plazos de 5 s). **Seguridad:** el secreto por lanzamiento (UUID v4) va en la URL `/hook/<token>`; sin token registrado responde 401 antes de leer el cuerpo; cuerpo máximo 256 KiB (413), encabezado 16 KiB; al cerrar la terminal el token se da de baja. Siempre responde `{}` para no frenar al agente. `ClaudeHookTranslator::translate` es puro: `UserPromptSubmit` -> working; `PreToolUse` -> `tool_started`; `PermissionRequest` -> `approval_required` (`Bash: <comando>`; este hook no trae `tool_use_id`, el id sale de lo pedido) y `Notification(permission_prompt)` solo si no hay una aprobación pendiente; `PostToolUse` -> `tool_finished`; `Stop` -> `message` + idle (fin de turno, no `completed`); `StopFailure` -> `error`. Test real (consume un turno mínimo): `cargo test -p infrastructure --test claude_adapter_e2e -- --ignored --nocapture`.
- **Adaptador de OpenCode** (`infrastructure/src/opencode_adapter.rs`, `opencode_events.rs`, `sse.rs`): `opencode --port <p> --hostname 127.0.0.1` mantiene la TUI y expone su API HTTP. `prepare` elige un puerto libre de localhost (hay una ventana mínima hasta que OpenCode lo toma) y una **clave por lanzamiento** (UUID v4) que pasa por el entorno del proceso en `OPENCODE_SERVER_PASSWORD` (verificado: el servidor exige autenticación básica, usuario `opencode`, y la TUI sigue funcionando con la clave; sin clave o con una mala responde 401); nunca va en la línea de comandos ni en logs. `bind` lanza un hilo con un cliente SSE de `std::net` (sin dependencias nuevas: base64, `Transfer-Encoding: chunked` y separación de líneas están en `sse.rs`, con tests) que reintenta `GET /event` hasta 90 s mientras la TUI levanta el servidor, reconecta 10 s si se corta y se rinde ante un 401; se detiene al cerrar la terminal (`release`) y, si el servidor se va (OpenCode salió) pero la terminal sigue, informa `idle`. Líneas de más de 1 MiB se descartan. `OpenCodeTranslator::translate` (puro, con memoria mínima): `session.status` busy/idle y `session.idle` -> working/idle (las sesiones hijas, o sea subagentes, se ignoran); `message.part.updated` de tipo `tool` -> `tool_started` (en `pending` sin entrada y de nuevo en `running` con ella) y `tool_finished` (`completed`/`error`); `permission.asked` -> `approval_required` (`bash: <comando>`), `permission.replied` -> working (limpia la aprobación); texto final (`time.end`) de mensajes del asistente (el rol sale de `message.updated`) -> `message`; `session.error` -> `error`. Test real con la TUI en un PTY (consume un turno mínimo): `cargo test -p infrastructure --test opencode_adapter_e2e -- --ignored --nocapture`.
- Test end-to-end de detección con los CLIs reales instalados: `cargo test -p infrastructure --test agent_detection_e2e -- --ignored --nocapture --test-threads=1` (está `#[ignore]` porque depende de la máquina).
- Cerrar una terminal mata el **árbol de procesos completo** por pid (`taskkill /T /F` en Windows, `kill -KILL -<pgid>` en Unix), para que el agente que corre dentro de la shell no quede huérfano. No usar `ChildKiller::kill` de portable-pty: en Windows falla con "handle inválido" (os error 6) o devuelve un falso error con código 0.
- El frontend no usa `React.StrictMode`: su doble montaje en dev abriría un PTY extra por terminal (un panel solo cierra su PTY con el botón ✕ → `close_terminal`, no al desmontarse).
- **Salir desde la shell** (`exit` o cualquier forma de terminar el proceso): el núcleo emite `terminal-exit` y el panel sigue el mismo camino que el ✕ (`close_terminal` + se quita de la grilla). `close` es idempotente porque el ✕ también dispara `terminal-exit` al matar el PTY. E2E: `e2e/scenarios/exit-closes-pane.mjs`.
- **Web como puerta de autenticación** (`packages/web`): sin router ni estado global, cuatro rutas (`/login`, `/register`, `/auth/complete`, `/account`). El access token vive solo en memoria (`authClient.ts`); el refresh token es la cookie httpOnly `oc_refresh` (`Path=/auth`) que la página nunca ve, y toda llamada a `/auth/web/*` lleva `X-OpenCollab-CSRF: 1` y `credentials: 'same-origin'`. Nada va a `localStorage`/URL. El refresh es single-flight por pestaña y se serializa entre pestañas con Web Locks (`opencollab-refresh`; sin `navigator.locks` queda el single-flight local), y se renueva solo poco antes de `expiresIn`; un 401 deja la sesión cerrada. Web y API comparten origen (proxy de Vite en dev; reverse proxy en producción), por eso no hay CORS. **Entrega al desktop:** `/login?client=desktop&code_challenge=<S256, 43 caracteres base64url>`; solo el challenge se guarda en `sessionStorage` (sobrevive al viaje OAuth) y, tras autenticar (contraseña, registro o `/auth/complete`), se pide `POST /auth/web/desktop-code` y se navega al deep link `opencollab://` (cualquier otro destino se rechaza). Si ya había sesión, se ofrece "Continue as <usuario>". **CSP:** `vite preview` sirve `Content-Security-Policy` estricta (`default-src 'self'`, sin inline, `frame-ancestors 'none'`; definida en `packages/web/vite.config.ts`); en producción el reverse proxy debe enviar **la misma cabecera**. El dev server no la lleva (Fast Refresh necesita scripts inline). No usar `dangerouslySetInnerHTML` ni estilos en línea.
- Frontend: los workspaces y las sesiones del sidebar son por ahora estado de UI (`packages/desktop/src/model.ts`), porque el núcleo todavía no expone comandos para ellos; todas las terminales corren dentro de la única sesión del núcleo. Las terminales de sesiones no activas quedan montadas y ocultas (atributo `hidden`) para no perder sus PTY; xterm solo hace `fit()` si su contenedor tiene tamaño. Al agregar comandos de workspaces/sesiones en el núcleo, reemplazar ese estado local en lugar de duplicarlo.
- **Arrastrar paneles** (`packages/desktop/src/usePaneDrag.ts`): se arrastran por el header y se intercambian en vivo con el panel que está bajo el puntero, con animación FLIP. Regla clave: **nunca reordenar el DOM de los paneles** (mover el nodo de una xterm puede resetear su scroll/estado). El DOM se renderiza siempre por `Pane.seq` (orden de creación) y la posición visual sale del orden de `Session.panes` aplicado con la propiedad CSS `order`. El hit-testing usa `offsetLeft/Top` (posición de layout, sin transforms) para no oscilar mientras los demás paneles se animan. El arrastre se desactiva con un solo panel visible (maximizado o layout single).
- Íconos: los de UI genéricos vienen de `react-icons` (set Codicons, `react-icons/vsc`): `VscTerminal` en el contador de terminales de cada sesión, y en el header del panel el ícono de la shell (`VscTerminalPowershell`, `VscTerminalCmd`, `VscTerminalBash` o `VscTerminal`) cuando no corre un agente conocido. Los trazos simples propios están en `src/icons.tsx`; SVGs propios del proyecto en `src/assets/opencollab/` (pintados como máscara CSS para heredar el color del texto).
- Tipografía: **Google Sans**, empaquetada con la app vía `@fontsource-variable/google-sans` (funciona sin conexión; pesos 400–700). Se usa por el token `--font`; el código monoespaciado sigue con `--mono`.
- Diseño de referencia: tema oscuro, tipografía Google Sans, acento violeta (`--accent: #7c5cff`), sidebar (selector de workspace, búsqueda, sesiones, usuario), topbar (breadcrumb, Invite, layouts grid/columns/single, New terminal), paneles con header (badge, nombre, cwd, estado, controles) y status bar con atajos (`Ctrl/⌘+T`, `+1-4`, `+Shift+M`, `+K`).
- **Login del desktop vía la web** (`src-tauri/src/auth.rs`, `src/auth.ts`, `src/useAuth.ts`): la tarjeta de cuenta del sidebar (`AuthCard`) ofrece *Sign in*; el frontend genera el par PKCE S256 (WebCrypto) y llama `auth_begin_login`, que guarda el verifier y abre el navegador en `<web>/login?client=desktop&code_challenge=…` (`OPENCOLLAB_WEB_ORIGIN`, por defecto `http://localhost:1421`). La web vuelve con `opencollab://auth/callback?code=…` (plugins `deep-link` + `single-instance`: el deep link que llega como argumento de un segundo proceso se reenvía a la instancia abierta) y `auth_finish` lo canjea en `POST /auth/desktop/token`. Los tokens viven **solo en memoria del núcleo Rust** (el `fetch` del webview chocaría con CORS, que el server tiene apagado); la UI recibe el usuario por `auth_status` y el evento `auth-changed`. El scheme `opencollab://` se registra al instalar el `.msi`/`.exe`: correr el binario suelto no lo registra. El avatar del topbar y el avatar host de cada panel siguen con `hidden` y `localUser` (`src/model.ts`) hasta que haya sesiones compartidas reales. E2E: `e2e/scenarios/auth-signin.mjs`.
