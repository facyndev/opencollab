// En macOS los atajos van con ⌘; en Windows/Linux con Ctrl.
export const isMac = navigator.userAgent.includes("Mac");
export const modKey = isMac ? "⌘" : "Ctrl+";
export const shiftKey = isMac ? "⇧" : "Shift+";

export const isMod = (e: KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);
