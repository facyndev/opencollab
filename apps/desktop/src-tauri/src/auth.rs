//! Login del desktop a través de la web (PKCE + deep link).
//!
//! Flujo: el frontend genera el par PKCE (WebCrypto) y llama `auth_begin_login`
//! con challenge y verifier; el núcleo guarda el verifier, abre el navegador del
//! sistema en `/login?client=desktop&code_challenge=…` y la web devuelve
//! `opencollab://auth/callback?code=…`, que el plugin de deep link entrega a la
//! app. El frontend extrae el `code` y llama `auth_finish`, que lo canjea en
//! `POST /auth/desktop/token`.
//!
//! Los tokens viven **solo en la memoria del núcleo**; el frontend recibe el
//! usuario y el evento `auth-changed`. El HTTP va con `std::net`, sin runtime
//! async (como `HttpRelayProbe`): el relay escucha en HTTP local sin TLS.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use application::ports::{AccessTokenProvider, PortError};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::state::AppState;

/// Evento que avisa a la UI cuando cambia la sesión (login, refresh con usuario
/// nuevo, logout o caída de la sesión).
pub const AUTH_CHANGED_EVENT: &str = "auth-changed";

/// Origen de la web por defecto: el dev server de `apps/web` (1420 es Vite del desktop).
const DEFAULT_WEB_ORIGIN: &str = "http://localhost:1421";
/// Margen antes del vencimiento en el que `auth_status` intenta refrescar (igual que la web).
const REFRESH_MARGIN: Duration = Duration::from_secs(60);
/// Tope por pedido HTTP (igual que el cliente web).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Tope de respuesta leída: las respuestas de auth son JSON chicos.
const MAX_RESPONSE: usize = 1 << 20;

/// Usuario tal como lo devuelve el relay (`GET /auth/me` y el canje del código).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserView {
    pub id: String,
    pub username: String,
    pub email: Option<String>,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthChangedPayload {
    user: Option<UserView>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthResultBody {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
    user: UserView,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenPairBody {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
}

struct Session {
    access_token: String,
    refresh_token: String,
    expires_at: Instant,
    user: UserView,
}

struct Inner {
    verifier: Option<String>,
    session: Option<Session>,
}

/// Resultado de consultar/renovar la sesión. `Fresh` no toca la red; `Refreshed`
/// ya actualizó el par de tokens; `Rejected` cerró la sesión (el relay rechazó
/// el refresh); `Malformed` conserva la sesión (respuesta ilegible).
enum RefreshOutcome {
    Fresh {
        user: UserView,
        access_token: String,
    },
    Refreshed {
        user: UserView,
        access_token: String,
    },
    NoSession,
    Rejected,
    Malformed,
}

/// Sesión del desktop: dirección del relay, origen de la web y estado mutable
/// (verifier pendiente + tokens). Todo queda en memoria del proceso.
pub struct AuthStore {
    api_addr: String,
    web_origin: String,
    inner: Mutex<Inner>,
    /// Serializa los refresh: si dos pedidos reciben 401 a la vez, el segundo
    /// espera y reutiliza el token que renovó el primero.
    refresh_lock: Mutex<()>,
}

impl AuthStore {
    pub fn new(api_addr: String) -> Self {
        let web_origin = resolve_web_origin(|k| std::env::var(k));
        Self {
            api_addr,
            web_origin,
            inner: Mutex::new(Inner {
                verifier: None,
                session: None,
            }),
            refresh_lock: Mutex::new(()),
        }
    }

    /// Hay una sesión en memoria (puede estar vencida: el refresh lo decide
    /// el pedido). El modo nube exige al menos esto para configurarse.
    pub fn has_session(&self) -> bool {
        self.inner.lock().expect("auth").session.is_some()
    }

    /// URL de la web donde el usuario hace el login para esta máquina.
    pub fn login_url(&self, challenge: &str) -> String {
        format!(
            "{}/login?client=desktop&code_challenge={challenge}",
            self.web_origin
        )
    }

    /// Token para un pedido a la API: si el access venció o está por vencer,
    /// renueva el par antes de devolverlo. Sin sesión (o refresh rechazado) es
    /// un error: el modo nube nunca manda un pedido sin credencial.
    pub fn access_token_for_request(&self) -> Result<String, String> {
        match self.refresh_now(false, None) {
            RefreshOutcome::Fresh { access_token, .. }
            | RefreshOutcome::Refreshed { access_token, .. } => Ok(access_token),
            RefreshOutcome::NoSession | RefreshOutcome::Rejected => {
                Err("no hay sesión iniciada".to_string())
            }
            RefreshOutcome::Malformed => Err("respuesta del relay inválida".to_string()),
        }
    }

    /// Igual que `access_token_for_request`, pero fuerza el refresh si el
    /// token rechazado sigue siendo el vigente. Si otro pedido ya renovó
    /// (`rejected` quedó viejo), devuelve el token nuevo sin otra red.
    pub fn refreshed_access_token_for_request(&self, rejected: &str) -> Result<String, String> {
        match self.refresh_now(true, Some(rejected)) {
            RefreshOutcome::Fresh { access_token, .. }
            | RefreshOutcome::Refreshed { access_token, .. } => Ok(access_token),
            RefreshOutcome::NoSession | RefreshOutcome::Rejected => {
                Err("no hay sesión iniciada".to_string())
            }
            RefreshOutcome::Malformed => Err("respuesta del relay inválida".to_string()),
        }
    }

    /// Estado de la sesión y, si corresponde, refresh contra el relay. Es la
    /// única implementación del refresh: la comparten `auth_status` y el
    /// proveedor de tokens del modo nube.
    fn refresh_now(&self, force: bool, rejected: Option<&str>) -> RefreshOutcome {
        let _refresh = self.refresh_lock.lock().expect("refresh lock");
        let refresh_token = {
            let inner = self.inner.lock().expect("auth");
            let Some(session) = inner.session.as_ref() else {
                return RefreshOutcome::NoSession;
            };
            if let Some(rejected) = rejected {
                if session.access_token != rejected {
                    return RefreshOutcome::Fresh {
                        user: session.user.clone(),
                        access_token: session.access_token.clone(),
                    };
                }
            }
            if !force
                && session.expires_at.saturating_duration_since(Instant::now()) > REFRESH_MARGIN
            {
                return RefreshOutcome::Fresh {
                    user: session.user.clone(),
                    access_token: session.access_token.clone(),
                };
            }
            session.refresh_token.clone()
        };
        let body = format!("{{\"refreshToken\":\"{}\"}}", json_escape(&refresh_token));
        match post_json(self, "/auth/refresh", &body) {
            Ok((200, raw)) => match serde_json::from_slice::<TokenPairBody>(&raw) {
                Ok(pair) => {
                    let mut inner = self.inner.lock().expect("auth");
                    let Some(session) = inner.session.as_mut() else {
                        return RefreshOutcome::NoSession;
                    };
                    session.access_token = pair.access_token;
                    session.refresh_token = pair.refresh_token;
                    session.expires_at = Instant::now() + Duration::from_secs(pair.expires_in);
                    RefreshOutcome::Refreshed {
                        user: session.user.clone(),
                        access_token: session.access_token.clone(),
                    }
                }
                Err(_) => RefreshOutcome::Malformed,
            },
            _ => {
                self.inner.lock().expect("auth").session = None;
                RefreshOutcome::Rejected
            }
        }
    }
}

impl AccessTokenProvider for AuthStore {
    fn access_token(&self) -> Result<String, PortError> {
        self.access_token_for_request().map_err(PortError::new)
    }

    fn refreshed_access_token(&self, rejected: &str) -> Result<String, PortError> {
        self.refreshed_access_token_for_request(rejected)
            .map_err(PortError::new)
    }
}

/// Resuelve el origen de la web para el login:
/// 1. `OPENCOLLAB_WEB_ORIGIN` (override específico para el desktop).
/// 2. `WEB_ORIGIN` (variable general del monorepo / .env).
/// 3. `DEFAULT_WEB_ORIGIN` ("http://localhost:1421").
pub fn resolve_web_origin<F>(var_getter: F) -> String
where
    F: Fn(&str) -> Result<String, std::env::VarError>,
{
    var_getter("OPENCOLLAB_WEB_ORIGIN")
        .or_else(|_| var_getter("WEB_ORIGIN"))
        .ok()
        .filter(|origin| is_http_origin(origin))
        .unwrap_or_else(|| DEFAULT_WEB_ORIGIN.to_string())
}

/// Solo un origen `http(s)` sin ruta, para no redirigir al navegador a otro lado.
fn is_http_origin(value: &str) -> bool {
    let rest = value
        .strip_prefix("http://")
        .or_else(|| value.strip_prefix("https://"));
    match rest {
        Some(host) => !host.is_empty() && !host.contains(['/', '?', '#', '@']),
        None => false,
    }
}

/// Challenge S256: base64url de 32 bytes, siempre 43 caracteres (igual que la web).
fn is_valid_challenge(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Verifier PKCE (RFC 7636): 43-128 caracteres base64url.
fn is_valid_verifier(value: &str) -> bool {
    (43..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Código de un solo uso que viaja en el deep link (token opaco del relay).
fn is_valid_code(value: &str) -> bool {
    (1..=512).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `code` del deep link `opencollab://auth/callback?code=…`; `None` si la URL no
/// es un callback de login (nunca confiar en un deep link con otra forma).
pub fn parse_callback_code(url: &str) -> Option<String> {
    let rest = url.strip_prefix("opencollab://")?;
    let (path, query) = rest.split_once('?')?;
    if path != "auth/callback" {
        return None;
    }
    query
        .split('&')
        .filter_map(|param| param.split_once('='))
        .find(|(key, _)| *key == "code")
        .and_then(|(_, value)| percent_decode(value))
        .filter(|code| is_valid_code(code))
}

fn percent_decode(value: &str) -> Option<String> {
    let mut out = Vec::with_capacity(value.len());
    let mut bytes = value.bytes();
    while let Some(b) = bytes.next() {
        if b == b'%' {
            let hex: Vec<u8> = bytes.by_ref().take(2).collect();
            if hex.len() != 2 {
                return None;
            }
            let text = std::str::from_utf8(&hex).ok()?;
            out.push(u8::from_str_radix(text, 16).ok()?);
        } else {
            out.push(b);
        }
    }
    String::from_utf8(out).ok()
}

fn open_browser(url: &str) {
    let (program, args) = browser_command(url);
    let _ = std::process::Command::new(program).args(args).spawn();
}

/// Programa y argumentos que abren `url` en el navegador del sistema. En
/// Windows no pasa por `cmd`: `cmd /C start` corta la URL en el `&` (separador
/// de comandos) y el `code_challenge` no llegaría a la web.
fn browser_command(url: &str) -> (&'static str, Vec<&str>) {
    #[cfg(target_os = "windows")]
    return ("rundll32", vec!["url.dll,FileProtocolHandler", url]);
    #[cfg(target_os = "macos")]
    return ("open", vec![url]);
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    return ("xdg-open", vec![url]);
}

/// Escapa un string para interpolarlo en un JSON entre comillas (los códigos y
/// verifiers son base64url, pero no se confía en el llamador).
fn json_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// `POST` JSON al relay; devuelve el estado y el cuerpo. Sin TLS: el relay
/// escucha en HTTP local.
fn post_json(store: &AuthStore, path: &str, body: &str) -> Result<(u16, Vec<u8>), String> {
    let target = store
        .api_addr
        .to_socket_addrs()
        .map_err(|e| format!("dirección del relay inválida: {e}"))?
        .next()
        .ok_or_else(|| "dirección del relay sin resolver".to_string())?;
    let mut stream = TcpStream::connect_timeout(&target, REQUEST_TIMEOUT)
        .map_err(|e| format!("relay inaccesible: {e}"))?;
    stream
        .set_write_timeout(Some(REQUEST_TIMEOUT))
        .and(stream.set_read_timeout(Some(REQUEST_TIMEOUT)))
        .map_err(|e| e.to_string())?;
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        store.api_addr,
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("no se pudo consultar al relay: {e}"))?;

    let mut response = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                response.extend_from_slice(&chunk[..n]);
                if response.len() > MAX_RESPONSE {
                    return Err("respuesta del relay demasiado larga".to_string());
                }
            }
            Err(e) => return Err(format!("relay sin respuesta: {e}")),
        }
    }
    let text = String::from_utf8_lossy(&response);
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| "respuesta del relay inválida".to_string())?;
    let status: u16 = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| "respuesta del relay inválida".to_string())?;
    Ok((status, body.as_bytes().to_vec()))
}

fn emit_changed(app: &AppHandle, user: Option<UserView>) {
    let _ = app.emit(AUTH_CHANGED_EVENT, AuthChangedPayload { user });
}

fn adopt_session(store: &AuthStore, result: AuthResultBody) -> UserView {
    let session = Session {
        access_token: result.access_token,
        refresh_token: result.refresh_token,
        expires_at: Instant::now() + Duration::from_secs(result.expires_in),
        user: result.user.clone(),
    };
    store.inner.lock().expect("auth").session = Some(session);
    result.user
}

/// Empieza el login: guarda el verifier y abre la web en el navegador. Devuelve
/// la URL por si el navegador no se abrió (la UI la muestra como alternativa).
#[tauri::command(async)]
pub fn auth_begin_login(
    state: State<'_, AppState>,
    challenge: String,
    verifier: String,
) -> Result<String, String> {
    if !is_valid_challenge(&challenge) {
        return Err("code_challenge inválido".to_string());
    }
    if !is_valid_verifier(&verifier) {
        return Err("code_verifier inválido".to_string());
    }
    let url = state.auth.login_url(&challenge);
    state.auth.inner.lock().expect("auth").verifier = Some(verifier);
    open_browser(&url);
    Ok(url)
}

/// Canjea el deep link `opencollab://auth/callback?code=…` por la sesión y avisa
/// con `auth-changed`. El `code` se ata al verifier guardado en `auth_begin_login`.
#[tauri::command(async)]
pub fn auth_finish(
    app: AppHandle,
    state: State<'_, AppState>,
    callback_url: String,
) -> Result<UserView, String> {
    let code =
        parse_callback_code(&callback_url).ok_or_else(|| "enlace de login inválido".to_string())?;
    let verifier = state
        .auth
        .inner
        .lock()
        .expect("auth")
        .verifier
        .take()
        .ok_or_else(|| "no hay un login en curso: volvé a tocar Sign in".to_string())?;
    let body = format!(
        "{{\"code\":\"{}\",\"codeVerifier\":\"{}\"}}",
        json_escape(&code),
        json_escape(&verifier)
    );
    let (status, raw) = post_json(&state.auth, "/auth/desktop/token", &body)?;
    if status != 200 {
        return Err("el relay rechazó el código (venció o ya se usó)".to_string());
    }
    let result: AuthResultBody =
        serde_json::from_slice(&raw).map_err(|_| "respuesta del relay inválida".to_string())?;
    let user = adopt_session(&state.auth, result);
    emit_changed(&app, Some(user.clone()));
    Ok(user)
}

/// Sesión vigente, o `None`. Si el access está por vencer y hay refresh,
/// lo renueva una vez (igual que la web); si el refresh falla, cierra la sesión.
#[tauri::command(async)]
pub fn auth_status(app: AppHandle, state: State<'_, AppState>) -> Result<Option<UserView>, String> {
    match state.auth.refresh_now(false, None) {
        RefreshOutcome::Fresh { user, .. } => Ok(Some(user)),
        RefreshOutcome::Refreshed { user, .. } => {
            emit_changed(&app, Some(user.clone()));
            Ok(Some(user))
        }
        RefreshOutcome::NoSession => Ok(None),
        RefreshOutcome::Rejected => {
            emit_changed(&app, None);
            Ok(None)
        }
        RefreshOutcome::Malformed => Ok(state
            .auth
            .inner
            .lock()
            .expect("auth")
            .session
            .as_ref()
            .map(|s| s.user.clone())),
    }
}

/// Cierra la sesión (avisa al relay sin bloquear) y emite `auth-changed` sin usuario.
#[tauri::command(async)]
pub fn auth_logout(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let refresh_token = state
        .auth
        .inner
        .lock()
        .expect("auth")
        .session
        .take()
        .map(|session| session.refresh_token);
    if let Some(refresh_token) = refresh_token {
        let body = format!("{{\"refreshToken\":\"{}\"}}", json_escape(&refresh_token));
        let _ = post_json(&state.auth, "/auth/logout", &body);
    }
    emit_changed(&app, None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_launch_passes_the_whole_url_without_a_shell() {
        let url = "http://localhost:1421/login?client=desktop&code_challenge=abc";
        let (program, args) = browser_command(url);
        // `cmd /C start` would cut the URL at `&` and run the rest as a command.
        assert_ne!(program, "cmd");
        assert_eq!(args.last(), Some(&url));
    }

    #[test]
    fn login_url_targets_the_desktop_client() {
        let store = AuthStore {
            api_addr: "127.0.0.1:8787".to_string(),
            web_origin: "https://app.example.com".to_string(),
            inner: Mutex::new(Inner {
                verifier: None,
                session: None,
            }),
            refresh_lock: Mutex::new(()),
        };
        assert_eq!(
            store.login_url(&"a".repeat(43)),
            format!(
                "https://app.example.com/login?client=desktop&code_challenge={}",
                "a".repeat(43)
            )
        );
    }

    #[test]
    fn rejects_non_http_web_origins() {
        assert!(is_http_origin("http://localhost:1421"));
        assert!(is_http_origin("https://app.example.com"));
        assert!(!is_http_origin("opencollab://auth/callback"));
        assert!(!is_http_origin("https://app.example.com/login"));
        assert!(!is_http_origin("javascript:alert(1)"));
        assert!(!is_http_origin(""));
    }

    #[test]
    fn parses_the_desktop_callback() {
        assert_eq!(
            parse_callback_code("opencollab://auth/callback?code=abc123"),
            Some("abc123".to_string())
        );
        // Parámetros extra no molestan; el primero que vale es el code.
        assert_eq!(
            parse_callback_code("opencollab://auth/callback?foo=1&code=xyz"),
            Some("xyz".to_string())
        );
        // Percent-encoding (el code real es base64url, pero no se rechaza el encoding válido).
        assert_eq!(
            parse_callback_code("opencollab://auth/callback?code=ab%33"),
            Some("ab3".to_string())
        );
    }

    #[test]
    fn rejects_foreign_deep_links() {
        assert_eq!(parse_callback_code("opencollab://auth/callback"), None);
        assert_eq!(
            parse_callback_code("opencollab://auth/callback?code="),
            None
        );
        assert_eq!(
            parse_callback_code("opencollab://other/path?code=abc"),
            None
        );
        assert_eq!(
            parse_callback_code("https://evil.example/auth/callback?code=abc"),
            None
        );
        assert_eq!(
            parse_callback_code("opencollab://auth/callback?code=con espacios"),
            None
        );
        assert_eq!(parse_callback_code("not a url"), None);
    }

    #[test]
    fn validates_pkce_values_like_the_web() {
        assert!(is_valid_challenge(&"a".repeat(43)));
        assert!(!is_valid_challenge(&"a".repeat(42)));
        assert!(!is_valid_challenge("código inválido ñ"));
        assert!(is_valid_verifier(&"a".repeat(43)));
        assert!(is_valid_verifier(&"a".repeat(128)));
        assert!(!is_valid_verifier(&"a".repeat(129)));
        assert!(!is_valid_verifier("corto"));
    }

    #[test]
    fn resolve_web_origin_prefers_opencollab_origin_then_web_origin_then_default() {
        // 1. OPENCOLLAB_WEB_ORIGIN tiene prioridad si ambas están
        let origin = resolve_web_origin(|key| match key {
            "OPENCOLLAB_WEB_ORIGIN" => Ok("http://localhost:9999".to_string()),
            "WEB_ORIGIN" => Ok("http://localhost:8080".to_string()),
            _ => Err(std::env::VarError::NotPresent),
        });
        assert_eq!(origin, "http://localhost:9999");

        // 2. WEB_ORIGIN se usa si OPENCOLLAB_WEB_ORIGIN no está
        let origin = resolve_web_origin(|key| match key {
            "WEB_ORIGIN" => Ok("http://localhost:8080".to_string()),
            _ => Err(std::env::VarError::NotPresent),
        });
        assert_eq!(origin, "http://localhost:8080");

        // 3. DEFAULT_WEB_ORIGIN si ninguna está
        let origin = resolve_web_origin(|_| Err(std::env::VarError::NotPresent));
        assert_eq!(origin, "http://localhost:1421");

        // 4. Si el origen es inválido (ej. con path), cae al default
        let origin = resolve_web_origin(|key| match key {
            "WEB_ORIGIN" => Ok("http://localhost:8080/invalid/path".to_string()),
            _ => Err(std::env::VarError::NotPresent),
        });
        assert_eq!(origin, "http://localhost:1421");
    }

    fn store_with_session(access_token: &str, refresh_token: &str) -> AuthStore {
        AuthStore {
            api_addr: "127.0.0.1:1".to_string(),
            web_origin: DEFAULT_WEB_ORIGIN.to_string(),
            inner: Mutex::new(Inner {
                verifier: None,
                session: Some(Session {
                    access_token: access_token.to_string(),
                    refresh_token: refresh_token.to_string(),
                    expires_at: Instant::now() + Duration::from_secs(600),
                    user: UserView {
                        id: "u1".to_string(),
                        username: "ana".to_string(),
                        email: None,
                        display_name: "Ana".to_string(),
                    },
                }),
            }),
            refresh_lock: Mutex::new(()),
        }
    }

    #[test]
    fn fresh_session_token_comes_from_memory_without_the_relay() {
        // El relay apunta a un puerto cerrado a propósito: un token vigente no
        // debe intentar red, ni por el método propio ni por el puerto.
        let store = store_with_session("access-1", "refresh-1");
        assert_eq!(store.access_token_for_request().unwrap(), "access-1");
        assert_eq!(
            AccessTokenProvider::access_token(&store).unwrap(),
            "access-1"
        );
    }

    #[test]
    fn no_session_cannot_produce_a_token() {
        let store = AuthStore {
            api_addr: "127.0.0.1:1".to_string(),
            web_origin: DEFAULT_WEB_ORIGIN.to_string(),
            inner: Mutex::new(Inner {
                verifier: None,
                session: None,
            }),
            refresh_lock: Mutex::new(()),
        };
        assert_eq!(
            store.access_token_for_request(),
            Err("no hay sesión iniciada".to_string())
        );
        assert!(AccessTokenProvider::access_token(&store).is_err());
        assert!(store.refreshed_access_token_for_request("stale").is_err());
        assert!(!store.has_session());
    }

    #[test]
    fn a_stale_rejected_token_reuses_the_concurrent_refresh_without_network() {
        // El relay apunta a un puerto cerrado: si el short-circuit no ocurre,
        // este test falla por timeout de red en vez de devolver el token nuevo.
        let store = store_with_session("access-2", "refresh-2");
        // El 401 llegó con "access-1", pero otro pedido ya renovó a "access-2".
        assert_eq!(
            store
                .refreshed_access_token_for_request("access-1")
                .unwrap(),
            "access-2"
        );
        assert!(store.has_session());
    }

    #[test]
    fn dos_401_concurrentes_comparten_un_solo_refresh() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Barrier};

        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let addr = listener.local_addr().expect("addr").to_string();
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_server = Arc::clone(&hits);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                hits_server.fetch_add(1, Ordering::SeqCst);
                let body =
                    r#"{"accessToken":"access-2","refreshToken":"refresh-2","expiresIn":600}"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });

        let store = Arc::new(AuthStore {
            api_addr: addr,
            web_origin: DEFAULT_WEB_ORIGIN.to_string(),
            inner: Mutex::new(Inner {
                verifier: None,
                session: Some(Session {
                    access_token: "access-1".to_string(),
                    refresh_token: "refresh-1".to_string(),
                    expires_at: Instant::now() + Duration::from_secs(600),
                    user: UserView {
                        id: "u1".to_string(),
                        username: "ana".to_string(),
                        email: None,
                        display_name: "Ana".to_string(),
                    },
                }),
            }),
            refresh_lock: Mutex::new(()),
        });

        let barrier = Arc::new(Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let store = Arc::clone(&store);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    store.refreshed_access_token_for_request("access-1")
                })
            })
            .collect();
        for handle in handles {
            assert_eq!(handle.join().expect("hilo"), Ok("access-2".to_string()));
        }
        assert_eq!(
            hits.load(Ordering::SeqCst),
            1,
            "un solo refresh para dos 401"
        );
    }
}
