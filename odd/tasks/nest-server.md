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
- `packages/contracts` y `apps/web`: T6, fuera de este documento por ahora.
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
- [x] **T3** — Persistencia completa: Prisma + PostgreSQL. Esquema acordado:
  `User`, `PasswordCredential`, `OAuthIdentity`, `RefreshToken`,
  `DesktopLoginCode`, `Workspace`, `WorkspaceMember`, `Session`,
  `SessionAccessOverride`, `SessionGuest`, `Terminal` (con `position`),
  `Invitation` (kind + status + `expiresAt`/`respondedAt`); migración inicial con `citext` y CHECK de `Invitation`,
  `docker-compose` local, servicio Postgres en el job `server` del CI,
  repositorios que mapean agregados ↔ filas con tests de integración.
- [x] **T4** — Auth: usuario o email + contraseña (argon2id), OAuth GitHub y
  Google (identidades vinculables), access JWT + refresh rotado con detección
  de reuso, `DesktopLoginCode` (PKCE) para el deep link al desktop.
- [x] **T5** — Ruteo por sesión y filtrado por permiso vigente en `/ws`
  (rama `feature/nest-ws`, apilada sobre `feature/nest-auth`).
  - [x] Wire: `join_session { session_id }` (cliente→server) y
    `joined { session_id, access }` (server→cliente) en `protocol.ts` y
    `crates/protocol`; `PROTOCOL_VERSION` sigue en 1 (sin clientes WS
    publicados). Errores nuevos como texto crudo: `{"error":"forbidden"}`
    (también para sesión inexistente, para no revelar existencia) y
    `{"error":"not_joined"}`.
  - [x] Handshake: access JWT en `Sec-WebSocket-Protocol`
    (`opencollab.v1, bearer.<jwt>`); el server elige `opencollab.v1`; sin
    token válido se rechaza el upgrade.
  - [x] Hub en memoria por sesión con conexiones activas (Session +
    Workspace cargados al primer join, liberados al irse el último);
    permiso evaluado en cada mensaje, nunca cacheado por conexión.
  - [x] `terminal_output`: solo del dueño, terminal de la sesión; fan-out a
    los suscriptos con Ver (sin eco al emisor).
  - [x] `terminal_input`: `user_id` = usuario del token, `canWrite`; se
    reenvía solo a las conexiones del dueño.
  - [x] `access_changed`: solo del dueño; `setAccess` del dominio, persiste,
    difunde a la sesión; quien pierde Ver queda desuscripto en el acto.
  - [x] Se elimina el eco del stub; `AGENTS.md` deja de decir "stub".
- [x] **T5b** — Correcciones de la review de T5 (rama `feature/nest-ws`).
  - [x] Vencimiento del JWT en el socket con renovación en banda: mensaje
    `reauth { token }` (cliente→server, access token nuevo obtenido por
    `POST /auth/refresh`); mismo usuario y vigente → se corre el vencimiento
    de la conexión y se responde `reauthenticated { expires_at }`; inválido
    o de otro usuario → `{"error":"unauthorized"}` sin cambiar el plazo. Sin
    renovación a tiempo (`exp` + margen chico) el server cierra el socket.
    El refresh token nunca viaja por el WS.
  - [x] La cola por conexión nunca queda rechazada (un error se registra y
    los mensajes siguientes se procesan); el gateway no deja promesas sin
    capturar.
- [x] **T5c** — Avisos pendientes de las reviews de T4/T5/T5b (rama
  `feature/nest-ws`). Orden acordado con el usuario: T5c → T6 → T7 → push.
  - [x] Token vencido: soltar la conexión del hub en el acto y `terminate()`
    si el cierre no se completa en un plazo corto.
  - [x] `reauth` nunca acorta el plazo (se toma el máximo).
  - [x] Logout y detección de reuso cierran los sockets de esa familia de
    refresh (el access JWT lleva el id de familia; otros dispositivos
    siguen conectados).
  - [x] Heartbeat: ping periódico; sin pong a tiempo → `terminate()`.
  - [x] Backpressure: un consumidor lento (`bufferedAmount` sobre un tope)
    se cierra con 1013 en vez de acumular memoria (descartar salida de
    terminal corrompería su estado).
  - [x] OAuth: cookie de binding por flujo (dos logins simultáneos en el
    mismo navegador no se pisan) con TTL igual al del state.
  - [x] Timeout total por intercambio con el proveedor (no por llamada).
  - [x] `trust proxy` configurable por entorno (apagado por defecto).
  - [x] Usernames generados con sufijo aleatorio en vez de sondeo lineal.
  - Fuera de T5c: membresía del workspace cacheada en el hub (no existe aún
    un camino que la cambie; se resuelve con los comandos de workspace).
- [x] **T5d** — Avisos de la review de T5c (rama `feature/nest-ws`).
  - [x] Familias revocadas en memoria con TTL = vida del access token;
    `verifyAccessClaims` rechaza un `sid` revocado (upgrade y `reauth`).
  - [x] `reauth` adopta la familia del token nuevo solo si es el que vence
    más tarde (familia y plazo siempre del mismo token).
  - [x] Cerrar un consumidor lento no desconecta del hub durante un
    recorrido de broadcast (se difiere hasta terminar el recorrido).
  - Se deja: cookies `oc_oauth_<flow>` de flujos abandonados viven hasta su
    TTL (10 min).
- [x] **T6** — `apps/web` como puerta de autenticación (rama
  `feature/nest-web`, apilada sobre `feature/nest-ws`). Stack elegido por el
  usuario: Vite + React + TS (mismo toolchain que el desktop).
  `packages/contracts` queda para una tarea aparte.
  - Decisión de sesión web (recomendada, mismo origen): el refresh token de
    la web vive en una cookie httpOnly (`SameSite=Strict`, `path=/auth`,
    `Secure` fuera de localhost) y el access token solo en memoria. En dev
    Vite hace proxy de `/auth` al server, así la web y la API comparten
    origen; en producción, reverse proxy. Nada de tokens en `localStorage`
    ni en la URL. Los clientes no web (desktop) siguen con tokens en JSON.
  - [x] **T6a (server)**: login/registro/refresh/logout web con la cookie
    (+ cabecera anti-CSRF obligatoria en las rutas que leen la cookie);
    el callback OAuth `client=web` setea la cookie y redirige a la web
    (`WEB_ORIGIN`, reemplaza `deliverWebLogin`); `POST /auth/desktop/code`
    (autenticado, con `code_challenge` PKCE) emite un `DesktopLoginCode` y
    devuelve la URL `opencollab://auth/callback?code=…`, así login por
    contraseña también llega al desktop.
  - [x] **T6a-fix (server)**: (a) ventana de gracia de 10 s en
    `/auth/web/refresh`: un refresh rotado hace menos de 10 s, de familia
    no revocada, recibe solo un access token (sin rotar, sin tocar la
    cookie); pasado el plazo, reuso = revocación como hoy (la web además
    serializa el refresh entre pestañas con Web Locks en T6b); (b)
    `/auth/desktop/code` pasa a exigir la cookie de sesión web + cabecera
    CSRF en vez del bearer; (c) JSDoc desplazado en `collab.gateway.ts`.
  - [x] **T6b (web)**: `apps/web` con su propio `package.json` + lockfile
    (sin `pnpm-workspace` raíz): rutas `/login`, `/register`, `/account`
    (datos de `me`, vincular GitHub/Google); con
    `?client=desktop&code_challenge=…` tras autenticar pide el código y
    redirige al deep link. Vitest + Testing Library; job `web` en el CI;
    `AGENTS.md` (estructura y comandos).
  - [x] **T6b-fix (web)**: carrera logout/refresh (epoch), `logout()`
    rechaza si el server no confirma, timeout de 10 s en cada request
    (libera el Web Lock), `ContinuePage` con error y reintento, captura del
    handoff fuera de React (`main.tsx`).
- [ ] **T7** — Achicar `crates/domain` a lo que necesita el desktop (PTY,
  terminal, validación final con el `AccessLevel` que manda el server) y
  actualizar `AGENTS.md` (deja de regir "el dominio Rust manda").
- [x] **T8** — Docker (pedido del usuario antes del push): `docker compose`
  levanta Postgres + server + web; el desktop NO va en contenedor (se
  descarga el instalador de la release y corre nativo contra el server del
  contenedor). Imagen del server multi-etapa (Node 24, migraciones al
  arrancar, healthcheck `/health`, 8787 publicado solo en `127.0.0.1`);
  imagen de la web multi-etapa (build Vite → nginx en `127.0.0.1:8080`, SPA
  fallback, proxy `/auth` y `/ws` con upgrade al server, misma CSP que el
  preview); server con `TRUST_PROXY=1`; `JWT_SECRET` obligatorio desde `.env`
  raíz (ignorado) con `.env.example`, sin secretos por defecto; `docker
  compose up -d postgres` sigue sirviendo para los tests.
  - Hecho en `feature/nest-docker` (apilada sobre `feature/desktop-login`).
    Ruta: delegada (escritor único; 2+ archivos no triviales: Dockerfiles,
    compose, nginx). Desvíos acordados: `JWT_SECRET` y OAuth no se validan
    en Compose (`${VAR:?}` rompería `up -d postgres`) sino en el server, que
    sale al arrancar; el server corre **solo en Docker** (se borró
    `apps/server/.env.example`); GitHub y Google pasan a ser **obligatorios**
    (`loadAuthConfig` falla sin cualquiera de las 4 variables). La CSP de
    nginx está atada a la de `vite.config.ts` por `apps/web/src/nginx.test.ts`.
  - Evidencia: web 90 tests (RED del test de nginx observado), server 212 +
    99 de integración, typecheck; `docker compose up -d --build` con los 3
    servicios healthy, `/health` = ok, `/login` 200 con CSP, `/auth` y `/ws`
    llegan al server por nginx, registro/login por 8080, puertos solo en
    127.0.0.1, server sin `GITHUB_CLIENT_ID` sale con el error, inicio OAuth
    GitHub redirige con callback `http://localhost:8080/...`. Sin verificar:
    callback OAuth completo, migrar una base vacía, CI que construya imágenes.

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
- 2026-10-06: T3 completado en `feature/nest-persistence` (writer delegado,
  TDD estricto). Commits `ad1d083` (rehidratación `Workspace.restore`/
  `Session.restore` + copia de arrays de `AgentProfile`) y `ae79c8d`
  (Prisma 7.10.0 con `prisma.config.ts` y adapter `pg`, esquema completo,
  migración con `citext` + CHECK de `Invitation`, repositorios, Postgres en
  `docker-compose.yml`, job `server` del CI en `ubuntu-latest` con servicio
  Postgres porque los service containers no corren en runners Windows).
  RED observado (unit: `restore` inexistente; integración: repos
  inexistentes). GREEN re-corrido por el parent: unit 54/54, integración
  26/26, typecheck y build limpios. Avisos de T2: (a) duplicado en
  `participants`, (b) override que sobrevive al re-agregar y (c) nivel sin
  validar en runtime se comportan igual en Rust → se dejan; (d) aliasing
  era propio de TS → corregido. El YAML del CI no se ejecutó localmente.
- 2026-10-06: Review de T3 (base `81f08e2`, lineage
  `review-d8a1451c345b3792`, riesgo alto, 4 lentes; 3 capturas fallaron por
  límite de uso, se reofrecieron y se relanzaron): aprobada sin correcciones
  y acknowledged. Límite revisado → `ae79c8d`. Avisos para T4: un `username`
  puede coincidir con el `email` de otro usuario y volver ambiguo el login
  (prohibir `@` en usernames); `listPendingFor` ignora `expiresAt`;
  `setStatus` no valida transiciones (solo desde `PENDING`); `Session.save`
  reemplaza hijos sin control de concurrencia; `Postgres` local expuesto en
  `0.0.0.0:5432` (atar a `127.0.0.1`).
- 2026-10-06: T4 implementado en `feature/nest-auth` (writer delegado, TDD
  estricto). Commits `4f16dd9` (follow-ups de T3: invitaciones vencidas,
  transiciones solo desde `PENDING`, Postgres en `127.0.0.1`) y `62dbdcc`
  (auth: argon2id, JWT 15 min, refresh rotado con detección de reuso,
  OAuth GitHub/Google por fetch detrás de un puerto, PKCE + state firmado,
  sin unión automática por email, vinculación explícita, `DesktopLoginCode`
  para `opencollab://auth/callback`, throttling, fail-fast de config; zod
  para validación). GREEN re-corrido por el parent: unit 85/85, integración
  66/66, typecheck y build limpios; boot smoke del writer OK. Desvío de TDD:
  `compose.spec.ts` se escribió después del cambio (nunca vio RED). Sin
  probar contra GitHub/Google reales (faltan credenciales OAuth).
- 2026-10-06: Review de T4 (base `ae79c8d`, lineage
  `review-810a4189c17108cb`, riesgo alto, 4 lentes):
  aprobada y acknowledged. Límite revisado → `62dbdcc`. Avisos (no
  bloqueantes) a resolver: **R1-001** el `state` de vinculación no está
  atado al navegador → un atacante puede hacer que la identidad de GitHub/
  Google de la víctima quede vinculada a la cuenta del atacante (login CSRF
  de vinculación); rotación de refresh no atómica (falla al insertar el
  nuevo → reintento revoca la familia); fetch a proveedores sin timeout;
  throttling por IP sin `trust proxy`; username con sondeo lineal;
  `ProviderKey` y `databaseUrl` duplicados/muertos.
- 2026-10-06: Correcciones de la review de T4 en `fb550ec` (writer delegado,
  TDD estricto, RED observado por cada fix): flujo OAuth atado al navegador
  con cookie `oc_oauth` (httpOnly, SameSite=Lax, path `/auth/oauth`, hash en
  el state; el ataque de vinculación ahora da 400), rotación de refresh en
  una transacción (`rotateRefreshToken`), timeout de 10 s a proveedores con
  502. GREEN re-corrido por el parent: unit 92/92, integración 75/75,
  typecheck y build. Review (`review-bddce096c09dbde7`, 4 lentes): aprobada
  y acknowledged; límite revisado → `fb550ec`. Avisos pendientes: cookie de
  binding única → dos flujos OAuth simultáneos en el mismo navegador hacen
  fallar el primero; TTL de la cookie no derivado del state; link desde una
  web en otro origen necesita CORS con credenciales (T6); el timeout es por
  llamada (GitHub hace 3 → hasta ~30 s); `trust proxy` y sondeo de
  usernames siguen abiertos.
- 2026-10-06: T5 iniciado en `feature/nest-ws` (desde `3ae404f`). El usuario
  aprobó el diseño (incluido tocar `crates/protocol`) y postergó T6
  (`apps/web` como puerta de auth). Ruta: delegado directo (writer único:
  wire TS + Rust, gateway, hub, tests, doc), TDD estricto con
  `pnpm --dir apps/server test` / `test:integration`. Alcance autorizado
  extra: `crates/protocol/**` y la línea de estado del relay en `AGENTS.md`.
- 2026-10-06: T5 implementado por el writer delegado (sin commit; Docker no
  disponible, ver abajo). Archivos: `protocol.ts`/`crates/protocol` (join_session,
  joined, `parseFrame` reemplaza al eco), `hub.ts` (SessionHub con puerto
  `SessionStore`, cola por conexión, carga deduplicada, evicción al irse el
  último), `handshake.ts` + `collab.gateway.ts` (verifyClient/handleProtocols
  seteados en `server.options` en `onModuleInit`, porque las opciones del
  decorador no ven DI; `maxPayload` 1 MiB), `persistence/session-store.ts`,
  módulos (AuthModule exporta SessionService; PersistenceModule provee
  Session/WorkspaceRepository). RED observado: protocol.spec 10 fallos
  (`parseFrame is not a function`), hub.spec (`Cannot find module './hub'`),
  handshake.spec (módulo faltante), collab.gateway.spec 6 fallos (Nest no
  resolvía SessionHub). GREEN: unit 129/129 (incluye sockets `ws` reales: 401
  sin token/token inválido/sin subprotocolo, subprotocolo elegido, fan-out,
  revocación en vivo, evicción). Rust: los tests de `join_session`/`joined` se
  escribieron junto con la implementación (RED de Rust NO observado por
  separado). Boot real de `dist/main.js`: `/health` 200 y upgrade sin token
  401. Desvío menor: error crudo extra `{"error":"unavailable"}` cuando falla
  el storage (revierte el cambio en memoria si falla `save`). Pendiente:
  `session-store.int.spec.ts` escrito pero NO ejecutado (Docker daemon
  apagado: `test:integration` sin correr). Abiertos: el token vencido no corta
  una conexión ya abierta (solo se valida en el upgrade), sin backpressure
  (`send` sin control de buffer), cambios de membresía del workspace no
  invalidan sesiones vivas (solo `access_changed` por el hub).
- 2026-10-06: Integración re-corrida por el parent con Postgres local
  (`docker compose up -d`): `test:integration` 78/78 (incluye
  `session-store.int.spec.ts`); unit 129/129 re-corrido por el parent. T5
  cerrado con commit work-unit en `feature/nest-ws`.
- 2026-10-06: Commit de T5 `eb27470`. Review (base `fb550ec`, lineage
  `review-72f3528a90e2b644`, riesgo alto por `auth.module.ts`, 4 lentes,
  consent granted): aprobada sin correcciones y acknowledged (autoridad
  quemada). Límite revisado → `eb27470`. Avisos no bloqueantes a resolver:
  el JWT solo se valida en el upgrade (un socket sobrevive al vencimiento o
  a la revocación del refresh); membresía del workspace cacheada en el hub
  (cambios por fuera de `access_changed` no se ven); cola por conexión sin
  límite y una promesa rechazada puede envenenarla; fan-out sin
  backpressure; sin heartbeat (sockets medio abiertos); el revert de un
  `access_changed` fallido puede pisar un cambio concurrente; tests con
  `sleep` y un `FakeStore` compartido entre specs.
- 2026-10-06: T5b implementado por el writer delegado (sin commit). Wire:
  `reauth { token }` / `reauthenticated { expires_at }` en `protocol.ts` y
  `crates/protocol` (`PROTOCOL_VERSION` sigue en 1). `SessionService.
  verifyAccessClaims` devuelve `{ userId, expiresAt }` (`verifyAccess` delega).
  Diseño: `connection-deadline.ts` (`ConnectionDeadline`, `TOKEN_GRACE_MS` =
  5 s) vive en el gateway; el hub solo rutea y delega `reauth` a
  `HubConnection.reauthenticate(token)`, que el gateway implementa (mismo
  usuario o `undefined` → `{"error":"unauthorized"}` sin tocar el plazo).
  Vencido el plazo: `close(1008, 'token_expired')`; el timer se limpia en
  `close`. La cola del hub nunca queda rechazada (`.catch` que registra solo
  el nombre del error), el error de parseo usa `safeSend`, y el gateway
  agrega listener de `error` del socket. RED observado: `cargo test -p
  protocol` no compilaba (`Message::Reauth`/`Reauthenticated` inexistentes);
  vitest 9 tests fallando en 5 archivos (`verifyAccessClaims`, módulo
  `connection-deadline` y `UNAUTHORIZED` inexistentes, reauth sin manejar);
  el test de cola envenenada se confirmó en RED quitando el `.catch`. GREEN:
  unit 148/148, integración 78/78, typecheck, build, `cargo test -p protocol`
  8/8, clippy `-D warnings` y `fmt --check` limpios. Los tests del gateway
  usan fake timers (solo `setTimeout`/`clearTimeout`/`Date`) con sockets `ws`
  reales. Pendiente: heartbeat, backpressure y revocación de refresh sobre un
  socket abierto siguen fuera de alcance.
- 2026-10-06: Commit de T5b `81eb4a4` (parent re-corrió unit 148/148 y
  `cargo test -p protocol` 8/8). Review (base `eb27470`, lineage
  `review-4dc175ba56456b56`, riesgo alto, 4 lentes, consent granted):
  aprobada sin correcciones y acknowledged. Límite revisado → `81eb4a4`.
  Avisos no bloqueantes: al vencer el token el socket se cierra con
  `close()` y el hub lo suelta recién en el evento `close`, así que un
  cliente que no contesta el cierre puede seguir mandando frames un rato
  (soltar del hub en el acto y `terminate()` tras un plazo); un `reauth` con
  un token más viejo pero vigente acorta el plazo (tomar el máximo); listener
  de `error` sin test; logs de errores sin contexto.
- 2026-10-06: T5c implementado por el writer delegado (sin commit; retomado
  tras un corte por límite de uso, el estado en disco se re-verificó). Diseño:
  (1-2) `ConnectionDeadline.extend` (solo mueve el plazo más tarde y devuelve
  el vigente; `reauthenticated` informa ese); al vencer, el gateway suelta la
  conexión del hub en el acto, `close(1008,'token_expired')` y `terminate()`
  tras `CLOSE_HANDSHAKE_TIMEOUT_MS` (5 s). (3) el access JWT lleva `sid`
  (familia de refresh); `SessionRevocations` (puerto en proceso, sin Nest en
  el dominio) lo publica `SessionService` tras `revokeFamily` (logout, reuso,
  perdedor de rotación concurrente); el gateway indexa sockets por familia y
  cierra `1008 session_revoked`; `reauth` adopta la familia del token nuevo.
  Tokens sin `sid` (previos al claim) siguen verificando pero no tienen
  familia: ninguna revocación los alcanza y caducan con su `exp` (≤15 min).
  (4) heartbeat (`HEARTBEAT_INTERVAL_MS` 30 s) arrancado al primer socket y
  detenido al irse el último y en `onModuleDestroy`; sin pong al siguiente
  tick → `terminate` + soltar del hub. (5) `MAX_BUFFERED_BYTES` 4 MiB: sobre
  el tope se cierra `1013 slow_consumer` y se suelta del hub (el cliente
  debe reconectar y resincronizar; nada se descarta en silencio). (6) cookie
  `oc_oauth_<flow>` por flujo (el state lleva `flow`; un state sin `flow`
  es inválido), `Max-Age` = `STATE_TTL_SECONDS`, se limpia solo la de ese
  flujo; el ataque de vinculación sigue dando 400. (7) una sola señal
  `AbortSignal.timeout` por `exchange` (10 s en total), timeout → 502.
  (8) `TRUST_PROXY` (false por defecto; cantidad de saltos o lista de
  IP/CIDR/presets; `true` se rechaza por permitir falsificar la IP), aplicado
  con `applyHttpConfig` en `main.ts` y la app de test. (9) usernames
  `base-<6 [a-z0-9]>` con 5 reintentos acotados.
  RED observado por ítem: gateway spec 9 fallos (detach al vencer, terminate,
  máximo del plazo, familia x2, heartbeat x3, backpressure) antes de
  implementar; `connection-deadline` `extend is not a function`;
  session.service.spec 4 fallos (sid, anuncio en logout/reuso) tras módulo
  faltante; binding/state specs 7 fallos; providers.spec 2 fallos (3 y 2
  señales distintas); config.spec 4 fallos; integración `trust proxy`: 429
  en vez de 401; username.spec 4 fallos. Límite: el RED de integración de las
  dos cookies simultáneas no se observó por separado (el cambio de
  `binding`/`state` ya había roto el servicio; el RED es el unitario).
  GREEN: unit 179/179 (gateway spec corrido 3 veces, estable), integración
  81/81, typecheck, build, clippy `-D warnings` y `fmt --check` limpios.
  `AGENTS.md` sin cambios (ningún hecho de relay/auth quedó falso). Abiertos:
  membresía del workspace cacheada en el hub (fuera de alcance); si se agota
  `pickAvailableUsername` el callback responde 500 (probabilidad
  despreciable); el timer de cierre usa `unref`.
- 2026-10-07: Commit de T5c `064f295` (parent re-corrió unit 179/179 e
  integración 81/81). Review (base `81eb4a4`, lineage de 4 lentes, riesgo
  alto, consent granted): aprobada sin correcciones y acknowledged. Límite
  revisado → `064f295`. Avisos nuevos no bloqueantes: (a) revocar una
  familia solo cierra los sockets abiertos en ese momento; un access token
  todavía vigente de esa familia puede abrir un socket nuevo o usarse en
  `reauth` hasta su `exp` (falta una lista en memoria de familias revocadas
  con TTL = vida del access); (b) `reauth` adopta la familia del token
  presentado aunque el plazo quede del anterior; (c) cerrar un consumidor
  lento desde `send` desconecta del hub mientras éste itera el broadcast
  (reentrancia); (d) cookies `oc_oauth_<flow>` de flujos abandonados se
  acumulan hasta su TTL.
- 2026-10-07: T5d implementado por el writer delegado (sin commit). (1)
  `SessionService` guarda las familias revocadas en un `Map` en memoria con
  vencimiento = instante de revocación + `ACCESS_TTL_SECONDS` (la misma
  constante que el TTL del JWT, con el reloj inyectado); se poda en cada
  revocación, así que no crece sin límite; `verifyAccessClaims` rechaza un
  `sid` revocado, lo que cubre upgrade, `reauth` y `AccessGuard` (HTTP, que
  usa `verifyAccess`). Es por proceso: un deploy multi-instancia necesitaría
  un almacén compartido. (2) `reauth` adopta la familia solo si el plazo
  vigente que devuelve `extend` es el del token presentado (familia y plazo
  del mismo token). (3) `send` ya no suelta al consumidor lento en el acto:
  difiere el `drop(1013)` con `queueMicrotask` (una sola vez por conexión) y
  el hub itera una copia de `live.conns` en output/input. RED observado: 4
  specs de `session.service` (token de familia revocada aún válido, tras
  reuso, `revokedFamilyCount` inexistente x2), gateway: reauth con token más
  viejo (cierre no llegó: la familia vieja capturaba el socket) y orden
  `disconnect` antes de `send` al peer sano. El test de hub (peer que se
  desconecta desde `send`) pasó ya en RED: iterar un `Set` mientras se borra
  es seguro en JS; queda como guarda de regresión. GREEN: unit 185/185,
  integración 81/81, typecheck y build limpios. Se omitió el test de
  "olvido por TTL vía verify" (un token vencido falla antes por `exp`); la
  poda se prueba en la siguiente revocación. Fuera: cookies
  `oc_oauth_<flow>` abandonadas.
- 2026-10-07: Commit de T5d `7c9d719` (parent re-corrió unit 185/185 e
  integración 81/81). Review (base `064f295`, 4 lentes, riesgo alto,
  consent granted): aprobada y acknowledged; límite revisado → `7c9d719`.
  Aviso de dos lentes corregido inline (TDD): el corte diferido de un
  consumidor lento corría sin captura y un fallo de `hub.disconnect` tiraba
  el proceso; ahora `detach` captura y registra el error (solo el nombre) y
  el socket se cierra igual. RED: test nuevo con "Uncaught Exception: boom"
  y el socket sin cerrar; GREEN: unit 186/186 sin errores sin capturar,
  integración 81/81, typecheck y build limpios. Sugerencias no aplicadas:
  test del empate en `reauth`, test de upgrade con familia revocada a
  nivel gateway, fake de repo duplicado en specs.
- 2026-10-07: T6a implementado por el writer delegado (sin commit). Rutas
  nuevas (todas bajo `/auth`; las de `web/*` exigen `X-OpenCollab-CSRF: 1`,
  si no 403 sin efectos):
  - `POST web/register` (201) y `POST web/login` (200): mismo body que las
    JSON; respuesta `{ user, accessToken, expiresIn, tokenType }` y
    `Set-Cookie: oc_refresh=<token>; Path=/auth; HttpOnly; SameSite=Strict;
    Max-Age=30d` (+ `Secure` salvo http en localhost/127.0.0.1/[::1]).
  - `POST web/refresh` (200, sin body): lee la cookie, rota con el mismo
    `SessionService.refresh` (reuso revoca la familia), responde
    `{ accessToken, expiresIn, tokenType }` y re-setea la cookie; sin cookie o
    con una muerta → 401 y la cookie se borra.
  - `POST web/logout` (204): revoca la familia de la cookie y la borra
    (idempotente, también sin cookie).
  - `POST desktop/code` (200, `AccessGuard`, STRICT): body `{ code_challenge }`
    → `{ redirectUrl: "opencollab://auth/callback?code=…" }`; usa
    `OAuthService.issueDesktopCode`, el mismo camino del flujo OAuth desktop;
    `POST desktop/token` no cambia.
  - OAuth `client=web`: el callback ya no devuelve JSON. Éxito de login →
    cookie `oc_refresh` + 302 a `${WEB_ORIGIN}/auth/complete`; link → 302 a
    `${WEB_ORIGIN}/account?linked=<provider>`; fallo con state verificado → 302
    a `${WEB_ORIGIN}/login?error=<code>` (`/account?error=<code>` si era un
    link), con código `access_denied | invalid_state | conflict |
    provider_unavailable | failed`. State inválido/vencido sigue siendo un 400
    plano. Desktop sin cambios. `deliverWebLogin` eliminado.
  - Config nueva `WEB_ORIGIN` (default `http://localhost:1421`; 1420 es el
    Vite del desktop; solo origen http(s), falla al arrancar si no). CORS
    sigue apagado (mismo origen vía proxy). Archivos: `web-session.ts`
    (cookie + `CsrfGuard`), `config.ts`, `dto.ts`, `oauth.service.ts`,
    `auth.controller.ts`, `test-app.ts` y sus specs.
  - Decisión: la cabecera CSRF se exige también en login/register web (no solo
    en las que leen la cookie) para que el contrato sea uniforme.
  - RED (antes de implementar): unit 3 tests de `WEB_ORIGIN` + `web-session.spec`
    sin módulo (2 archivos en rojo); integración 26 tests en rojo (rutas web,
    CSRF, `desktop/code`, callbacks OAuth web). GREEN: unit 194/194,
    integración 93/93, typecheck y build limpios. Los tests OAuth previos que
    asumían JSON en el callback web se reescribieron al nuevo contrato.
- 2026-10-07: Commit de T6a `b7cfd33` (parent re-corrió unit 194/194 e
  integración 93/93). Review (base `7c9d719`, incluye `5971f95`; 4 lentes,
  riesgo alto, consent granted): aprobada y acknowledged; límite revisado →
  `b7cfd33`. Avisos a corregir antes de T6b (T6a-fix): (a) dos pestañas que
  refrescan a la vez comparten la cookie: la segunda presenta un refresh ya
  rotado, la detección de reuso revoca la familia y desloguea al usuario;
  (b) `POST /auth/desktop/code` acepta solo un access token: un access
  robado (15 min) se convierte en una familia de refresh nueva vía el
  desktop; (c) JSDoc desplazado por el `logger` en `collab.gateway.ts`.
- 2026-10-07: T6a-fix implementado por el writer delegado (sin commit).
  (a) `POST /auth/web/refresh`: `WEB_REFRESH_GRACE_MS` = 10 s y `classifyWebRefresh`
  (pura, en `refresh-policy.ts`, reloj inyectado). Sin migración: `revokedAt` de
  un token rotado ya es el instante de rotación; la revocación de familia se
  distingue con el nuevo `AuthRepository.familyHasLiveToken` (queda algún token
  sin revocar y vigente). Token rotado hace <10 s y familia viva → 200 con
  `{ accessToken, expiresIn, tokenType }` (mismo `sid`), sin rotar y sin tocar la
  cookie; nunca devuelve refresh token. Desde los 10 s (borde incluido) rige
  reuso → revoca familia → 401 + cookie borrada. Un perdedor de rotación
  concurrente en la web también recibe gracia (no mata la familia del ganador).
  `/auth/refresh` (desktop) queda estricto, sin gracia.
  (b) Ruta final: `POST /auth/web/desktop-code` (reemplaza a
  `/auth/desktop/code`, que ahora da 404; la cookie `Path=/auth` la cubre).
  Exige cookie `oc_refresh` + `X-OpenCollab-CSRF: 1` (`CsrfGuard`); el usuario
  sale de `SessionService.sessionUser` (solo lectura: existe, no revocado, no
  vencido; no rota ni toca la cookie). Bearer solo → 403 sin cabecera / 401 con
  ella. Body `{ code_challenge }`, respuesta `{ redirectUrl }`; el canje en
  `/auth/desktop/token` no cambia. (c) JSDoc de `authenticated` restituido en
  `collab.gateway.ts`.
  RED: `refresh-policy.spec` 5 fallos (`classifyWebRefresh` inexistente);
  `session.service.spec` 7 fallos (`refreshWeb`/`sessionUser` inexistentes);
  integración 6 fallos (gracia + 5 de `desktop-code`: ruta inexistente/bearer).
  `familyHasLiveToken` (int) se escribió junto con el método (RED no observado
  por separado). GREEN: unit 207/207, integración 99/99, typecheck y build
  limpios. El test existente de reuso web ahora avanza el reloj 10 s.
- 2026-10-07: Commit de T6a-fix `69fe22b` (parent re-corrió unit 207/207 e
  integración 99/99). Review (base `b7cfd33`, 4 lentes, riesgo alto, consent
  granted): aprobada y acknowledged; límite revisado → `69fe22b`. R1 (la
  ventana de 10 s debilita la detección de reuso) es el costo aceptado por
  el usuario. Corregido inline (TDD) R3-001: quien perdía la carrera de
  rotación recibía gracia sin verificar que la familia siguiera viva (un
  logout concurrente podía dejar pasar un access nuevo); ahora exige
  `familyHasLiveToken`. RED: test nuevo fallando; GREEN: unit 208/208,
  integración 99/99, typecheck y build. Sugerencia abierta: simplificar el
  flujo `lost`/`grace` de `rotate`.
- 2026-10-07: Review de `2ca7771` (4 lentes, riesgo alto, consent granted):
  aprobada y acknowledged; límite revisado → `2ca7771`. Aviso no
  bloqueante: el test nuevo usa `rejects.toThrow()` genérico (el RED sí se
  observó antes del fix); conviene afirmar `UnauthorizedException`.
  Siguiente: T6b (web).
- 2026-10-07: T6b implementado por el writer delegado (sin commit). `apps/web`
  (Vite 8 + React 19 + TS 7, lockfile propio, puerto 1421, proxy `/auth`),
  `authClient` (token en memoria, CSRF, single-flight + Web Locks con
  fallback, refresh proactivo, 401 = cerrado), `handoff` (challenge S256 en
  `sessionStorage`, deep link `opencollab://` únicamente), validación
  espejo del server, páginas login/registro/complete/cuenta, CSP estricta en
  `vite preview`, job `web` en el CI, `AGENTS.md`. RED observado por módulo
  (suite sin el módulo: `Failed to resolve import ./authClient|./handoff|
  ./validation|./App`); GREEN: 4 archivos, 78 tests. Una expectativa de test
  propia estaba mal (login 401 esperaba `anonymous`, el estado correcto es
  `unknown` sin refresh previo) y se corrigió. `font-src 'self'` obligó a
  `assetsInlineLimit: 0` (una fuente salía como `data:`). Smoke: `vite
  preview` envía la CSP; el proxy responde 502 sin server (no se levantó
  Postgres, omitido).
- 2026-10-07: Parent verificó T6b: web unit 78/78 y build OK. Smoke de punta
  a punta (server real con Postgres + `vite preview` con proxy, variables de
  prueba explícitas): raíz 200 con CSP; `/auth/web/refresh` sin cabecera
  CSRF 403, con cabecera y sin cookie 401; registro 201 con cookie
  `oc_refresh`; refresh 200; `/auth/me` con el access; `desktop-code`
  devuelve `opencollab://auth/callback?code=`; logout 204; refresh tras
  logout 401. Procesos detenidos.
- 2026-10-07: Commit de T6b `1d8e440`. Review (base `2ca7771`, 4 lentes,
  consent granted): aprobada y acknowledged; límite revisado → `1d8e440`.
  Avisos a corregir (T6b-fix): carrera logout/refresh en vuelo (dos lentes:
  un refresh que termina después del logout re-autentica); `logout()` no
  mira la respuesta (403/5xx/red → la UI dice "cerraste sesión" con la
  cookie viva); requests sin timeout y el refresh entre pestañas retiene el
  Web Lock indefinidamente si el server cuelga; `ContinuePage` queda en
  "Loading…" para siempre si falla `me()` (dos lentes); `captureHandoff`
  como efecto dentro de un inicializador de `useState`.
- 2026-10-07: T6b-fix implementado por el writer delegado (sin commit).
  (1) `authClient` lleva un `epoch` que `logout()` incrementa; un refresh en
  vuelo que resuelve después ya no re-autentica ni rearma el timer. (2)
  `logout()` rechaza ante error de red o non-2xx y conserva la sesión (con
  reintento de refresh); la UI muestra "Could not sign out, try again." en
  la cuenta y en "Use a different account". (3) `request()` con
  `REQUEST_TIMEOUT_MS = 10_000` (AbortController + race, funciona con
  timers falsos); el callback del Web Lock se resuelve al vencer. (4)
  `ContinuePage` muestra alerta, "Try again" y "Use a different account".
  (5) `captureInitialHandoff` se llama una vez en `main.tsx` antes del
  render; se quitó el efecto del inicializador de `useState`. RED (9
  tests): refresh posterior al logout, logout con red caída / 403,
  signal en fetch, timeout, lock que se libera, error de `ContinuePage`,
  logout fallido en la cuenta, render sin escribir en sessionStorage.
  GREEN: web 87/87, build OK.
