// Directorio actual de una terminal: lo reporta la shell con OSC 7
// (ver crates/infrastructure/src/shell.rs) y se cambia escribiéndole un `cd`.

const isWindowsPath = (path: string) => /^[A-Za-z]:/.test(path);

/// `file://host/C:/Users/x` → `C:\Users\x`; `file://host/home/x` → `/home/x`.
export function parseOsc7(data: string): string | null {
  const match = /^file:\/\/[^/]*(\/.*)$/.exec(data);
  if (!match) return null;
  let path = match[1];
  try {
    path = decodeURIComponent(path);
  } catch {
    // Ruta no codificada con un `%` literal: se usa tal cual.
  }
  const windows = path.slice(1);
  if (isWindowsPath(windows)) {
    const p = windows.replace(/\//g, "\\");
    return p.length === 2 ? `${p}\\` : p; // `C:` → `C:\`
  }
  return path;
}

/// Directorios padre, del más cercano a la raíz: `C:\a\b` → [`C:\a`, `C:\`].
export function parentDirectories(path: string): string[] {
  const sep = isWindowsPath(path) ? "\\" : "/";
  const parts = path.split(sep).filter(Boolean);
  const parents: string[] = [];
  for (let n = parts.length - 1; n >= 1; n--) {
    const joined = parts.slice(0, n).join(sep);
    parents.push(sep === "\\" ? (n === 1 ? `${joined}\\` : joined) : `/${joined}`);
  }
  if (sep === "/" && path !== "/") parents.push("/");
  return parents;
}

/// `C:\a` + `b` → `C:\a\b`; `C:\` + `b` → `C:\b`; `/a` + `b` → `/a/b`.
export function joinPath(dir: string, name: string): string {
  const sep = isWindowsPath(dir) ? "\\" : "/";
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/// Comando para cambiar de directorio en la shell dada, con la ruta escapada.
export function cdCommand(shellName: string, path: string): string {
  const shell = shellName.toLowerCase();
  if (shell.includes("powershell") || shell === "pwsh") {
    return `Set-Location -LiteralPath '${path.replace(/'/g, "''")}'\r`;
  }
  if (shell === "cmd") return `cd /d "${path}"\r`;
  return `cd '${path.replace(/'/g, `'\\''`)}'\r`;
}
