//! Instaladores de los hooks / plugin con que cada agente reporta sus subagentes.
//!
//! Reglas comunes de los instaladores JSON (Claude Code y Codex):
//!
//! - **Solo tocan lo propio.** Una entrada es nuestra si su `command` contiene
//!   `opencollab-hook` (el nombre del sidecar). Todo lo demás se conserva tal cual.
//! - **Idempotentes.** Instalar dos veces no duplica; si la ruta del binario
//!   cambió (la app se movió) la entrada propia se actualiza en lugar de sumar otra.
//! - **Seguros.** JSON malformado o con otra forma → error y el archivo queda
//!   intacto; antes de modificar un archivo existente se copia a
//!   `<archivo>.opencollab.bak`; la escritura es temp + rename.
//! - **Reversibles.** `uninstall` quita nuestras entradas y las estructuras que
//!   quedan vacías por eso (no las que ya estaban vacías).
//!
//! El comando se arma como `"<ruta>" <agent-id>` con la ruta entre comillas
//! (admite espacios) y con `/` en lugar de `\`: Windows acepta ambas, y así la
//! ruta sobrevive tanto a `cmd` como a las shells tipo bash con las que Claude
//! Code ejecuta hooks.
//!
//! Esquemas (verificados contra documentación primaria el 2026-10-05):
//!
//! - Claude Code, <https://code.claude.com/docs/en/hooks>: `settings.json` →
//!   `{"hooks": {"<Evento>": [{"matcher"?, "hooks": [{"type": "command",
//!   "command", "timeout"?}]}]}}`; `SubagentStart` / `SubagentStop` existen, el
//!   `matcher` opcional filtra por tipo de agente (sin él, todos). Reciben por
//!   stdin `session_id`, `hook_event_name`, `agent_type`, `agent_id`.
//! - Codex, <https://learn.chatgpt.com/docs/hooks> (antes developers.openai.com):
//!   `~/.codex/hooks.json` con la misma forma; eventos `SubagentStart` /
//!   `SubagentStop`; campos `timeout` (s) y `async` (segundo plano). Codex pide
//!   al usuario aprobar los hooks la primera vez. Los campos exactos del stdin
//!   de los eventos de subagente no figuran en la doc: el traductor es tolerante.
//! - OpenCode, <https://opencode.ai/docs/plugins/>: archivo en
//!   `~/.config/opencode/plugins/` que exporta una función async con hooks
//!   (`event`, `tool.execute.after`). **Suposiciones** (la doc no las detalla):
//!   `session.created` trae `event.properties.info.{id, parentID}`; el
//!   `tool.execute.after` de `task` trae el id de la sesión hija en
//!   `output.metadata.sessionId` (el `input.sessionID` es el de la sesión padre).

use std::fs;
use std::path::{Path, PathBuf};

use application::agent_detection::KnownAgent;
use application::ports::{HookInstaller, PortError};
use application::HookStatus;
use serde_json::{json, Map, Value};

/// Nombre del sidecar: así se reconocen nuestras entradas en la config ajena.
const BIN_MARKER: &str = "opencollab-hook";
const BACKUP_SUFFIX: &str = ".opencollab.bak";
const TMP_SUFFIX: &str = ".opencollab.tmp";
/// Tope del hook, en segundos: nunca debe estorbar al agente.
const HOOK_TIMEOUT_SECS: u64 = 5;
const HOOK_EVENTS: [&str; 1] = ["UserPromptSubmit"];

fn io_error(action: &str, path: &Path, e: &std::io::Error) -> PortError {
    PortError::new(format!("{action} {}: {e}", path.display()))
}

fn shape_error(path: &Path, what: &str) -> PortError {
    PortError::new(format!(
        "{} no tiene la forma esperada ({what}); no se modificó",
        path.display()
    ))
}

// ---------------------------------------------------------------------------
// Instaladores JSON (Claude Code, Codex)
// ---------------------------------------------------------------------------

/// Lo que distingue a un agente de otro en el instalador JSON.
struct JsonHooks {
    agent: KnownAgent,
    file: PathBuf,
    command: String,
    async_hook: bool,
}

impl JsonHooks {
    fn new(agent: KnownAgent, file: PathBuf, hook_bin: &Path, async_hook: bool) -> Self {
        let bin = hook_bin.to_string_lossy().replace('\\', "/");
        Self {
            agent,
            file,
            command: format!("\"{bin}\" {}", agent.id()),
            async_hook,
        }
    }

    /// El hook interno (`{"type": "command", ...}`) que escribimos.
    fn entry(&self) -> Value {
        let mut hook = json!({
            "type": "command",
            "command": self.command,
            "timeout": HOOK_TIMEOUT_SECS,
        });
        if self.async_hook {
            hook["async"] = Value::Bool(true);
        }
        hook
    }

    /// `None` si el archivo no existe. Vacío cuenta como objeto vacío.
    fn load(&self) -> Result<Option<Value>, PortError> {
        let text = match fs::read_to_string(&self.file) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(io_error("no se pudo leer", &self.file, &e)),
        };
        if text.trim().is_empty() {
            return Ok(Some(Value::Object(Map::new())));
        }
        serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| PortError::new(format!("{} no es JSON válido: {e}", self.file.display())))
    }

    fn write(&self, doc: &Value) -> Result<(), PortError> {
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir).map_err(|e| io_error("no se pudo crear", dir, &e))?;
        }
        if self.file.exists() {
            let backup = suffixed(&self.file, BACKUP_SUFFIX);
            fs::copy(&self.file, &backup)
                .map_err(|e| io_error("no se pudo respaldar en", &backup, &e))?;
        }
        let mut text = serde_json::to_string_pretty(doc)
            .map_err(|e| PortError::new(format!("no se pudo serializar: {e}")))?;
        text.push('\n');
        let tmp = suffixed(&self.file, TMP_SUFFIX);
        fs::write(&tmp, text).map_err(|e| io_error("no se pudo escribir", &tmp, &e))?;
        fs::rename(&tmp, &self.file).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            io_error("no se pudo reemplazar", &self.file, &e)
        })
    }

    fn status(&self) -> Result<HookStatus, PortError> {
        match self.load()? {
            None => Ok(HookStatus::NotInstalled),
            Some(doc) if has_hooks(&doc, &self.entry(), &self.file)? => Ok(HookStatus::Installed),
            Some(_) => Ok(HookStatus::NotInstalled),
        }
    }

    fn install(&self) -> Result<(), PortError> {
        let mut doc = self.load()?.unwrap_or_else(|| Value::Object(Map::new()));
        if add_hooks(&mut doc, &self.entry(), &self.file)? || !self.file.exists() {
            self.write(&doc)?;
        }
        Ok(())
    }

    fn uninstall(&self) -> Result<(), PortError> {
        let Some(mut doc) = self.load()? else {
            return Ok(());
        };
        if remove_hooks(&mut doc, &self.file)? {
            self.write(&doc)?;
        }
        Ok(())
    }
}

fn suffixed(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// ¿Es un hook interno nuestro? (su `command` menciona el sidecar).
fn is_ours(hook: &Value) -> bool {
    hook.get("command")
        .and_then(Value::as_str)
        .is_some_and(|c| c.contains(BIN_MARKER))
}

/// El objeto `hooks` del documento, si existe. Error si el documento no es un
/// objeto o `hooks` no lo es.
fn hooks_object<'a>(
    doc: &'a Value,
    path: &Path,
) -> Result<Option<&'a Map<String, Value>>, PortError> {
    let root = doc
        .as_object()
        .ok_or_else(|| shape_error(path, "la raíz no es un objeto"))?;
    match root.get("hooks") {
        None => Ok(None),
        Some(Value::Object(hooks)) => Ok(Some(hooks)),
        Some(_) => Err(shape_error(path, "`hooks` no es un objeto")),
    }
}

/// Los hooks internos de un grupo (`{"matcher"?, "hooks": [...]}`).
fn group_hooks(group: &Value) -> &[Value] {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// `true` si cada evento tiene nuestro hook exactamente igual a `entry`.
fn has_hooks(doc: &Value, entry: &Value, path: &Path) -> Result<bool, PortError> {
    let Some(hooks) = hooks_object(doc, path)? else {
        return Ok(false);
    };
    for event in HOOK_EVENTS {
        let groups = match hooks.get(event) {
            None => return Ok(false),
            Some(Value::Array(groups)) => groups,
            Some(_) => return Err(shape_error(path, &format!("`{event}` no es una lista"))),
        };
        if !groups.iter().any(|g| group_hooks(g).contains(entry)) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Agrega (o actualiza) nuestro hook en cada evento. `true` si algo cambió.
fn add_hooks(doc: &mut Value, entry: &Value, path: &Path) -> Result<bool, PortError> {
    // Valida la forma antes de mutar nada.
    if let Some(hooks) = hooks_object(doc, path)? {
        for event in HOOK_EVENTS {
            if hooks.get(event).is_some_and(|v| !v.is_array()) {
                return Err(shape_error(path, &format!("`{event}` no es una lista")));
            }
        }
    }
    let root = doc.as_object_mut().expect("validado arriba");
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .expect("validado arriba");
    let mut changed = false;
    for event in HOOK_EVENTS {
        let groups = hooks
            .entry(event)
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .expect("validado arriba");
        let mut found = false;
        for group in groups.iter_mut() {
            let Some(inner) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
                continue;
            };
            for hook in inner.iter_mut().filter(|h| is_ours(h)) {
                found = true;
                if hook != entry {
                    *hook = entry.clone();
                    changed = true;
                }
            }
        }
        if !found {
            groups.push(json!({ "hooks": [entry] }));
            changed = true;
        }
    }
    Ok(changed)
}

/// Quita nuestros hooks y lo que quedó vacío por eso. `true` si algo cambió.
fn remove_hooks(doc: &mut Value, path: &Path) -> Result<bool, PortError> {
    hooks_object(doc, path)?;
    let root = doc.as_object_mut().expect("validado arriba");
    let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) else {
        return Ok(false);
    };
    let mut changed = false;
    let mut emptied = Vec::new();
    for (event, groups) in hooks.iter_mut() {
        let Some(groups) = groups.as_array_mut() else {
            continue;
        };
        let mut removed = false;
        groups.retain_mut(|group| {
            let Some(inner) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
                return true;
            };
            let before = inner.len();
            inner.retain(|h| !is_ours(h));
            let group_removed = inner.len() != before;
            removed |= group_removed;
            // Un grupo que solo existía por nuestro hook se va con él.
            !(group_removed && inner.is_empty())
        });
        changed |= removed;
        if removed && groups.is_empty() {
            emptied.push(event.clone());
        }
    }
    for event in emptied {
        hooks.shift_remove(&event);
    }
    if changed && hooks.is_empty() {
        root.shift_remove("hooks");
    }
    Ok(changed)
}

/// Claude Code: hooks `SubagentStart` / `SubagentStop` en `<raíz>/settings.json`.
pub struct ClaudeCodeHookInstaller(JsonHooks);

impl ClaudeCodeHookInstaller {
    /// `root` es `~/.claude`; `hook_bin`, la ruta absoluta de `opencollab-hook`.
    pub fn new(root: impl AsRef<Path>, hook_bin: impl AsRef<Path>) -> Self {
        Self(JsonHooks::new(
            KnownAgent::ClaudeCode,
            root.as_ref().join("settings.json"),
            hook_bin.as_ref(),
            false,
        ))
    }
}

impl HookInstaller for ClaudeCodeHookInstaller {
    fn agent(&self) -> KnownAgent {
        self.0.agent
    }
    fn status(&self) -> Result<HookStatus, PortError> {
        self.0.status()
    }
    fn install(&self) -> Result<(), PortError> {
        self.0.install()
    }
    fn uninstall(&self) -> Result<(), PortError> {
        self.0.uninstall()
    }
}

/// Codex: hooks `SubagentStart` / `SubagentStop` (`async`) en `<raíz>/hooks.json`.
/// Codex le pide al usuario aprobar los hooks la primera vez que los ve.
pub struct CodexHookInstaller(JsonHooks);

impl CodexHookInstaller {
    /// `root` es `~/.codex`; `hook_bin`, la ruta absoluta de `opencollab-hook`.
    pub fn new(root: impl AsRef<Path>, hook_bin: impl AsRef<Path>) -> Self {
        Self(JsonHooks::new(
            KnownAgent::Codex,
            root.as_ref().join("hooks.json"),
            hook_bin.as_ref(),
            true,
        ))
    }
}

impl HookInstaller for CodexHookInstaller {
    fn agent(&self) -> KnownAgent {
        self.0.agent
    }
    fn status(&self) -> Result<HookStatus, PortError> {
        self.0.status()
    }
    fn install(&self) -> Result<(), PortError> {
        self.0.install()
    }
    fn uninstall(&self) -> Result<(), PortError> {
        self.0.uninstall()
    }
}

// ---------------------------------------------------------------------------
// OpenCode: plugin propio
// ---------------------------------------------------------------------------

/// Primera línea del plugin: lo identifica como nuestro para `status` y `uninstall`.
const PLUGIN_MARKER: &str = "// opencollab-managed-plugin";

/// Plugin que se escribe en `plugins/opencollab.ts`. Usa `fetch` directo (sin
/// sidecar), no hace nada fuera de OpenCollab (faltan las variables), nunca
/// espera la respuesta ni propaga errores. Los cuerpos son el contrato de
/// `OpenCodeTranslator`.
const PLUGIN_SOURCE: &str = r#"// opencollab-managed-plugin
// Generado por OpenCollab: se regenera al instalar y se borra al desinstalar.
// Si lo editas a mano, OpenCollab lo va a considerar desactualizado.
//
// Reporta a OpenCollab el título de sesión de esta terminal. Fuera de OpenCollab
// (sin las variables de entorno) no hace nada. Nunca bloquea ni falla.

export const OpenCollab = async () => {
  const url = process.env.OPENCOLLAB_HOOK_URL
  const token = process.env.OPENCOLLAB_HOOK_TOKEN
  const terminal = process.env.OPENCOLLAB_TERMINAL_ID

  const send = (payload: Record<string, unknown>): void => {
    if (!url || !token || !terminal) return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 500)
    fetch(`${url}/opencode`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-OpenCollab-Terminal": terminal,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
      .catch(() => {})
      .finally(() => clearTimeout(timer))
  }

  return {
    event: async ({ event }: { event: any }) => {
      try {
        if (event?.type === "session.created" || event?.type === "session.updated") {
          const title = event.properties?.info?.title
          if (title) {
            send({ event: event.type, title })
          }
        }
      } catch {}
    },
  }
}
"#;

/// OpenCode: plugin `<raíz>/plugins/opencollab.ts` (`~/.config/opencode`).
pub struct OpenCodePluginInstaller {
    file: PathBuf,
}

impl OpenCodePluginInstaller {
    pub fn new(root: impl AsRef<Path>) -> Self {
        Self {
            file: root.as_ref().join("plugins").join("opencollab.ts"),
        }
    }

    /// `None` si no existe; `Some(contenido)` si existe (propio o no).
    fn read(&self) -> Result<Option<String>, PortError> {
        match fs::read_to_string(&self.file) {
            Ok(t) => Ok(Some(t)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(io_error("no se pudo leer", &self.file, &e)),
        }
    }
}

impl HookInstaller for OpenCodePluginInstaller {
    fn agent(&self) -> KnownAgent {
        KnownAgent::OpenCode
    }

    fn status(&self) -> Result<HookStatus, PortError> {
        Ok(match self.read()? {
            Some(text) if text == PLUGIN_SOURCE => HookStatus::Installed,
            _ => HookStatus::NotInstalled,
        })
    }

    fn install(&self) -> Result<(), PortError> {
        match self.read()? {
            Some(text) if text == PLUGIN_SOURCE => return Ok(()),
            Some(text) if !text.starts_with(PLUGIN_MARKER) => {
                return Err(PortError::new(format!(
                    "{} existe y no es de OpenCollab; no se sobrescribe",
                    self.file.display()
                )));
            }
            _ => {}
        }
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir).map_err(|e| io_error("no se pudo crear", dir, &e))?;
        }
        let tmp = suffixed(&self.file, TMP_SUFFIX);
        fs::write(&tmp, PLUGIN_SOURCE).map_err(|e| io_error("no se pudo escribir", &tmp, &e))?;
        fs::rename(&tmp, &self.file).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            io_error("no se pudo reemplazar", &self.file, &e)
        })
    }

    fn uninstall(&self) -> Result<(), PortError> {
        match self.read()? {
            Some(text) if text.starts_with(PLUGIN_MARKER) => fs::remove_file(&self.file)
                .map_err(|e| io_error("no se pudo borrar", &self.file, &e)),
            // No existe o no es nuestro: nada que quitar.
            _ => Ok(()),
        }
    }
}

// ---------------------------------------------------------------------------
// Antigravity: sin mecanismo
// ---------------------------------------------------------------------------

/// Antigravity CLI: sus hooks no tienen eventos de subagente. `status` es
/// siempre `Unsupported`; `install` / `uninstall` fallan con un error claro
/// (nunca modifican nada), para que la UI no ofrezca una instalación falsa.
pub struct AntigravityHookInstaller;

impl HookInstaller for AntigravityHookInstaller {
    fn agent(&self) -> KnownAgent {
        KnownAgent::AntigravityCli
    }

    fn status(&self) -> Result<HookStatus, PortError> {
        Ok(HookStatus::Unsupported)
    }

    fn install(&self) -> Result<(), PortError> {
        Err(unsupported())
    }

    fn uninstall(&self) -> Result<(), PortError> {
        Err(unsupported())
    }
}

fn unsupported() -> PortError {
    PortError::new("Antigravity CLI no expone eventos de subagente: no hay hooks que instalar")
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use application::{HookEndpoint, TrackAgentSessionTitle};
    use uuid::Uuid;

    use super::*;
    use crate::OpenCodeTranslator;

    /// Directorio temporal único, borrado al soltarlo.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("opencollab-hooks-{}", Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn parse(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    const FOREIGN: &str = r#"{
  "model": "opus",
  "permissions": { "allow": ["Bash(ls)"] },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo pre" }] }
    ],
    "UserPromptSubmit": [
      { "matcher": "Explore", "hooks": [{ "type": "command", "command": "echo mio" }] }
    ]
  }
}"#;

    /// Misma batería para los dos instaladores JSON.
    macro_rules! json_installer_tests {
        ($name:ident, $ctor:expr, $file:expr, $agent_id:expr, $is_async:expr) => {
            mod $name {
                use super::*;

                const BIN: &str = "/opt/my tools/opencollab-hook";

                fn make(root: &Path) -> Box<dyn HookInstaller> {
                    Box::new($ctor(root, BIN))
                }

                fn command() -> String {
                    format!("\"{BIN}\" {}", $agent_id)
                }

                /// Nuestros hooks internos de un evento.
                fn ours(doc: &Value, event: &str) -> Vec<Value> {
                    doc["hooks"][event]
                        .as_array()
                        .unwrap()
                        .iter()
                        .flat_map(|g| g["hooks"].as_array().unwrap().clone())
                        .filter(|h| h["command"].as_str().unwrap().contains("opencollab-hook"))
                        .collect()
                }

                #[test]
                fn install_creates_the_file_with_event() {
                    let tmp = TempDir::new();
                    let installer = make(tmp.path());
                    assert_eq!(installer.status(), Ok(HookStatus::NotInstalled));
                    installer.install().unwrap();
                    assert_eq!(installer.status(), Ok(HookStatus::Installed));
                    let doc = parse(&tmp.path().join($file));
                    for event in HOOK_EVENTS {
                        let hooks = ours(&doc, event);
                        assert_eq!(hooks.len(), 1, "{event}");
                        assert_eq!(hooks[0]["type"], "command");
                        assert_eq!(hooks[0]["command"], command());
                        assert_eq!(hooks[0]["async"] == true, $is_async);
                    }
                }

                #[test]
                fn install_creates_missing_directories() {
                    let tmp = TempDir::new();
                    let root = tmp.path().join("no").join("existe");
                    make(&root).install().unwrap();
                    assert!(root.join($file).is_file());
                    // No había nada que respaldar.
                    assert!(!suffixed(&root.join($file), BACKUP_SUFFIX).exists());
                }

                #[test]
                fn install_preserves_foreign_config_and_uninstall_restores_it() {
                    let tmp = TempDir::new();
                    let file = tmp.path().join($file);
                    fs::write(&file, FOREIGN).unwrap();
                    let original: Value = serde_json::from_str(FOREIGN).unwrap();

                    let installer = make(tmp.path());
                    installer.install().unwrap();
                    let doc = parse(&file);
                    assert_eq!(doc["model"], "opus");
                    assert_eq!(doc["permissions"], original["permissions"]);
                    assert_eq!(doc["hooks"]["PreToolUse"], original["hooks"]["PreToolUse"]);
                    // El grupo ajeno de UserPromptSubmit sigue, y el nuestro se sumó.
                    assert_eq!(
                        doc["hooks"]["UserPromptSubmit"][0],
                        original["hooks"]["UserPromptSubmit"][0]
                    );
                    assert_eq!(ours(&doc, "UserPromptSubmit").len(), 1);

                    installer.uninstall().unwrap();
                    assert_eq!(parse(&file), original);
                    assert_eq!(installer.status(), Ok(HookStatus::NotInstalled));
                }

                #[test]
                fn uninstall_after_install_on_empty_object_leaves_it_empty() {
                    let tmp = TempDir::new();
                    let file = tmp.path().join($file);
                    fs::write(&file, "{}").unwrap();
                    let installer = make(tmp.path());
                    installer.install().unwrap();
                    installer.uninstall().unwrap();
                    assert_eq!(parse(&file), json!({}));
                }

                #[test]
                fn install_twice_does_not_duplicate() {
                    let tmp = TempDir::new();
                    let file = tmp.path().join($file);
                    fs::write(&file, FOREIGN).unwrap();
                    let installer = make(tmp.path());
                    installer.install().unwrap();
                    let first = fs::read_to_string(&file).unwrap();
                    installer.install().unwrap();
                    assert_eq!(fs::read_to_string(&file).unwrap(), first);
                    let doc = parse(&file);
                    assert_eq!(ours(&doc, "UserPromptSubmit").len(), 1);
                }

                #[test]
                fn install_backs_up_the_existing_file() {
                    let tmp = TempDir::new();
                    let file = tmp.path().join($file);
                    fs::write(&file, FOREIGN).unwrap();
                    make(tmp.path()).install().unwrap();
                    let backup = suffixed(&file, BACKUP_SUFFIX);
                    assert_eq!(fs::read_to_string(backup).unwrap(), FOREIGN);
                    assert!(!suffixed(&file, TMP_SUFFIX).exists());
                }

                #[test]
                fn malformed_json_is_an_error_and_the_file_is_untouched() {
                    let tmp = TempDir::new();
                    let file = tmp.path().join($file);
                    fs::write(&file, "{ esto no es json").unwrap();
                    let installer = make(tmp.path());
                    assert!(installer.status().is_err());
                    assert!(installer.install().is_err());
                    assert!(installer.uninstall().is_err());
                    assert_eq!(fs::read_to_string(&file).unwrap(), "{ esto no es json");
                    assert!(!suffixed(&file, BACKUP_SUFFIX).exists());
                }

                #[test]
                fn unexpected_shapes_are_refused_untouched() {
                    for body in [
                        "[]",
                        r#"{"hooks": []}"#,
                        r#"{"hooks": {"UserPromptSubmit": {}}}"#,
                    ] {
                        let tmp = TempDir::new();
                        let file = tmp.path().join($file);
                        fs::write(&file, body).unwrap();
                        assert!(make(tmp.path()).install().is_err(), "{body}");
                        assert_eq!(fs::read_to_string(&file).unwrap(), body);
                    }
                }

                #[test]
                fn stale_binary_path_is_updated_in_place() {
                    let tmp = TempDir::new();
                    $ctor(tmp.path(), "/viejo/opencollab-hook")
                        .install()
                        .unwrap();
                    let installer = make(tmp.path());
                    assert_eq!(installer.status(), Ok(HookStatus::NotInstalled));
                    installer.install().unwrap();
                    assert_eq!(installer.status(), Ok(HookStatus::Installed));
                    let doc = parse(&tmp.path().join($file));
                    let hooks = ours(&doc, "UserPromptSubmit");
                    assert_eq!(hooks.len(), 1);
                    assert_eq!(hooks[0]["command"], command());
                }

                #[test]
                fn uninstall_without_a_file_is_a_noop() {
                    let tmp = TempDir::new();
                    make(tmp.path()).uninstall().unwrap();
                    assert!(!tmp.path().join($file).exists());
                }

                #[test]
                fn windows_paths_use_forward_slashes_in_the_command() {
                    let tmp = TempDir::new();
                    $ctor(
                        tmp.path(),
                        r"C:\Program Files\OpenCollab\opencollab-hook.exe",
                    )
                    .install()
                    .unwrap();
                    let doc = parse(&tmp.path().join($file));
                    assert_eq!(
                        ours(&doc, "UserPromptSubmit")[0]["command"],
                        format!(
                            "\"C:/Program Files/OpenCollab/opencollab-hook.exe\" {}",
                            $agent_id
                        )
                    );
                }

                #[test]
                fn reports_its_agent() {
                    let tmp = TempDir::new();
                    assert_eq!(make(tmp.path()).agent().id(), $agent_id);
                }
            }
        };
    }

    json_installer_tests!(
        claude_code,
        ClaudeCodeHookInstaller::new,
        "settings.json",
        "claude-code",
        false
    );
    json_installer_tests!(codex, CodexHookInstaller::new, "hooks.json", "codex", true);

    // --- OpenCode ---------------------------------------------------------

    fn plugin_file(root: &Path) -> PathBuf {
        root.join("plugins").join("opencollab.ts")
    }

    #[test]
    fn plugin_install_writes_a_marked_file() {
        let tmp = TempDir::new();
        let installer = OpenCodePluginInstaller::new(tmp.path());
        assert_eq!(installer.status(), Ok(HookStatus::NotInstalled));
        installer.install().unwrap();
        assert_eq!(installer.status(), Ok(HookStatus::Installed));
        let source = fs::read_to_string(plugin_file(tmp.path())).unwrap();
        assert!(source.starts_with(PLUGIN_MARKER));
        assert_eq!(installer.agent(), KnownAgent::OpenCode);
    }

    #[test]
    fn plugin_source_follows_the_receiver_contract() {
        for needle in [
            HookEndpoint::ENV_URL,
            HookEndpoint::ENV_TOKEN,
            HookEndpoint::ENV_TERMINAL_ID,
            "/opencode",
            "Authorization",
            "Bearer",
            "X-OpenCollab-Terminal",
            "AbortController",
            "session.created",
            "session.updated",
        ] {
            assert!(PLUGIN_SOURCE.contains(needle), "falta {needle}");
        }
    }

    /// El plugin arma sus cuerpos con estas claves; el traductor las entiende.
    #[test]
    fn plugin_bodies_are_accepted_by_the_translator() {
        for needle in [
            "event?.type === \"session.created\"",
            "event?.type === \"session.updated\"",
            "title",
        ] {
            assert!(PLUGIN_SOURCE.contains(needle), "falta {needle}");
        }
        let tracker = TrackAgentSessionTitle::new(vec![Arc::new(OpenCodeTranslator)]);
        let terminal = domain::TerminalId::new();
        let payload = json!({"event": "session.created", "title": "Refactor de auth"});
        let result = tracker
            .handle(application::RawSessionEvent {
                terminal_id: terminal,
                agent: KnownAgent::OpenCode,
                payload: payload.to_string(),
            })
            .unwrap();
        assert_eq!(result, Some("Refactor de auth".to_string()));
        assert_eq!(
            tracker.title(terminal),
            Some("Refactor de auth".to_string())
        );
    }

    #[test]
    fn plugin_install_twice_is_stable() {
        let tmp = TempDir::new();
        let installer = OpenCodePluginInstaller::new(tmp.path());
        installer.install().unwrap();
        let first = fs::read_to_string(plugin_file(tmp.path())).unwrap();
        installer.install().unwrap();
        assert_eq!(fs::read_to_string(plugin_file(tmp.path())).unwrap(), first);
    }

    #[test]
    fn plugin_uninstall_removes_only_our_file() {
        let tmp = TempDir::new();
        let installer = OpenCodePluginInstaller::new(tmp.path());
        installer.install().unwrap();
        installer.uninstall().unwrap();
        assert!(!plugin_file(tmp.path()).exists());
        assert_eq!(installer.status(), Ok(HookStatus::NotInstalled));
        // Sin archivo, desinstalar no falla.
        installer.uninstall().unwrap();
    }

    #[test]
    fn plugin_never_overwrites_or_deletes_a_foreign_file() {
        let tmp = TempDir::new();
        let file = plugin_file(tmp.path());
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "export const Mio = async () => ({})").unwrap();
        let installer = OpenCodePluginInstaller::new(tmp.path());
        assert_eq!(installer.status(), Ok(HookStatus::NotInstalled));
        assert!(installer.install().is_err());
        installer.uninstall().unwrap();
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "export const Mio = async () => ({})"
        );
    }

    #[test]
    fn outdated_plugin_is_reinstalled() {
        let tmp = TempDir::new();
        let file = plugin_file(tmp.path());
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, format!("{PLUGIN_MARKER}\n// versión vieja\n")).unwrap();
        let installer = OpenCodePluginInstaller::new(tmp.path());
        assert_eq!(installer.status(), Ok(HookStatus::NotInstalled));
        installer.install().unwrap();
        assert_eq!(installer.status(), Ok(HookStatus::Installed));
        assert_eq!(fs::read_to_string(&file).unwrap(), PLUGIN_SOURCE);
    }

    // --- Antigravity ------------------------------------------------------

    #[test]
    fn antigravity_is_unsupported_and_refuses_changes() {
        let installer = AntigravityHookInstaller;
        assert_eq!(installer.agent(), KnownAgent::AntigravityCli);
        assert_eq!(installer.status(), Ok(HookStatus::Unsupported));
        assert!(installer.install().is_err());
        assert!(installer.uninstall().is_err());
    }
}
