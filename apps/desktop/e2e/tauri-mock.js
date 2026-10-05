// Núcleo de Tauri simulado para los E2E de la interfaz. Se inyecta en la página
// antes de que cargue la app (evaluateOnNewDocument) y responde los mismos
// comandos y eventos que el núcleo real (apps/desktop/src-tauri/src/commands.rs).
//
// Controles para los tests en `window.__mock`:
//   emit(event, payload)  emite un evento como el núcleo
//   writes                lo que la UI le escribió a cada terminal
//   opened                argumentos de cada open_shell
//   closed                terminalId de cada close_terminal
//   subagents             terminalId -> subagentes devueltos por subagent_snapshot
//   hooks                 agente -> estado ("installed" | "notInstalled" | ...) de hook_status
//   hookCalls             { cmd, agent } de cada install/uninstall_agent_hooks
export function installTauriMock() {
  const listeners = {}; // evento -> [id de callback]
  let callbacks = 0;
  let terminals = 0;
  const writes = [];
  const opened = [];
  const closed = [];
  const subagents = {};
  const hookCalls = [];
  // Estado de los hooks como lo reportaría el núcleo en una máquina limpia.
  const hooks = {
    "claude-code": "notInstalled",
    opencode: "notInstalled",
    codex: "notInstalled",
    "antigravity-cli": "unsupported",
  };
  const encoder = new TextEncoder();

  const emit = (event, payload) =>
    (listeners[event] ?? []).forEach((id) => window[`_${id}`]?.({ event, id: 0, payload }));

  // Lo que haría la shell integration de PowerShell: OSC 7 + prompt.
  const prompt = (terminalId, path) =>
    emit("terminal-output", {
      terminalId,
      data: [...encoder.encode(`\x1b]7;file://localhost/${path.replace(/\\/g, "/")}\x1b\\PS ${path}> `)],
    });

  const tree = {
    "C:\\Users\\facun": ["Desktop", "Documents", "OneDrive", ".cache"],
    "C:\\Users\\facun\\OneDrive": ["Escritorio"],
  };

  window.__mock = { emit, writes, opened, closed, subagents, hooks, hookCalls };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main", windowLabel: "main" },
    },
    transformCallback(fn) {
      const id = ++callbacks;
      window[`_${id}`] = fn;
      return id;
    },
    async invoke(cmd, args) {
      switch (cmd) {
        case "plugin:event|listen":
          (listeners[args.event] ??= []).push(args.handler);
          return args.handler;
        case "open_shell": {
          // Como el núcleo: arranca en `cwd` si es una carpeta conocida; si no, en el home.
          opened.push(args);
          const terminalId = `t${++terminals}`;
          const cwd = args.cwd && args.cwd in tree ? args.cwd : "C:\\Users\\facun";
          setTimeout(() => prompt(terminalId, cwd), 50);
          return { terminalId, name: "PowerShell", cwd };
        }
        case "write_terminal": {
          writes.push(args);
          const cd = /^Set-Location -LiteralPath '(.*)'\r$/.exec(args.data);
          if (cd) setTimeout(() => prompt(args.terminalId, cd[1].replace(/''/g, "'")), 30);
          return null;
        }
        case "close_terminal":
          // Como el núcleo: matar el proceso dispara `terminal-exit` después.
          closed.push(args.terminalId);
          setTimeout(() => emit("terminal-exit", { terminalId: args.terminalId }), 20);
          return null;
        case "subagent_snapshot":
          return { terminalId: args.terminalId, subagents: subagents[args.terminalId] ?? [] };
        case "hook_status":
          return Object.entries(hooks).map(([agent, status]) => ({ agent, status }));
        case "install_agent_hooks":
        case "uninstall_agent_hooks": {
          hookCalls.push({ cmd, agent: args.agent });
          if (!(args.agent in hooks)) throw `agente desconocido: ${args.agent}`;
          if (hooks[args.agent] === "unsupported") throw "Antigravity CLI no expone eventos de subagente";
          hooks[args.agent] = cmd === "install_agent_hooks" ? "installed" : "notInstalled";
          return null;
        }
        case "list_subdirectories":
          return tree[args.path] ?? [];
        default:
          return null;
      }
    },
  };
}
