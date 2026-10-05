//! Detección del agente de IA que corre dentro de una terminal, a partir del
//! árbol de procesos de su shell. El dominio sigue siendo agnóstico: el
//! catálogo de agentes conocidos es solo un detalle de presentación.

use std::collections::HashMap;

/// Agentes que la app sabe reconocer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum KnownAgent {
    ClaudeCode,
    OpenCode,
    Codex,
    AntigravityCli,
    Grok,
}

impl KnownAgent {
    pub const ALL: [KnownAgent; 5] = [
        KnownAgent::ClaudeCode,
        KnownAgent::OpenCode,
        KnownAgent::Codex,
        KnownAgent::AntigravityCli,
        KnownAgent::Grok,
    ];

    /// Identificador estable que viaja al frontend.
    pub fn id(self) -> &'static str {
        match self {
            KnownAgent::ClaudeCode => "claude-code",
            KnownAgent::OpenCode => "opencode",
            KnownAgent::Codex => "codex",
            KnownAgent::AntigravityCli => "antigravity-cli",
            KnownAgent::Grok => "grok",
        }
    }

    /// Inversa de [`KnownAgent::id`].
    pub fn from_id(id: &str) -> Option<KnownAgent> {
        KnownAgent::ALL.into_iter().find(|a| a.id() == id)
    }

    /// Nombres de ejecutable (sin extensión) que identifican al agente.
    fn executables(self) -> &'static [&'static str] {
        match self {
            KnownAgent::ClaudeCode => &["claude"],
            KnownAgent::OpenCode => &["opencode"],
            KnownAgent::Codex => &["codex"],
            KnownAgent::AntigravityCli => &["agy", "antigravity"],
            KnownAgent::Grok => &["grok", "grok-cli"],
        }
    }

    /// Paquetes npm que delatan al agente cuando corre como script de un runtime
    /// (`node .../@openai/codex/bin/codex.js`).
    fn package_markers(self) -> &'static [&'static str] {
        match self {
            KnownAgent::ClaudeCode => &["@anthropic-ai/claude-code"],
            KnownAgent::OpenCode => &["opencode-ai"],
            KnownAgent::Codex => &["@openai/codex"],
            KnownAgent::AntigravityCli => &[],
            KnownAgent::Grok => &["@xai-official/grok"],
        }
    }
}

/// Lo mínimo que la detección necesita saber de un proceso del sistema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessInfo {
    pub pid: u32,
    pub parent: Option<u32>,
    /// Nombre del ejecutable, con o sin extensión (`claude.exe`, `node`).
    pub name: String,
    pub args: Vec<String>,
    /// Instante de arranque, en segundos desde la época Unix (`None` si no se conoce).
    pub started_at: Option<u64>,
}

const SCRIPT_RUNTIMES: [&str; 3] = ["node", "bun", "deno"];

fn stem(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    let file = lower.rsplit(['/', '\\']).next().unwrap_or(&lower);
    file.strip_suffix(".exe").unwrap_or(file).to_string()
}

fn identify(process: &ProcessInfo) -> Option<KnownAgent> {
    let name = stem(&process.name);
    if let Some(agent) = KnownAgent::ALL
        .into_iter()
        .find(|a| a.executables().contains(&name.as_str()))
    {
        return Some(agent);
    }
    if !SCRIPT_RUNTIMES.contains(&name.as_str()) {
        return None;
    }
    // Normalizar separadores: en Windows las rutas usan `\`.
    let args: Vec<String> = process
        .args
        .iter()
        .map(|a| a.to_ascii_lowercase().replace('\\', "/"))
        .collect();
    KnownAgent::ALL.into_iter().find(|agent| {
        agent
            .package_markers()
            .iter()
            .any(|marker| args.iter().any(|arg| arg.contains(marker)))
    })
}

/// Agentes conocidos corriendo en una terminal: el principal (el más cercano a
/// la shell, o sea el que lanzó el usuario) y los que ese agente tiene debajo.
///
/// Son agentes *anidados*, no los subagentes internos de un agente: Claude Code,
/// OpenCode y Codex corren sus subagentes dentro del mismo proceso, así que no
/// aparecen en el árbol de procesos. Lo que sí aparece son otros CLIs que un
/// agente lanza como herramienta.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentTree {
    pub primary: Option<KnownAgent>,
    /// Arranque del proceso del agente principal (segundos desde la época Unix).
    pub primary_started_at: Option<u64>,
    /// Agentes conocidos por debajo del principal, del más cercano al shell al
    /// más profundo, sin repetir.
    pub nested: Vec<KnownAgent>,
}

/// Busca los agentes conocidos entre los descendientes de `root` (la shell de la
/// terminal). El recorrido es en anchura, así que el primero encontrado es el más
/// cercano a la shell y ese es el principal; los demás son los que él lanzó.
pub fn detect_agents(processes: &[ProcessInfo], root: u32) -> AgentTree {
    let mut children: HashMap<u32, Vec<&ProcessInfo>> = HashMap::new();
    for process in processes {
        if let Some(parent) = process.parent {
            // Un proceso nunca es su propio hijo (algunos sistemas reportan pid 0 así).
            if parent != process.pid {
                children.entry(parent).or_default().push(process);
            }
        }
    }

    // Acumula en orden de anchura (menor profundidad primero) y sin repetir.
    let mut found: Vec<KnownAgent> = Vec::new();
    let mut primary_started_at = None;
    let mut level = vec![root];
    let mut visited = std::collections::HashSet::from([root]);
    while !level.is_empty() {
        let mut next = Vec::new();
        for pid in level {
            for child in children.get(&pid).into_iter().flatten() {
                if let Some(agent) = identify(child) {
                    if !found.contains(&agent) {
                        if found.is_empty() {
                            primary_started_at = child.started_at;
                        }
                        found.push(agent);
                    }
                }
                // Aunque sea un agente, sigue bajando: puede tener otros debajo.
                if visited.insert(child.pid) {
                    next.push(child.pid);
                }
            }
        }
        level = next;
    }

    let mut found = found.into_iter();
    AgentTree {
        primary: found.next(),
        primary_started_at,
        nested: found.collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_id_round_trips_every_known_agent() {
        for agent in KnownAgent::ALL {
            assert_eq!(KnownAgent::from_id(agent.id()), Some(agent));
        }
        assert_eq!(KnownAgent::from_id("otro"), None);
    }

    fn proc(pid: u32, parent: u32, name: &str, args: &[&str]) -> ProcessInfo {
        ProcessInfo {
            pid,
            parent: Some(parent),
            name: name.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
            started_at: None,
        }
    }

    fn started(mut process: ProcessInfo, at: u64) -> ProcessInfo {
        process.started_at = Some(at);
        process
    }

    const SHELL: u32 = 100;

    fn tree(extra: Vec<ProcessInfo>) -> Vec<ProcessInfo> {
        let mut list = vec![proc(SHELL, 1, "powershell.exe", &[])];
        list.extend(extra);
        list
    }

    #[test]
    fn plain_shell_has_no_agent() {
        assert_eq!(detect_agents(&tree(vec![]), SHELL).primary, None);
    }

    #[test]
    fn detects_native_executables() {
        for (exe, agent) in [
            ("claude.exe", KnownAgent::ClaudeCode),
            ("opencode.exe", KnownAgent::OpenCode),
            ("codex.exe", KnownAgent::Codex),
            ("agy.exe", KnownAgent::AntigravityCli),
            ("claude", KnownAgent::ClaudeCode),
            ("grok.exe", KnownAgent::Grok),
            ("grok", KnownAgent::Grok),
            ("grok-cli", KnownAgent::Grok),
        ] {
            let list = tree(vec![proc(200, SHELL, exe, &[])]);
            assert_eq!(detect_agents(&list, SHELL).primary, Some(agent), "{exe}");
        }
    }

    #[test]
    fn detects_npm_scripts_run_by_node() {
        let list = tree(vec![proc(
            200,
            SHELL,
            "node.exe",
            &[
                "node",
                r"C:\Users\u\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js",
            ],
        )]);
        assert_eq!(detect_agents(&list, SHELL).primary, Some(KnownAgent::Codex));

        let list_grok = tree(vec![proc(
            200,
            SHELL,
            "node.exe",
            &[
                "node",
                r"C:\Users\u\AppData\Roaming\npm\node_modules\@xai-official\grok\bin\grok.js",
            ],
        )]);
        assert_eq!(
            detect_agents(&list_grok, SHELL).primary,
            Some(KnownAgent::Grok)
        );
    }

    #[test]
    fn unrelated_node_process_is_not_an_agent() {
        let list = tree(vec![proc(200, SHELL, "node.exe", &["node", "server.js"])]);
        assert_eq!(detect_agents(&list, SHELL).primary, None);
    }

    #[test]
    fn helper_processes_with_similar_names_do_not_match() {
        let list = tree(vec![proc(200, SHELL, "codex-command-runner.exe", &[])]);
        assert_eq!(detect_agents(&list, SHELL).primary, None);
    }

    #[test]
    fn finds_agents_nested_below_the_shell() {
        // powershell -> cmd -> node codex.js -> codex.exe
        let list = tree(vec![
            proc(200, SHELL, "cmd.exe", &[]),
            proc(
                300,
                200,
                "node.exe",
                &["node", "/x/@openai/codex/bin/codex.js"],
            ),
            proc(400, 300, "codex.exe", &[]),
        ]);
        assert_eq!(detect_agents(&list, SHELL).primary, Some(KnownAgent::Codex));
    }

    #[test]
    fn the_agent_closest_to_the_shell_wins() {
        // Claude Code lanzó Codex como herramienta: la terminal es de Claude Code,
        // y Codex queda anidado debajo.
        let list = tree(vec![
            proc(200, SHELL, "claude.exe", &[]),
            proc(300, 200, "codex.exe", &[]),
        ]);
        assert_eq!(
            detect_agents(&list, SHELL),
            AgentTree {
                primary: Some(KnownAgent::ClaudeCode),
                primary_started_at: None,
                nested: vec![KnownAgent::Codex],
            }
        );
    }

    #[test]
    fn lists_every_known_agent_nested_below_the_primary() {
        // powershell -> claude -> {codex, opencode -> agy}
        let list = tree(vec![
            proc(200, SHELL, "claude.exe", &[]),
            proc(300, 200, "codex.exe", &[]),
            proc(400, 200, "opencode.exe", &[]),
            proc(500, 400, "agy.exe", &[]),
        ]);
        assert_eq!(
            detect_agents(&list, SHELL),
            AgentTree {
                primary: Some(KnownAgent::ClaudeCode),
                primary_started_at: None,
                // Orden de anchura: Codex y OpenCode cuelgan del mismo nivel, y el
                // Antigravity cuelga de OpenCode.
                nested: vec![
                    KnownAgent::Codex,
                    KnownAgent::OpenCode,
                    KnownAgent::AntigravityCli,
                ],
            }
        );
    }

    #[test]
    fn repeated_agents_of_the_same_kind_count_once() {
        // Tres codex debajo del mismo claude: el hilo muestra un solo Codex.
        let list = tree(vec![
            proc(200, SHELL, "claude.exe", &[]),
            proc(300, 200, "codex.exe", &[]),
            proc(301, 200, "codex.exe", &[]),
            proc(302, 200, "codex.exe", &[]),
        ]);
        assert_eq!(
            detect_agents(&list, SHELL),
            AgentTree {
                primary: Some(KnownAgent::ClaudeCode),
                primary_started_at: None,
                nested: vec![KnownAgent::Codex],
            }
        );
    }

    #[test]
    fn a_deeper_agent_does_not_become_the_primary() {
        // Gana el más cercano a la shell, aunque haya otro agente más abajo.
        let list = tree(vec![
            proc(200, SHELL, "opencode.exe", &[]),
            proc(300, 200, "cmd.exe", &[]),
            proc(400, 300, "claude.exe", &[]),
        ]);
        let detected = detect_agents(&list, SHELL);
        assert_eq!(detected.primary, Some(KnownAgent::OpenCode));
        assert_eq!(detected.nested, vec![KnownAgent::ClaudeCode]);
    }

    #[test]
    fn ignores_agents_outside_the_terminal() {
        let list = tree(vec![proc(200, 999, "claude.exe", &[])]);
        assert_eq!(detect_agents(&list, SHELL).primary, None);
    }

    #[test]
    fn survives_cycles_in_reported_parents() {
        let list = vec![
            proc(SHELL, 300, "powershell.exe", &[]),
            proc(200, SHELL, "cmd.exe", &[]),
            proc(300, 200, "cmd.exe", &[]),
        ];
        assert_eq!(detect_agents(&list, SHELL).primary, None);
    }

    #[test]
    fn reports_when_the_primary_agent_started() {
        // El que cuenta es el proceso del agente principal, no el de la shell ni el de un anidado.
        let list = vec![
            started(proc(SHELL, 1, "powershell.exe", &[]), 1_000),
            started(proc(200, SHELL, "claude.exe", &[]), 2_000),
            started(proc(300, 200, "codex.exe", &[]), 3_000),
        ];
        let detected = detect_agents(&list, SHELL);
        assert_eq!(detected.primary, Some(KnownAgent::ClaudeCode));
        assert_eq!(detected.primary_started_at, Some(2_000));
    }

    #[test]
    fn start_time_is_unknown_when_the_process_does_not_report_it() {
        let list = tree(vec![proc(200, SHELL, "claude.exe", &[])]);
        assert_eq!(detect_agents(&list, SHELL).primary_started_at, None);
    }

    #[test]
    fn no_agent_means_no_start_time() {
        let list = vec![started(proc(SHELL, 1, "powershell.exe", &[]), 1_000)];
        assert_eq!(detect_agents(&list, SHELL).primary_started_at, None);
    }
}
