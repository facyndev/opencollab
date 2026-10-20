//! Backend de nube del snapshot: la API REST de OpenCollab detrás del mismo
//! puerto `SnapshotStore` que el modo local (feature desktop-dual-storage, S6/S7).
//!
//! El HTTP es bloqueante (`ureq` con rustls, sin runtime async, la misma regla
//! de la capa de aplicación). Cada pedido sale con el token vigente del
//! `AccessTokenProvider`; ante un 401 se fuerza un refresh una sola vez y se
//! reintenta el pedido antes de fallar. Los ids que no son UUID derivan un
//! UUID v5 determinista, así el mismo id local crea siempre el mismo recurso
//! en el server (creates idempotentes; la migración T6 reusa el mapeo).
//!
//! `save_snapshot` hace reconciliación: crea lo que falta, renombra/actualiza
//! lo que cambió y borra lo que sobró (primero terminales, después sesiones y
//! al final workspaces, respetando el cascade del server). Cualquier respuesta
//! que no sea 2xx corta el guardado con error: nunca se reporta éxito a
//! medias, y repetir el guardado es seguro porque los ids son idempotentes.

use std::sync::Arc;
use std::time::Duration;

use application::agent_detection::KnownAgent;
use application::ports::{AccessTokenProvider, PortError, SnapshotStore};
use application::storage::{StoredPane, StoredSession, StoredWorkspace, WorkspaceSnapshot};
use domain::AgentProfile;
use serde::Deserialize;
use uuid::Uuid;

/// Tope por pedido HTTP: la API puede tardar, pero no debe dejar la llamada
/// bloqueada infinitamente (corre fuera del hilo de la UI).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Espacio de nombres congelado para derivar UUID v5 de ids locales. Es un
/// valor arbitrario: cambiarlo rompería la relación id local → recurso del
/// server ya guardada (los recursos dejarían de encontrarse entre corridas).
const LOCAL_ID_NAMESPACE: Uuid = Uuid::from_bytes([
    0x63, 0x2f, 0x9c, 0x11, 0x7f, 0x5e, 0x4d, 0x1c, 0xa2, 0xb5, 0x3e, 0x87, 0x90, 0xd6, 0xf4, 0x55,
]);

/// UUID del server para un id local: si el id ya es UUID viaja tal cual (en
/// su forma canónica); si no, deriva un UUID v5 del string. Mismo id local
/// produce siempre el mismo UUID, entre corridas y máquinas.
pub fn local_id_to_server_uuid(local_id: &str) -> String {
    Uuid::parse_str(local_id)
        .unwrap_or_else(|_| Uuid::new_v5(&LOCAL_ID_NAMESPACE, local_id.as_bytes()))
        .to_string()
}

/// Lo que la API devuelve de una terminal. Los campos que pueden no venir se
/// toleran ausentes con `#[serde(default)]`: la API es más nueva que el
/// desktop posible, no al revés.
#[derive(Debug, Clone, Deserialize)]
struct ApiTerminal {
    id: String,
    name: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    minimized: bool,
}

#[derive(Debug, Deserialize)]
struct ApiSession {
    id: String,
    name: String,
    #[serde(default)]
    terminals: Vec<ApiTerminal>,
}

/// Resumen en `GET /workspaces` con las sesiones expandidas (es lo que una
/// reconciliación necesita comparar contra el estado del server).
#[derive(Debug, Deserialize)]
struct ApiWorkspace {
    id: String,
    name: String,
    #[serde(default)]
    sessions: Vec<ApiSession>,
}

/// Perfil de arranque derivado de un panel: lo que la API guarda como
/// `name`/`command`/`args` y que el snapshot local no persiste.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TerminalIdentity {
    name: String,
    command: String,
    args: Vec<String>,
}

/// Perfil determinista de un panel. Con un agente conocido, el perfil es el
/// comando base con el que se lanza (sin los argumentos que cada adaptador
/// agrega por corrida, que llevan destinos y secretos de la sesión: A1).
/// Sin agente —o con un id que la versión actual no conoce— es la shell por
/// defecto, igual que hace la UI al restaurar: un agente removido cae a
/// shell plana en vez de romper.
fn terminal_identity(pane: &StoredPane) -> TerminalIdentity {
    match pane.agent.as_deref().and_then(KnownAgent::from_id) {
        Some(agent) => TerminalIdentity {
            name: agent.id().to_string(),
            command: agent.launch_command().to_string(),
            args: Vec::new(),
        },
        None => {
            let shell: AgentProfile = crate::default_shell_profile(None);
            TerminalIdentity {
                name: shell.name,
                command: shell.command,
                args: shell.args,
            }
        }
    }
}

/// Resultado de un intento HTTP.
enum Attempt {
    /// Respuesta 2xx con el cuerpo ya leído.
    Ok(String),
    /// El server contestó un 4xx/5xx: `ureq::Error::StatusCode` trae el número.
    Status(u16),
    /// Cualquier otro problema (red, URI, cuerpo ilegible).
    Failure(String),
}

pub struct CloudSnapshotStore {
    base_url: String,
    agent: ureq::Agent,
    tokens: Arc<dyn AccessTokenProvider>,
}

impl CloudSnapshotStore {
    pub fn new(base_url: impl Into<String>, tokens: Arc<dyn AccessTokenProvider>) -> Self {
        Self {
            // Sin `/` final: los paths se pegan con `/workspaces` y una barra
            // doble cambiaría la ruta.
            base_url: base_url.into().trim_end_matches('/').to_string(),
            agent: ureq::Agent::config_builder()
                .timeout_global(Some(REQUEST_TIMEOUT))
                .build()
                .into(),
            tokens,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    /// Un intento HTTP con un token dado. Los 4xx/5xx no se leen como cuerpo:
    /// llegan como `Attempt::Status` con el número, para decidir si es un 401
    /// refrescable.
    fn attempt(&self, method: &str, url: &str, token: &str, body: Option<&str>) -> Attempt {
        let builder = ureq::http::Request::builder()
            .method(method)
            .uri(url)
            .header("Authorization", format!("Bearer {token}"));
        let outcome = match body {
            Some(body) => {
                let request = builder
                    .header("Content-Type", "application/json")
                    .body(body.to_string());
                match request {
                    Ok(request) => self.agent.run(request),
                    Err(e) => return Attempt::Failure(format!("pedido inválido: {e}")),
                }
            }
            None => {
                let request = builder.body(());
                match request {
                    Ok(request) => self.agent.run(request),
                    Err(e) => return Attempt::Failure(format!("pedido inválido: {e}")),
                }
            }
        };
        match outcome {
            Ok(mut response) => match response.body_mut().read_to_string() {
                Ok(text) => Attempt::Ok(text),
                Err(e) => Attempt::Failure(format!("respuesta ilegible: {e}")),
            },
            Err(ureq::Error::StatusCode(status)) => Attempt::Status(status),
            Err(e) => Attempt::Failure(format!("{e}")),
        }
    }

    /// Un pedido contra la API: obtiene un token por pedido y, ante 401, fuerza
    /// un refresh (una sola vez) y reintenta el pedido idéntico con el token
    /// nuevo. Todo otro error es `PortError`; el error nunca se reporta como
    /// éxito a las capas de arriba.
    fn call(&self, method: &str, path: &str, body: Option<&str>) -> Result<String, PortError> {
        let url = self.url(path);
        let token = self.tokens.access_token()?;
        match self.attempt(method, &url, &token, body) {
            Attempt::Ok(text) => Ok(text),
            Attempt::Status(401) => {
                let token = self.tokens.refreshed_access_token()?;
                match self.attempt(method, &url, &token, body) {
                    Attempt::Ok(text) => Ok(text),
                    Attempt::Status(status) => Err(PortError::new(format!(
                        "la API rechazó el pedido ({status}) después de refrescar: {method} {path}"
                    ))),
                    Attempt::Failure(reason) => Err(PortError::new(format!(
                        "falló el pedido {method} {path} en el reintento: {reason}"
                    ))),
                }
            }
            Attempt::Status(status) => Err(PortError::new(format!(
                "la API rechazó el pedido ({status}): {method} {path}"
            ))),
            Attempt::Failure(reason) => Err(PortError::new(format!(
                "falló el pedido {method} {path}: {reason}"
            ))),
        }
    }

    /// Estado actual del server: workspaces con las sesiones de cada uno
    /// expandidas. Cualquier respuesta inválida es error: nunca se reconcilia
    /// contra datos bajo-informados (borrar por error una nube despoblada es
    /// irreversible; una lectura fallida no es una estructura vacía).
    fn fetch_current(&self) -> Result<Vec<ApiWorkspace>, PortError> {
        let raw = self.call("GET", "/workspaces", None)?;
        let mut workspaces: Vec<ApiWorkspace> = serde_json::from_str(&raw)
            .map_err(|e| PortError::new(format!("respuesta de /workspaces inválida: {e}")))?;
        for workspace in &mut workspaces {
            let raw = self.call(
                "GET",
                &format!("/workspaces/{}/sessions", workspace.id),
                None,
            )?;
            workspace.sessions = serde_json::from_str(&raw).map_err(|e| {
                PortError::new(format!(
                    "respuesta de /workspaces/{}/sessions inválida: {e}",
                    workspace.id
                ))
            })?;
        }
        Ok(workspaces)
    }

    /// Crea, actualiza y ordena las terminales de la sesión deseada contra
    /// `current` (lo que hoy está en el server).
    fn reconcile_terminals(
        &self,
        session_path: &str,
        session: &StoredSession,
        current: &[ApiTerminal],
    ) -> Result<(), PortError> {
        // Huerfanas primero: el PUT de orden pide "exactamente las terminales
        // de la sesión", así que ninguna huérfana puede seguir viva ahí.
        let desired_ids: Vec<String> = session
            .panes
            .iter()
            .map(|pane| local_id_to_server_uuid(&pane.id))
            .collect();
        let mut order_changed = false;
        for terminal in current {
            if !desired_ids.iter().any(|id| id == &terminal.id) {
                self.call(
                    "DELETE",
                    &format!("{session_path}/terminals/{}", terminal.id),
                    None,
                )?;
                order_changed = true;
            }
        }
        // Creaciones y updates de las deseadas, en el orden visual deseado
        // (el server agrega al final: el PUT de orden termina de fijarlo).
        for pane in &session.panes {
            let terminal_id = local_id_to_server_uuid(&pane.id);
            let identity = terminal_identity(pane);
            let location = current.iter().find(|termino| termino.id == terminal_id);
            match location {
                None => {
                    self.create_terminal(session_path, &terminal_id, pane, &identity)?;
                    order_changed = true;
                }
                Some(server_terminal) => {
                    if let Some(body) = terminal_patch(server_terminal, pane, &identity) {
                        self.call(
                            "PATCH",
                            &format!("{session_path}/terminals/{terminal_id}"),
                            Some(&body),
                        )?;
                    }
                }
            }
        }
        // Orden visual: manda el array completo con los ids deseados solo si
        // el orden actual difiere, o cambió la composición de la sesión (un
        // create/delete reordena el array del server de todos modos).
        let current_order: Vec<&str> = current.iter().map(|t| t.id.as_str()).collect();
        let desired_order: Vec<&str> = desired_ids.iter().map(String::as_str).collect();
        if order_changed || current_order != desired_order {
            let ids = serde_json::json!({ "ids": desired_ids }).to_string();
            self.call(
                "PUT",
                &format!("{session_path}/terminals/order"),
                Some(&ids),
            )?;
        }
        Ok(())
    }

    /// POST de una terminal nueva: con id explícito (idempotente) y el perfil
    /// derivado. Los campos nulos no viajan: el server ya los tiene por
    /// default y un null explícito no agrega nada.
    fn create_terminal(
        &self,
        session_path: &str,
        terminal_id: &str,
        pane: &StoredPane,
        identity: &TerminalIdentity,
    ) -> Result<(), PortError> {
        let mut body = serde_json::Map::new();
        body.insert("id".into(), serde_json::json!(terminal_id));
        body.insert("name".into(), serde_json::json!(identity.name));
        body.insert("command".into(), serde_json::json!(identity.command));
        body.insert("args".into(), serde_json::json!(identity.args));
        if let Some(cwd) = &pane.initial_cwd {
            body.insert("cwd".into(), serde_json::json!(cwd));
        }
        if let Some(agent) = &pane.agent {
            body.insert("agent".into(), serde_json::json!(agent));
        }
        if pane.minimized {
            body.insert("minimized".into(), serde_json::json!(true));
        }
        let body = serde_json::Value::Object(body).to_string();
        self.call("POST", &format!("{session_path}/terminals"), Some(&body))?;
        Ok(())
    }

    /// POST de una sesión nueva dentro de un workspace (id idempotente + nombre).
    fn create_session(&self, wid: &str, sid: &str, name: &str) -> Result<(), PortError> {
        self.call(
            "POST",
            &format!("/workspaces/{wid}/sessions"),
            Some(&serde_json::json!({ "id": sid, "name": name }).to_string()),
        )?;
        Ok(())
    }
}

/// Diferencia entre la terminal del server y el panel deseado: solo los
/// campos que cambian viajan en el PATCH (la API es partial). Un null
/// explícito es la forma de quitar el valor guardado.
fn terminal_patch(
    server: &ApiTerminal,
    pane: &StoredPane,
    identity: &TerminalIdentity,
) -> Option<String> {
    let mut changed = serde_json::Map::new();
    if server.name != identity.name {
        changed.insert("name".into(), serde_json::json!(identity.name));
    }
    if server.command != identity.command {
        changed.insert("command".into(), serde_json::json!(identity.command));
    }
    if server.args != identity.args {
        changed.insert("args".into(), serde_json::json!(identity.args));
    }
    if server.cwd.as_deref() != pane.initial_cwd.as_deref() {
        changed.insert("cwd".into(), serde_json::json!(pane.initial_cwd));
    }
    if server.agent.as_deref() != pane.agent.as_deref() {
        changed.insert("agent".into(), serde_json::json!(pane.agent));
    }
    if server.minimized != pane.minimized {
        changed.insert("minimized".into(), serde_json::json!(pane.minimized));
    }
    (!changed.is_empty()).then(|| serde_json::Value::Object(changed).to_string())
}

impl SnapshotStore for CloudSnapshotStore {
    fn load_snapshot(&self) -> Result<Option<WorkspaceSnapshot>, PortError> {
        let current = self.fetch_current()?;
        if current.is_empty() {
            // Cuenta sin workspaces = primera corrida en la nube: arranque
            // limpio (la UI arma su default y lo guarda después), tal como
            // sucede en modo local sin archivo.
            return Ok(None);
        }
        let workspaces = current
            .into_iter()
            .map(|workspace| StoredWorkspace {
                id: workspace.id,
                name: workspace.name,
                sessions: workspace
                    .sessions
                    .into_iter()
                    .map(|session| StoredSession {
                        id: session.id,
                        name: session.name,
                        panes: session
                            .terminals
                            .into_iter()
                            .enumerate()
                            .map(|(index, terminal)| StoredPane {
                                id: terminal.id,
                                seq: index as u64,
                                minimized: terminal.minimized,
                                initial_cwd: terminal.cwd,
                                agent: terminal.agent,
                            })
                            .collect(),
                    })
                    .collect(),
            })
            .collect();
        Ok(Some(WorkspaceSnapshot::new(workspaces)))
    }

    fn save_snapshot(&self, snapshot: &WorkspaceSnapshot) -> Result<(), PortError> {
        let current = self.fetch_current()?;
        let desired_ws: Vec<String> = snapshot
            .workspaces
            .iter()
            .map(|workspace| local_id_to_server_uuid(&workspace.id))
            .collect();

        // Fase 1: crear/actualizar lo deseado, workspace por workspace. Si el
        // workspace no está en la nube, se crea con sus sesiones desde cero.
        for workspace in &snapshot.workspaces {
            let wid = local_id_to_server_uuid(&workspace.id);
            let born = current.iter().find(|w| w.id == wid).is_none();
            if born {
                self.call(
                    "POST",
                    "/workspaces",
                    Some(
                        &serde_json::json!({
                            "id": wid,
                            "name": workspace.name,
                        })
                        .to_string(),
                    ),
                )?;
            } else {
                let server_workspace = current
                    .iter()
                    .find(|w| w.id == wid)
                    .expect("existía en el fetch");
                if server_workspace.name != workspace.name {
                    self.call(
                        "PATCH",
                        &format!("/workspaces/{wid}"),
                        Some(&serde_json::json!({ "name": workspace.name }).to_string()),
                    )?;
                }
            }
            for session in &workspace.sessions {
                let sid = local_id_to_server_uuid(&session.id);
                let server_session = if born {
                    None
                } else {
                    let server_workspace = current
                        .iter()
                        .find(|w| w.id == wid)
                        .expect("existía en el fetch");
                    server_workspace.sessions.iter().find(|s| s.id == sid)
                };
                match server_session {
                    None => self.create_session(&wid, &sid, &session.name)?,
                    Some(server_session) => {
                        if server_session.name != session.name {
                            self.call(
                                "PATCH",
                                &format!("/sessions/{sid}"),
                                Some(&serde_json::json!({ "name": session.name }).to_string()),
                            )?;
                        }
                    }
                }
                let current_terminals: Vec<ApiTerminal> = match server_session {
                    Some(server_session) => server_session.terminals.clone(),
                    None => Vec::new(),
                };
                self.reconcile_terminals(&format!("/sessions/{sid}"), session, &current_terminals)?;
            }
        }

        // Fase 2: sesiones que sobraron en workspaces conservados. Las
        // terminales huérfanas de una sesión conservada ya salieron en la
        // fase 1 (la reconciliación borrarlas antes de fijar el orden, para
        // que el PUT cuente la composición definitiva); la de una sesión
        // enteramente huérfana viaja con el cascade del DELETE de la sesión.
        for server_workspace in &current {
            if !desired_ws.iter().any(|id| id == &server_workspace.id) {
                continue;
            }
            let desired = snapshot
                .workspaces
                .iter()
                .find(|w| local_id_to_server_uuid(&w.id) == server_workspace.id)
                .expect("el workspace conservado está en el snapshot");
            for server_session in &server_workspace.sessions {
                let wanted = desired
                    .sessions
                    .iter()
                    .any(|s| local_id_to_server_uuid(&s.id) == server_session.id);
                if !wanted {
                    self.call("DELETE", &format!("/sessions/{}", server_session.id), None)?;
                }
            }
        }

        // Fase 3: workspaces que el snapshot ya no menciona. Cada uno arrastra
        // sus sesiones y terminales por cascade (204).
        for server_workspace in &current {
            if !desired_ws.iter().any(|id| id == &server_workspace.id) {
                self.call(
                    "DELETE",
                    &format!("/workspaces/{}", server_workspace.id),
                    None,
                )?;
            }
        }
        Ok(())
    }
}

/// POST de una sesión nueva dentro de un workspace (id idempotente + nombre).
#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpListener, TcpStream};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use std::thread;

    use application::storage::SNAPSHOT_VERSION;
    use serde_json::{json, Value};

    use super::*;

    // -------------------------------------------------------------- mock --

    /// Pedido HTTP registrado por el servidor de mentira, con lo que los
    /// asserts necesitan mirar: método, ruta, token y cuerpo.
    #[derive(Debug, Clone, PartialEq)]
    struct Recorded {
        method: String,
        path: String,
        auth: Option<String>,
        content_type: Option<String>,
        body: String,
    }

    struct MockReply {
        status: u16,
        body: String,
    }

    /// Respuesta `200` con JSON de cuerpo.
    fn ok_reply(body: Value) -> MockReply {
        MockReply {
            status: 200,
            body: body.to_string(),
        }
    }

    /// Respuesta de error con el cuerpo genérico de la API.
    fn error_reply(status: u16) -> MockReply {
        MockReply {
            status,
            body: r#"{"error":{"code":"X","message":"no"}}"#.to_string(),
        }
    }

    /// Servidor HTTP de mentira: `replies[i]` responde al pedido i (en orden
    /// de llegada); lo que supera el guión recibe 500. Cada pedido vive en su
    /// propia conexión (`connection: close`) y todos quedan registrados.
    struct MockServer {
        addr: String,
        requests: Arc<Mutex<Vec<Recorded>>>,
    }

    impl MockServer {
        fn start(replies: Vec<MockReply>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap().to_string();
            let requests: Arc<Mutex<Vec<Recorded>>> = Arc::new(Mutex::new(Vec::new()));
            let requests_for_thread = Arc::clone(&requests);
            let queue: Mutex<VecDeque<MockReply>> = Mutex::new(replies.into_iter().collect());
            thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
                    if let Some(recorded) = read_request(&mut stream) {
                        {
                            let mut all = requests_for_thread.lock().expect("mock");
                            all.push(recorded);
                        }
                        let reply = queue
                            .lock()
                            .expect("mock")
                            .pop_front()
                            .unwrap_or_else(|| error_reply(500));
                        write_reply(&mut stream, &reply);
                    }
                    let _ = stream.shutdown(Shutdown::Both);
                }
            });
            Self { addr, requests }
        }

        fn url(&self) -> String {
            format!("http://{}", self.addr)
        }

        fn requests(&self) -> Vec<Recorded> {
            self.requests.lock().expect("mock").clone()
        }

        fn count(&self) -> usize {
            self.requests.lock().expect("mock").len()
        }
    }

    /// Lee un pedido HTTP del stream: headers y body según Content-Length.
    fn read_request(stream: &mut TcpStream) -> Option<Recorded> {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            if let Some(recorded) = try_parse(&buf) {
                return Some(recorded);
            }
            match stream.read(&mut chunk) {
                Ok(0) => return try_parse(&buf),
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
                Err(_) => return None,
            }
        }
    }

    /// Parsea el pedido solo si ya está completo; `None` mientras falte leer.
    fn try_parse(buf: &[u8]) -> Option<Recorded> {
        let headers_end = buf.windows(4).position(|w| w == b"\r\n\r\n")? + 4;
        let head = String::from_utf8_lossy(&buf[..headers_end]);
        let head = &head[..head.len() - 4];
        let mut lines = head.lines();
        let request_line = lines.next()?;
        let mut parts = request_line.split_whitespace();
        let method = parts.next()?.to_string();
        let path = parts.next()?.to_string();
        let mut auth = None;
        let mut content_type = None;
        let mut content_length = 0usize;
        for line in lines {
            let (key, value) = line.split_once(':')?;
            let key = key.trim().to_ascii_lowercase();
            let value = value.trim();
            match key.as_str() {
                "authorization" => auth = Some(value.to_string()),
                "content-type" => content_type = Some(value.to_string()),
                "content-length" => content_length = value.parse::<usize>().ok()?,
                _ => {}
            }
        }
        let needed = headers_end + content_length;
        if buf.len() < needed {
            return None;
        }
        let body = String::from_utf8_lossy(&buf[headers_end..needed]).to_string();
        Some(Recorded {
            method,
            path,
            auth,
            content_type,
            body,
        })
    }

    fn write_reply(stream: &mut TcpStream, reply: &MockReply) {
        if reply.status == 204 {
            let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nconnection: close\r\n\r\n");
            return;
        }
        let reason = match reply.status {
            200 => "OK",
            201 => "Created",
            400 => "Bad Request",
            401 => "Unauthorized",
            403 => "Forbidden",
            404 => "Not Found",
            409 => "Conflict",
            500 => "Internal Server Error",
            _ => "Status",
        };
        let head = format!(
            "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            reply.body.len(),
            status = reply.status,
        );
        let _ = stream.write_all(head.as_bytes());
        let _ = stream.write_all(reply.body.as_bytes());
    }

    // ------------------------------------------------------------- fakes --

    /// Proveedor con dos tokens: el corriente ("tok-1") y el que entrega el
    /// refresh forzado ("tok-2"). Anota los refreshes para los asserts; el
    /// `Clone` comparte el contador vía `Arc`.
    #[derive(Clone)]
    struct FakeTokens {
        refreshes: Arc<AtomicUsize>,
    }

    impl FakeTokens {
        fn new() -> Self {
            Self {
                refreshes: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn refresh_count(&self) -> usize {
            self.refreshes.load(Ordering::SeqCst)
        }
    }

    impl AccessTokenProvider for FakeTokens {
        fn access_token(&self) -> Result<String, PortError> {
            Ok("tok-1".to_string())
        }

        fn refreshed_access_token(&self) -> Result<String, PortError> {
            self.refreshes.fetch_add(1, Ordering::SeqCst);
            Ok("tok-2".to_string())
        }
    }

    fn tokens() -> Arc<FakeTokens> {
        Arc::new(FakeTokens::new())
    }

    fn store(server: &MockServer) -> CloudSnapshotStore {
        CloudSnapshotStore::new(server.url(), tokens())
    }

    // ---------------------------------------------------------- fixtures --

    /// Snapshot deseado de prueba: ws-1 "OpenCollab", sesión s-1 "Sesión 1",
    /// dos paneles (agente claude-code con cwd; shell minimizada).
    fn desired() -> WorkspaceSnapshot {
        WorkspaceSnapshot::new(vec![StoredWorkspace {
            id: "ws-1".into(),
            name: "OpenCollab".into(),
            sessions: vec![StoredSession {
                id: "session-1".into(),
                name: "Sesión 1".into(),
                panes: vec![
                    StoredPane {
                        id: "pane-1".into(),
                        seq: 0,
                        minimized: false,
                        initial_cwd: Some("C:\\repo".into()),
                        agent: Some("claude-code".into()),
                    },
                    StoredPane {
                        id: "pane-2".into(),
                        seq: 1,
                        minimized: true,
                        initial_cwd: None,
                        agent: None,
                    },
                ],
            }],
        }])
    }

    /// Entrada de `GET /workspaces` (el view del server lleva campos de más:
    /// el mapeo solo toma lo que usa).
    fn workspace_entry(id: &str, name: &str) -> Value {
        json!({ "id": id, "name": name, "owner": "u1", "memberCount": 1 })
    }

    /// View de terminal del server construido con el mismo perfil derivado,
    /// para que los asserts de negocio vean solo lo que cambia de verdad.
    fn server_terminal(pane: &StoredPane) -> Value {
        let identity = terminal_identity(pane);
        json!({
            "id": local_id_to_server_uuid(&pane.id),
            "name": identity.name,
            "command": identity.command,
            "args": identity.args,
            "cwd": pane.initial_cwd,
            "agent": pane.agent,
            "minimized": pane.minimized,
        })
    }

    fn server_session(id: &str, name: &str, terminals: Vec<Value>) -> Value {
        json!({ "id": id, "name": name, "terminals": terminals })
    }

    /// Terminal "ajena": un perfil que no corresponde con nada deseado.
    fn stray_terminal(id: &str, name: &str) -> Value {
        json!({
            "id": id,
            "name": name,
            "command": "cmd",
            "args": [],
            "cwd": null,
            "agent": null,
            "minimized": false,
        })
    }

    // -------------------------------------------------------------- tests --

    #[test]
    fn la_derivacion_es_estable_y_los_uuid_viajan_tal_cual() {
        // Mismo id local → mismo UUID siempre, entre llamadas e instancias.
        let first = local_id_to_server_uuid("ws-1");
        assert_eq!(first, local_id_to_server_uuid("ws-1"));
        // Es un UUID y no es el id local crudo.
        assert!(Uuid::parse_str(&first).is_ok());
        assert_ne!(first, "ws-1");
        // Dos ids locales distintos no colisionan.
        assert_ne!(first, local_id_to_server_uuid("session-1"));
        // Un id que ya es UUID viaja igual (forma canónica en minúsculas).
        assert_eq!(
            local_id_to_server_uuid("E4E0F07E-8B3E-4DC2-A1F0-5B2C9D01AA33"),
            "e4e0f07e-8b3e-4dc2-a1f0-5b2c9d01aa33"
        );
        assert_eq!(
            local_id_to_server_uuid("e4e0f07e-8b3e-4dc2-a1f0-5b2c9d01aa33"),
            "e4e0f07e-8b3e-4dc2-a1f0-5b2c9d01aa33"
        );
    }

    #[test]
    fn load_mapea_views_de_la_api_al_snapshot() {
        let wid = local_id_to_server_uuid("ws-1");
        let sid = local_id_to_server_uuid("session-1");
        let tid1 = local_id_to_server_uuid("pane-1");
        let tid2 = local_id_to_server_uuid("pane-2");
        let server = MockServer::start(vec![
            ok_reply(json!([workspace_entry(&wid, "Cloud")])),
            ok_reply(json!([{
                "id": sid,
                "name": "Trabajo",
                "terminals": [
                    {
                        "id": tid1,
                        "name": "Claude Code",
                        "command": "claude",
                        "args": ["--resume"],
                        "cwd": "C:\\repo",
                        "agent": "claude-code",
                        "minimized": false,
                    },
                    {
                        "id": tid2,
                        "name": "PowerShell",
                        "command": "powershell.exe",
                        "args": [],
                        "cwd": null,
                        "agent": null,
                        "minimized": true,
                    },
                ],
            }])),
        ]);
        let cloud = store(&server);

        let loaded = cloud.load_snapshot().unwrap().expect("hay snapshot");

        assert_eq!(loaded.version, SNAPSHOT_VERSION);
        assert_eq!(loaded.workspaces.len(), 1);
        let workspace = &loaded.workspaces[0];
        assert_eq!(workspace.id, wid);
        assert_eq!(workspace.name, "Cloud");
        assert_eq!(workspace.sessions.len(), 1);
        let session = &workspace.sessions[0];
        assert_eq!(session.name, "Trabajo");
        // Orden visual = orden del array del view; seq = posición en él.
        assert_eq!(session.panes.len(), 2);
        assert_eq!(
            session.panes[0],
            StoredPane {
                id: tid1,
                seq: 0,
                minimized: false,
                initial_cwd: Some("C:\\repo".into()),
                agent: Some("claude-code".into()),
            }
        );
        assert_eq!(
            session.panes[1],
            StoredPane {
                id: tid2,
                seq: 1,
                minimized: true,
                initial_cwd: None,
                agent: None,
            }
        );
        // Dos pedidos: la lista y las sesiones del workspace leído.
        let all = server.requests();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].method, "GET");
        assert_eq!(all[0].path, "/workspaces");
        assert_eq!(all[0].auth.as_deref(), Some("Bearer tok-1"));
        assert_eq!(
            all[1].path,
            format!("/workspaces/{wid}/sessions"),
            "el GET de sesiones usa el id del workspace"
        );
    }

    #[test]
    fn load_de_una_cuenta_vacia_es_arranque_limpio() {
        let server = MockServer::start(vec![ok_reply(json!([]))]);
        let cloud = store(&server);
        assert_eq!(cloud.load_snapshot().unwrap(), None);
        assert_eq!(server.count(), 1, "con la lista vacía no se pide más");
    }

    #[test]
    fn save_crea_lo_que_falta_con_datos_explicitos() {
        let wid = local_id_to_server_uuid("ws-1");
        let sid = local_id_to_server_uuid("session-1");
        let tid1 = local_id_to_server_uuid("pane-1");
        let tid2 = local_id_to_server_uuid("pane-2");
        // Nube vacía: la reconciliación crea todo. Los creates contestan 200
        // (recurso ya existía: el caso idempotente del contrato) sin drama.
        let server = MockServer::start(vec![
            ok_reply(json!([])),
            ok_reply(json!({})),
            ok_reply(json!({})),
            ok_reply(json!({})),
            ok_reply(json!({})),
            ok_reply(json!({})),
        ]);
        let cloud = store(&server);
        cloud.save_snapshot(&desired()).unwrap();

        let all = server.requests();
        let shapes: Vec<(String, String)> = all
            .iter()
            .map(|r| (r.method.clone(), r.path.clone()))
            .collect();
        assert_eq!(
            shapes,
            vec![
                ("GET".into(), "/workspaces".into()),
                ("POST".into(), "/workspaces".into()),
                ("POST".into(), format!("/workspaces/{wid}/sessions")),
                ("POST".into(), format!("/sessions/{sid}/terminals")),
                ("POST".into(), format!("/sessions/{sid}/terminals")),
                ("PUT".into(), format!("/sessions/{sid}/terminals/order")),
            ]
        );
        assert_eq!(all[0].auth.as_deref(), Some("Bearer tok-1"));

        let ws_body: Value = serde_json::from_str(&all[1].body).unwrap();
        assert_eq!(all[1].content_type.as_deref(), Some("application/json"));
        assert_eq!(ws_body["id"], Value::String(wid));
        assert_eq!(ws_body["name"], "OpenCollab");

        let session_body: Value = serde_json::from_str(&all[2].body).unwrap();
        assert_eq!(session_body["id"], Value::String(sid.clone()));
        assert_eq!(session_body["name"], "Sesión 1");

        // Panel con agente conocido: el perfil es el comando base del agente
        // (sin los argumentos que cada adaptador agrega por corrida: A1).
        let agent_body: Value = serde_json::from_str(&all[3].body).unwrap();
        assert_eq!(agent_body["id"], Value::String(tid1.clone()));
        assert_eq!(agent_body["name"], "claude-code");
        assert_eq!(agent_body["command"], "claude");
        assert_eq!(agent_body["args"], json!([]));
        assert_eq!(agent_body["agent"], "claude-code");
        assert_eq!(agent_body["cwd"], "C:\\repo");
        // `minimized` falso no viaja: el server ya lo tiene por default.
        assert!(agent_body.get("minimized").is_none());

        // Shell plana: el perfil derivado es la shell por defecto del sistema.
        let shell = crate::default_shell_profile(None);
        let shell_body: Value = serde_json::from_str(&all[4].body).unwrap();
        assert_eq!(shell_body["id"], Value::String(tid2.clone()));
        assert_eq!(shell_body["name"], Value::String(shell.name.clone()));
        assert_eq!(shell_body["command"], Value::String(shell.command.clone()));
        assert_eq!(shell_body["args"], json!(shell.args));
        assert_eq!(shell_body["minimized"], true);
        // Los nulos no viajan: el server ya los tiene por default.
        assert!(shell_body.get("cwd").is_none(), "cwd nulo no viaja");
        assert!(shell_body.get("agent").is_none(), "agent nulo no viaja");

        let order: Value = serde_json::from_str(&all[5].body).unwrap();
        assert_eq!(order, json!({ "ids": [tid1, tid2] }));
    }

    #[test]
    fn save_renombra_y_actualiza_solo_lo_cambiado() {
        let wid = local_id_to_server_uuid("ws-1");
        let sid = local_id_to_server_uuid("session-1");
        let tid1 = local_id_to_server_uuid("pane-1");
        let tid2 = local_id_to_server_uuid("pane-2");
        // Server: mismos recursos con nombres viejos y el cwd de pane-1 vacío.
        // El resto del perfil de pane-1 ya coincide: no se PATCHea.
        let server = MockServer::start(vec![
            ok_reply(json!([workspace_entry(&wid, "viejo")])),
            ok_reply(json!([{
                "id": sid,
                "name": "vieja sesión",
                "terminals": [{
                    "id": tid1,
                    "name": "claude-code",
                    "command": "claude",
                    "args": [],
                    "cwd": null,
                    "agent": "claude-code",
                    "minimized": false,
                }],
            }])),
            ok_reply(json!({})),
            ok_reply(json!({})),
            ok_reply(json!({})),
            ok_reply(json!({})),
            ok_reply(json!({})),
        ]);
        let cloud = store(&server);
        cloud.save_snapshot(&desired()).unwrap();

        // Esperado: lectura (workspaces + sesiones), PATCH ws, PATCH sesión,
        // PATCH pane-1 (cwd), create pane-2, PUT de orden.
        let all = server.requests();
        let shapes: Vec<(String, String)> = all
            .iter()
            .map(|r| (r.method.clone(), r.path.clone()))
            .collect();
        assert_eq!(
            shapes,
            vec![
                ("GET".into(), "/workspaces".into()),
                ("GET".into(), format!("/workspaces/{wid}/sessions")),
                ("PATCH".into(), format!("/workspaces/{wid}")),
                ("PATCH".into(), format!("/sessions/{sid}")),
                ("PATCH".into(), format!("/sessions/{sid}/terminals/{tid1}")),
                ("POST".into(), format!("/sessions/{sid}/terminals")),
                ("PUT".into(), format!("/sessions/{sid}/terminals/order")),
            ]
        );

        let ws_patch: Value = serde_json::from_str(&all[2].body).unwrap();
        assert_eq!(ws_patch, json!({"name": "OpenCollab"}));
        let session_patch: Value = serde_json::from_str(&all[3].body).unwrap();
        assert_eq!(session_patch, json!({"name": "Sesión 1"}));

        // pane-1 existe y solo cambia su cwd; pane-2 (nuevo) se crea después.
        let patched: Value = serde_json::from_str(&all[4].body).unwrap();
        assert_eq!(patched, json!({"cwd": "C:\\repo"}));
        let created: Value = serde_json::from_str(&all[5].body).unwrap();
        assert_eq!(created["id"], Value::String(tid2.clone()));
        assert_eq!(created["minimized"], true);

        let order: Value = serde_json::from_str(&all[6].body).unwrap();
        assert_eq!(order, json!({"ids": [tid1, tid2]}));
    }

    #[test]
    fn save_borra_huerfanos_terminales_sesiones_y_workspaces() {
        let wid = local_id_to_server_uuid("ws-1");
        let sid = local_id_to_server_uuid("session-1");
        let tid1 = local_id_to_server_uuid("pane-1");
        let tid2 = local_id_to_server_uuid("pane-2");
        let wid_b = local_id_to_server_uuid("ws-extra");
        let wid_c = "33333333-3333-4333-8333-333333333333";
        let sid_huerfana = "44444444-4444-4444-8444-444444444444";
        let terminal_huerfana = "55555555-5555-4555-8555-555555555555";
        let panes = desired().workspaces[0].sessions[0].panes.clone();

        let server = MockServer::start(vec![
            ok_reply(json!([
                workspace_entry(&wid, "OpenCollab"),
                workspace_entry(&wid_b, "extra"),
                workspace_entry(wid_c, "otro"),
            ])),
            ok_reply(json!([
                server_session(
                    &sid,
                    "Sesión 1",
                    vec![
                        server_terminal(&panes[0]),
                        stray_terminal(terminal_huerfana, "sobra"),
                    ]
                ),
                server_session(
                    sid_huerfana,
                    "huérfana",
                    vec![stray_terminal(
                        "66666666-6666-4666-8666-666666666666",
                        "de la sesión huérfana",
                    )],
                ),
            ])),
            ok_reply(json!([server_session(
                "77777777-7777-4777-8777-777777777777",
                "de otro workspace",
                vec![],
            )])),
            ok_reply(json!([])),
            ok_reply(json!({})), // create pane-2 (pane-1 ya coincide)
            ok_reply(json!({})), // PUT de orden (cambió la composición)
            ok_reply(json!({})), // DELETE terminal huérfana
            ok_reply(json!({})), // DELETE sesión huérfana
            ok_reply(json!({})), // DELETE ws_b
            ok_reply(json!({})), // DELETE ws_c
        ]);
        let cloud = store(&server);
        cloud.save_snapshot(&desired()).unwrap();

        let all = server.requests();
        let shapes: Vec<(String, String)> = all
            .iter()
            .map(|r| (r.method.clone(), r.path.clone()))
            .collect();
        assert_eq!(shapes.len(), 10, "{shapes:?}");
        // Fase 1, sesión conservada: DELETE de la terminal huérfana (primero
        // ojo: el PUT de orden pide exactamente las que deben quedar),
        // create de pane-2 y PUT con el orden final.
        assert_eq!(
            shapes[4],
            (
                "DELETE".into(),
                format!("/sessions/{sid}/terminals/{terminal_huerfana}")
            )
        );
        assert_eq!(
            shapes[5],
            ("POST".into(), format!("/sessions/{sid}/terminals"))
        );
        assert_eq!(
            shapes[6],
            ("PUT".into(), format!("/sessions/{sid}/terminals/order"))
        );
        let order: Value = serde_json::from_str(&all[6].body).unwrap();
        assert_eq!(order, json!({"ids": [tid1, tid2]}));
        // Fase 2: la sesión entera huérfana; su terminal no se borra por
        // pedido propio, el cascade de la sesión lo hace.
        assert_eq!(
            shapes[7],
            ("DELETE".into(), format!("/sessions/{sid_huerfana}"))
        );
        // Fase 3: los workspaces sobrantes, al final del todo.
        assert_eq!(shapes[8], ("DELETE".into(), format!("/workspaces/{wid_b}")));
        assert_eq!(shapes[9], ("DELETE".into(), format!("/workspaces/{wid_c}")));
        // El orden global(respetado en cascada): terminales → sesiones → workspaces.
        let explicit_terminal_deletes = shapes
            .iter()
            .filter(|(m, p)| m == "DELETE" && p.contains("/terminals/"))
            .count();
        assert_eq!(explicit_terminal_deletes, 1);
        let (x, y, z) = delete_order(&shapes);
        assert_eq!(x, 4, "primera DELETE de terminal");
        assert_eq!(y, 7, "primera DELETE de sesión");
        assert_eq!(z, 8, "primera DELETE de workspace");
        // El GET de sesiones tocó todos los workspaces del server.
        assert_eq!(
            shapes[2],
            ("GET".into(), format!("/workspaces/{wid_b}/sessions"))
        );
        assert_eq!(
            shapes[3],
            ("GET".into(), format!("/workspaces/{wid_c}/sessions"))
        );
    }

    /// Posiciones de la primera DELETE por cada nivel del cascade.
    fn delete_order(shapes: &[(String, String)]) -> (usize, usize, usize) {
        let terminal = shapes
            .iter()
            .position(|(m, p)| m == "DELETE" && p.contains("/terminals/"))
            .unwrap();
        let session = shapes
            .iter()
            .position(|(m, p)| {
                m == "DELETE" && p.starts_with("/sessions/") && !p.contains("/terminals/")
            })
            .unwrap();
        let workspace = shapes
            .iter()
            .position(|(m, p)| m == "DELETE" && p.starts_with("/workspaces/"))
            .unwrap();
        (terminal, session, workspace)
    }

    #[test]
    fn save_orden_distinto_manda_put_y_reconstruye_el_orden() {
        let wid = local_id_to_server_uuid("ws-1");
        let sid = local_id_to_server_uuid("session-1");
        let tid1 = local_id_to_server_uuid("pane-1");
        let tid2 = local_id_to_server_uuid("pane-2");
        let panes = desired().workspaces[0].sessions[0].panes.clone();
        let server = MockServer::start(vec![
            ok_reply(json!([workspace_entry(&wid, "OpenCollab")])),
            ok_reply(json!([server_session(
                &sid,
                "Sesión 1",
                vec![server_terminal(&panes[1]), server_terminal(&panes[0]),]
            )])),
            ok_reply(json!({})),
        ]);
        let cloud = store(&server);
        cloud.save_snapshot(&desired()).unwrap();

        // Solo el PUT: sin creates ni patches, los contenidos ya coinciden.
        let all = server.requests();
        let shapes: Vec<(String, String)> = all
            .iter()
            .map(|r| (r.method.clone(), r.path.clone()))
            .collect();
        assert_eq!(
            shapes,
            vec![
                ("GET".into(), "/workspaces".into()),
                ("GET".into(), format!("/workspaces/{wid}/sessions")),
                ("PUT".into(), format!("/sessions/{sid}/terminals/order")),
            ]
        );
        let order: Value = serde_json::from_str(&all[2].body).unwrap();
        assert_eq!(order, json!({"ids": [tid1, tid2]}));
    }

    #[test]
    fn save_con_orden_igual_no_manda_put() {
        let wid = local_id_to_server_uuid("ws-1");
        let sid = local_id_to_server_uuid("session-1");
        let panes = desired().workspaces[0].sessions[0].panes.clone();
        let server = MockServer::start(vec![
            ok_reply(json!([workspace_entry(&wid, "OpenCollab")])),
            ok_reply(json!([server_session(
                &sid,
                "Sesión 1",
                vec![server_terminal(&panes[0]), server_terminal(&panes[1]),]
            )])),
        ]);
        let cloud = store(&server);
        cloud.save_snapshot(&desired()).unwrap();
        assert_eq!(server.count(), 2, "sin cambios: solo las lecturas");
    }

    #[test]
    fn un_401_fuerza_un_refresh_y_reintenta_una_vez() {
        let tokens = FakeTokens::new();
        let wid = local_id_to_server_uuid("ws-1");
        let sid = local_id_to_server_uuid("session-1");
        let tid1 = local_id_to_server_uuid("pane-1");
        let server = MockServer::start(vec![
            error_reply(401),
            ok_reply(json!([workspace_entry(&wid, "Cloud")])),
            ok_reply(json!([server_session(
                &sid,
                "sesión",
                vec![json!({
                    "id": tid1,
                    "name": "x",
                    "command": "cmd",
                    "args": [],
                    "cwd": null,
                    "agent": null,
                    "minimized": false,
                })]
            )])),
        ]);
        let cloud = CloudSnapshotStore::new(server.url(), Arc::new(tokens.clone()));

        let loaded = cloud.load_snapshot().unwrap().expect("cargó tras el retry");
        assert_eq!(loaded.workspaces[0].name, "Cloud");
        assert_eq!(tokens.refresh_count(), 1, "un único refresh");

        let all = server.requests();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].path, "/workspaces");
        assert_eq!(all[1].path, "/workspaces");
        assert_eq!(all[0].auth.as_deref(), Some("Bearer tok-1"));
        assert_eq!(
            all[1].auth.as_deref(),
            Some("Bearer tok-2"),
            "el reintento lleva el token refrescado"
        );
    }

    #[test]
    fn un_segundo_401_tras_el_reintento_es_error() {
        let tokens = FakeTokens::new();
        let server = MockServer::start(vec![error_reply(401), error_reply(401)]);
        let cloud = CloudSnapshotStore::new(server.url(), Arc::new(tokens.clone()));

        let err = cloud.load_snapshot().unwrap_err();
        assert!(err.0.contains("401"), "{}", err.0);
        assert_eq!(tokens.refresh_count(), 1, "un solo refresh, sin loops");
        assert_eq!(server.count(), 2, "intento + reintento, nada más");
    }

    #[test]
    fn los_403_404_500_son_errores_sin_reintento_ni_refresh() {
        for status in [403u16, 404, 500] {
            let tokens = FakeTokens::new();
            let server = MockServer::start(vec![error_reply(status)]);
            let cloud = CloudSnapshotStore::new(server.url(), Arc::new(tokens.clone()));
            let err = cloud.load_snapshot().unwrap_err();
            assert!(err.0.contains(&status.to_string()), "{status}: {}", err.0);
            assert_eq!(tokens.refresh_count(), 0, "no hay refresh por un 401 ajeno");
            assert_eq!(server.count(), 1);
        }
    }

    #[test]
    fn json_malformado_es_error_sin_panico() {
        let server = MockServer::start(vec![MockReply {
            status: 200,
            body: "esto no es json".to_string(),
        }]);
        let cloud = store(&server);
        let err = cloud.load_snapshot().unwrap_err();
        assert!(err.0.contains("workspaces"), "{}", err.0);
        assert!(err.0.contains("inválida"), "{}", err.0);

        // Y con una lista de workspaces a la que le falta un campo fijo.
        let server2 = MockServer::start(vec![ok_reply(json!([{"name": "sin id"}]))]);
        let cloud2 = store(&server2);
        assert!(cloud2.load_snapshot().is_err());
    }

    #[test]
    fn un_fallo_de_lectura_no_reporta_exit_ni_borra() {
        let wid = local_id_to_server_uuid("ws-1");
        // La segunda lectura (sesiones del workspace) explota: no arrancó
        // ninguna escritura y no hay deletes que hagan daño.
        let server = MockServer::start(vec![
            ok_reply(json!([workspace_entry(&wid, "otra")])),
            error_reply(500),
        ]);
        let cloud = store(&server);
        let err = cloud.save_snapshot(&desired()).unwrap_err();
        assert!(err.0.contains("500"), "{}", err.0);
        let all = server.requests();
        assert!(
            all.iter().all(|r| r.method == "GET"),
            "ninguna escritura se mandó"
        );
    }

    #[test]
    fn un_fallo_a_la_mitad_del_save_corta_en_seco() {
        let sid = local_id_to_server_uuid("session-1");
        let tid1 = local_id_to_server_uuid("pane-1");
        let tid2 = local_id_to_server_uuid("pane-2");
        // El create del primer terminal explota a mitad de la fase 1: el
        // guardado es Err y ninguna fase posterior queda colgando.
        let server = MockServer::start(vec![
            ok_reply(json!([])),
            ok_reply(json!({})),
            ok_reply(json!({})),
            error_reply(500),
        ]);
        let cloud = store(&server);
        let err = cloud.save_snapshot(&desired()).unwrap_err();
        assert!(err.0.contains("500"), "{}", err.0);
        let all = server.requests();
        assert_eq!(all.len(), 4, "ni un pedido más después del fallo");
        assert_eq!(all[3].method, "POST");
        assert_eq!(all[3].path, format!("/sessions/{sid}/terminals"));
        assert!(
            !all.iter()
                .any(|r| r.method == "DELETE" || r.path.contains("/order")),
            "sin deletes ni PUT colgado"
        );
        let _ = (tid1, tid2);
    }

    #[test]
    fn guardar_un_snapshot_vacio_borra_todos_los_workspaces() {
        let wid = local_id_to_server_uuid("ws-1");
        let sid = local_id_to_server_uuid("session-1");
        let panes = desired().workspaces[0].sessions[0].panes.clone();
        // Snapshot vacío: el DELETE del workspace arrasa el resto por cascade,
        // así que no hay deletes de sesiones ni de terminales.
        let server = MockServer::start(vec![
            ok_reply(json!([workspace_entry(&wid, "una")])),
            ok_reply(json!([server_session(
                &sid,
                "una",
                vec![server_terminal(&panes[0]), server_terminal(&panes[1]),]
            )])),
            ok_reply(json!({})), // DELETE del workspace huérfano
        ]);
        let cloud = store(&server);
        cloud
            .save_snapshot(&WorkspaceSnapshot::new(vec![]))
            .unwrap();

        let all = server.requests();
        let deletes: Vec<&Recorded> = all.iter().filter(|r| r.method == "DELETE").collect();
        assert_eq!(deletes.len(), 1);
        assert_eq!(deletes[0].path, format!("/workspaces/{wid}"));
    }

    #[test]
    fn sin_token_no_se_consulta_la_api() {
        struct SinSesion;
        impl AccessTokenProvider for SinSesion {
            fn access_token(&self) -> Result<String, PortError> {
                Err(PortError::new(
                    "no hay sesión iniciada: el modo nube necesita login",
                ))
            }

            fn refreshed_access_token(&self) -> Result<String, PortError> {
                Err(PortError::new(
                    "no hay sesión iniciada: el modo nube necesita login",
                ))
            }
        }
        let server = MockServer::start(vec![]);
        let cloud = CloudSnapshotStore::new(server.url(), Arc::new(SinSesion));
        let err = cloud.load_snapshot().unwrap_err();
        assert!(err.0.contains("no hay sesión"), "{}", err.0);
        assert_eq!(server.count(), 0, "la API ni se enteró");
        assert!(cloud.save_snapshot(&desired()).is_err());
        assert_eq!(server.count(), 0);
    }

    #[test]
    fn base_url_con_barra_final_no_duplica_las_barras() {
        let server = MockServer::start(vec![ok_reply(json!([]))]);
        let cloud = CloudSnapshotStore::new(format!("{}/", server.url()), tokens());
        cloud.load_snapshot().unwrap();
        assert_eq!(server.requests()[0].path, "/workspaces");
    }

    #[test]
    fn un_fallo_de_conexion_es_error_de_puerto() {
        // Puerto reservado y soltado: nadie escucha ahí.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let cloud = CloudSnapshotStore::new(url, tokens());
        let err = cloud.load_snapshot().unwrap_err();
        assert!(
            err.0.contains("falló el pedido GET /workspaces"),
            "{}",
            err.0
        );
    }
}
