import { useSyncExternalStore } from "react";

// A tiny history-based router: the app has four pages, a library would be dead weight.

const EVENT = "opencollab:navigate";

export function navigate(path: string, replace = false): void {
  if (replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  window.addEventListener(EVENT, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(EVENT, listener);
  };
}

const snapshot = (): string => window.location.pathname + window.location.search;

export function useLocation(): { pathname: string; search: string } {
  const value = useSyncExternalStore(subscribe, snapshot);
  const at = value.indexOf("?");
  return at < 0 ? { pathname: value, search: "" } : { pathname: value.slice(0, at), search: value.slice(at) };
}
