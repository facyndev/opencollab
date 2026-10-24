export interface ClipboardAdapter {
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
}

export interface TerminalLike {
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  paste(data: string): void;
  selectAll(): void;
  clear(): void;
}

const defaultClipboard: ClipboardAdapter = {
  writeText: async (text: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    }
  },
  readText: async () => {
    if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
      return navigator.clipboard.readText();
    }
    return "";
  },
};

export async function copyTextToClipboard(
  text: string,
  clipboard: ClipboardAdapter = defaultClipboard,
): Promise<boolean> {
  if (!text) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function copyTerminalSelection(
  term: TerminalLike,
  clipboard: ClipboardAdapter = defaultClipboard,
): boolean {
  if (!term.hasSelection()) return false;
  const selection = term.getSelection();
  if (!selection) return false;
  void copyTextToClipboard(selection, clipboard);
  term.clearSelection();
  return true;
}

export async function pasteFromClipboard(
  term: TerminalLike,
  clipboard: ClipboardAdapter = defaultClipboard,
): Promise<void> {
  try {
    const text = await clipboard.readText();
    if (text) term.paste(text);
  } catch {
    // El permiso de portapapeles puede fallar o estar vacío; se ignora sin romper la sesión.
  }
}

/// Manejador para `term.attachCustomKeyEventHandler`:
/// - `Ctrl+C` / `Cmd+C` con selección activa copia al portapapeles y evita mandar `SIGINT` (`\x03`).
/// - `Ctrl+C` / `Cmd+C` sin selección deja pasar el evento para interrumpir el proceso en el PTY.
/// - `Ctrl+Shift+C` siempre actúa como atajo explícito de copia y nunca envía `SIGINT`.
/// - `Ctrl+V` / `Ctrl+Shift+V` pega desde el portapapeles usando `term.paste` sin enviar `\x16`.
export function createTerminalKeyEventHandler(
  term: TerminalLike,
  clipboard: ClipboardAdapter = defaultClipboard,
): (e: KeyboardEvent) => boolean {
  return (e: KeyboardEvent): boolean => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return true;

    const key = e.key.toLowerCase();

    if (key === "c") {
      if (e.shiftKey) {
        if (e.type === "keydown") {
          copyTerminalSelection(term, clipboard);
        }
        return false;
      }
      if (term.hasSelection()) {
        if (e.type === "keydown") {
          copyTerminalSelection(term, clipboard);
        }
        return false;
      }
      return true;
    }

    if (key === "v") {
      e.preventDefault();
      if (e.type === "keydown") {
        void pasteFromClipboard(term, clipboard);
      }
      return false;
    }

    return true;
  };
}
