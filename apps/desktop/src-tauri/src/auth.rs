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

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::state::AppState;

/// Evento que avisa a la UI cuando cambia la sesión (login, refresh con usuario
/// nuevo, logout o caída de la sesión).
pub const AUTH_CHANGED_EVENT: &str = "auth-changed";

/// Origen de la web por defecto: el dev server de `packages/web` (1420 es Vite del desktop).
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

/// Sesión del desktop: dirección del relay, origen de la web y estado mutable
/// (verifier pendiente + tokens). Todo queda en memoria del proceso.
pub struct AuthStore {
    api_addr: String,
    web_origin: String,
    inner: Mutex<Inner>,
}

impl AuthStore {
    pub fn new(api_addr: String) -> Self {
        let web_origin = std::env::var("OPENCOLLAB_WEB_ORIGIN")
            .ok()
            .filter(|origin| is_http_origin(origin))
            .unwrap_or_else(|| DEFAULT_WEB_ORIGIN.to_string());
        Self {
            api_addr,
            web_origin,
            inner: Mutex::new(Inner {
                verifier: None,
                session: None,
            }),
        }
    }

    /// URL de la web donde el usuario hace el login para esta máquina.
    pub fn login_url(&self, challenge: &str) -> String {
        format!(
            "{}/login?client=desktop&code_challenge={challenge}",
            self.web_origin
        )
    }
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
    if let Some(user) = fresh_user(&state.auth) {
        return Ok(Some(user));
    }
    let Some(refresh_token) = refresh_due(&state.auth) else {
        return Ok(state
            .auth
            .inner
            .lock()
            .expect("auth")
            .session
            .as_ref()
            .map(|s| s.user.clone()));
    };
    let body = format!("{{\"refreshToken\":\"{}\"}}", json_escape(&refresh_token));
    match post_json(&state.auth, "/auth/refresh", &body) {
        Ok((200, raw)) => match serde_json::from_slice::<TokenPairBody>(&raw) {
            Ok(pair) => {
                let mut inner = state.auth.inner.lock().expect("auth");
                if let Some(session) = inner.session.as_mut() {
                    session.access_token = pair.access_token;
                    session.refresh_token = pair.refresh_token;
                    session.expires_at = Instant::now() + Duration::from_secs(pair.expires_in);
                    let user = session.user.clone();
                    drop(inner);
                    emit_changed(&app, Some(user.clone()));
                    return Ok(Some(user));
                }
                Ok(None)
            }
            Err(_) => Ok(state
                .auth
                .inner
                .lock()
                .expect("auth")
                .session
                .as_ref()
                .map(|s| s.user.clone())),
        },
        _ => {
            state.auth.inner.lock().expect("auth").session = None;
            emit_changed(&app, None);
            Ok(None)
        }
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

fn fresh_user(store: &AuthStore) -> Option<UserView> {
    let inner = store.inner.lock().expect("auth");
    inner.session.as_ref().and_then(|session| {
        if session.expires_at.saturating_duration_since(Instant::now()) > REFRESH_MARGIN {
            Some(session.user.clone())
        } else {
            None
        }
    })
}

/// Refresh token si la sesión existe y el access está vencido o por vencer.
fn refresh_due(store: &AuthStore) -> Option<String> {
    let inner = store.inner.lock().expect("auth");
    inner.session.as_ref().and_then(|session| {
        if session.expires_at.saturating_duration_since(Instant::now()) <= REFRESH_MARGIN {
            Some(session.refresh_token.clone())
        } else {
            None
        }
    })
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
}
