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
}

impl KnownAgent {
    pub const ALL: [KnownAgent; 4] = [
        KnownAgent::ClaudeCode,
        KnownAgent::OpenCode,
        KnownAgent::Codex,
        KnownAgent::AntigravityCli,
    ];

    /// Identificador estable que viaja al frontend.
    pub fn id(self) -> &'static str {
        match self {
            KnownAgent::ClaudeCode => "claude-code",
            KnownAgent::OpenCode => "opencode",
            KnownAgent::Codex => "codex",
            KnownAgent::AntigravityCli => "antigravity-cli",
        }
    }

    /// Nombres de ejecutable (sin extensión) que identifican al agente.
    fn executables(self) -> &'static [&'static str] {
        match self {
            KnownAgent::ClaudeCode => &["claude"],
            KnownAgent::OpenCode => &["opencode"],
            KnownAgent::Codex => &["codex"],
            KnownAgent::AntigravityCli => &["agy", "antigravity"],
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

/// Busca un agente conocido entre los descendientes de `root` (la shell de la
/// terminal). Si hay varios, gana el más cercano a la shell: es el que lanzó
/// el usuario; los más profundos suelen ser procesos que ese agente lanzó.
pub fn detect_agent(processes: &[ProcessInfo], root: u32) -> Option<KnownAgent> {
    let mut children: HashMap<u32, Vec<&ProcessInfo>> = HashMap::new();
    for process in processes {
        if let Some(parent) = process.parent {
            // Un proceso nunca es su propio hijo (algunos sistemas reportan pid 0 así).
            if parent != process.pid {
                children.entry(parent).or_default().push(process);
            }
        }
    }

    // Recorrido en anchura: el primer agente encontrado es el de menor profundidad.
    let mut level = vec![root];
    let mut visited = std::collections::HashSet::from([root]);
    while !level.is_empty() {
        let mut next = Vec::new();
        for pid in level {
            for child in children.get(&pid).into_iter().flatten() {
                if let Some(agent) = identify(child) {
                    return Some(agent);
                }
                if visited.insert(child.pid) {
                    next.push(child.pid);
                }
            }
        }
        level = next;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(pid: u32, parent: u32, name: &str, args: &[&str]) -> ProcessInfo {
        ProcessInfo {
            pid,
            parent: Some(parent),
            name: name.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
        }
    }

    const SHELL: u32 = 100;

    fn tree(extra: Vec<ProcessInfo>) -> Vec<ProcessInfo> {
        let mut list = vec![proc(SHELL, 1, "powershell.exe", &[])];
        list.extend(extra);
        list
    }

    #[test]
    fn plain_shell_has_no_agent() {
        assert_eq!(detect_agent(&tree(vec![]), SHELL), None);
    }

    #[test]
    fn detects_native_executables() {
        for (exe, agent) in [
            ("claude.exe", KnownAgent::ClaudeCode),
            ("opencode.exe", KnownAgent::OpenCode),
            ("codex.exe", KnownAgent::Codex),
            ("agy.exe", KnownAgent::AntigravityCli),
            ("claude", KnownAgent::ClaudeCode),
        ] {
            let list = tree(vec![proc(200, SHELL, exe, &[])]);
            assert_eq!(detect_agent(&list, SHELL), Some(agent), "{exe}");
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
        assert_eq!(detect_agent(&list, SHELL), Some(KnownAgent::Codex));
    }

    #[test]
    fn unrelated_node_process_is_not_an_agent() {
        let list = tree(vec![proc(200, SHELL, "node.exe", &["node", "server.js"])]);
        assert_eq!(detect_agent(&list, SHELL), None);
    }

    #[test]
    fn helper_processes_with_similar_names_do_not_match() {
        let list = tree(vec![proc(200, SHELL, "codex-command-runner.exe", &[])]);
        assert_eq!(detect_agent(&list, SHELL), None);
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
        assert_eq!(detect_agent(&list, SHELL), Some(KnownAgent::Codex));
    }

    #[test]
    fn the_agent_closest_to_the_shell_wins() {
        // Claude Code lanzó Codex como herramienta: la terminal es de Claude Code.
        let list = tree(vec![
            proc(200, SHELL, "claude.exe", &[]),
            proc(300, 200, "codex.exe", &[]),
        ]);
        assert_eq!(detect_agent(&list, SHELL), Some(KnownAgent::ClaudeCode));
    }

    #[test]
    fn ignores_agents_outside_the_terminal() {
        let list = tree(vec![proc(200, 999, "claude.exe", &[])]);
        assert_eq!(detect_agent(&list, SHELL), None);
    }

    #[test]
    fn survives_cycles_in_reported_parents() {
        let list = vec![
            proc(SHELL, 300, "powershell.exe", &[]),
            proc(200, SHELL, "cmd.exe", &[]),
            proc(300, 200, "cmd.exe", &[]),
        ];
        assert_eq!(detect_agent(&list, SHELL), None);
    }
}
