import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { createPkcePair, isAuthCallback, type AuthState, type AuthUser } from "./auth";

type ChangedPayload = { user: AuthUser | null };

/// Sesión del desktop: el núcleo guarda los tokens, acá solo vive el usuario.
/// `beginLogin` genera el PKCE, abre la web en el navegador y el regreso llega
/// por el deep link `opencollab://auth/callback` (también si la app se abrió
/// por ese link). Fuera de Tauri (E2E con mock) los comandos responden stub.
export function useAuth() {
  const [state, setState] = useState<AuthState>({ status: "unknown" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /// URL de login por si el navegador no se abrió (el usuario la abre a mano).
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const finishing = useRef(false);

  const finishUrl = useCallback(async (url: string) => {
    if (!isAuthCallback(url) || finishing.current) return;
    finishing.current = true;
    setBusy(true);
    setError(null);
    try {
      const user = await invoke<AuthUser>("auth_finish", { callbackUrl: url });
      setLoginUrl(null);
      setState({ status: "authenticated", user });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      finishing.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    let stopAuth: (() => void) | undefined;
    let stopLinks: (() => void) | undefined;
    (async () => {
      try {
        const user = await invoke<AuthUser | null>("auth_status");
        if (active) setState(user ? { status: "authenticated", user } : { status: "anonymous" });
      } catch {
        if (active) setState({ status: "anonymous" });
      }
      try {
        stopAuth = await listen<ChangedPayload>("auth-changed", ({ payload }) => {
          if (!active) return;
          setState(payload.user ? { status: "authenticated", user: payload.user } : { status: "anonymous" });
        });
      } catch {
        // Sin eventos (mock): la UI igual funciona por polling de comandos.
      }
      try {
        const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
        const start = await getCurrent().catch(() => null);
        for (const url of start ?? []) void finishUrl(url);
        stopLinks = await onOpenUrl((urls) => {
          for (const url of urls) void finishUrl(url);
        });
      } catch {
        // Sin deep links (navegador/E2E): no hay regreso que escuchar.
      }
    })();
    return () => {
      active = false;
      stopAuth?.();
      stopLinks?.();
    };
  }, [finishUrl]);

  const beginLogin = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { verifier, challenge } = await createPkcePair();
      const url = await invoke<string>("auth_begin_login", { challenge, verifier });
      setLoginUrl(url);
      // El navegador se abrió en el núcleo; el regreso llega por deep link.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, []);

  // `busy` por el regreso del navegador lo maneja `finishUrl`; acá solo se
  // limpia si el login nunca volvió (el usuario cerró el navegador).
  const cancelLogin = useCallback(() => {
    setLoginUrl(null);
    setBusy(false);
  }, []);

  const logout = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke("auth_logout");
      setLoginUrl(null);
      setState({ status: "anonymous" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return { state, busy, error, loginUrl, beginLogin, cancelLogin, logout };
}
