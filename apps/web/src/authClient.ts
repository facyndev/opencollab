// Auth client for the web gateway. The access token lives only in this module's
// memory; the refresh token is an httpOnly cookie the page never sees. Nothing
// is written to localStorage, sessionStorage or the URL.

export interface UserView {
  id: string;
  username: string;
  email: string | null;
  displayName: string | null;
  emailVerifiedAt: string | null;
}

export type AuthState =
  | { status: "unknown" }
  | { status: "anonymous" }
  | { status: "authenticated"; accessToken: string; user?: UserView };

export interface RegisterInput {
  username: string;
  password: string;
  email?: string;
  displayName?: string;
}

export type Provider = "github" | "google";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface AuthClientDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Web Locks API, or null to fall back to in-tab single-flight only. */
  locks: LockManager | null;
}

export const CSRF_HEADER = "X-OpenCollab-CSRF";
export const REFRESH_LOCK = "opencollab-refresh";

const REFRESH_MARGIN_MS = 60_000;
const MIN_REFRESH_DELAY_MS = 5_000;
const RETRY_DELAY_MS = 30_000;

interface TokenBody {
  accessToken: string;
  expiresIn: number;
  user?: UserView;
}

async function errorOf(response: Response): Promise<ApiError> {
  let message = response.statusText || `HTTP ${response.status}`;
  try {
    const body: unknown = await response.json();
    const raw = (body as { message?: unknown } | null)?.message;
    if (typeof raw === "string") message = raw;
    else if (Array.isArray(raw)) message = raw.join("; ");
  } catch {
    // Non-JSON body: keep the status text.
  }
  return new ApiError(response.status, message);
}

function defaultDeps(): AuthClientDeps {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    locks: typeof navigator !== "undefined" && navigator.locks ? navigator.locks : null,
  };
}

export function createAuthClient(overrides: Partial<AuthClientDeps> = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  let state: AuthState = { status: "unknown" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<boolean> | undefined;
  const listeners = new Set<() => void>();

  const set = (next: AuthState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const schedule = (expiresIn: number) => {
    clearTimer();
    const delay = Math.max(MIN_REFRESH_DELAY_MS, expiresIn * 1000 - REFRESH_MARGIN_MS);
    timer = setTimeout(() => {
      refresh().catch(() => {
        // Transient failure: keep the session and try again soon.
        clearTimer();
        timer = setTimeout(() => void refresh().catch(() => undefined), RETRY_DELAY_MS);
      });
    }, delay);
  };

  const adopt = (body: TokenBody, previousUser?: UserView) => {
    const user = body.user ?? previousUser;
    set({ status: "authenticated", accessToken: body.accessToken, ...(user ? { user } : {}) });
    schedule(body.expiresIn);
  };

  const webPost = (path: string, body?: unknown) =>
    deps.fetch(`/auth/web/${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        [CSRF_HEADER]: "1",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const bearer = (init: RequestInit = {}): RequestInit => {
    const headers = new Headers(init.headers);
    if (state.status === "authenticated") headers.set("Authorization", `Bearer ${state.accessToken}`);
    return { ...init, headers, credentials: "same-origin" };
  };

  async function doRefresh(): Promise<boolean> {
    const response = await webPost("refresh");
    if (response.status === 401) {
      clearTimer();
      set({ status: "anonymous" });
      return false;
    }
    if (!response.ok) throw await errorOf(response);
    const previous = state.status === "authenticated" ? state.user : undefined;
    adopt((await response.json()) as TokenBody, previous);
    return true;
  }

  function refresh(): Promise<boolean> {
    if (!inflight) {
      // The lock serializes tabs: a tab that waits sees the cookie the winner just
      // rotated, instead of replaying the old one and tripping reuse detection.
      const run = deps.locks ? deps.locks.request(REFRESH_LOCK, doRefresh) : doRefresh();
      inflight = Promise.resolve(run).finally(() => {
        inflight = undefined;
      });
    }
    return inflight;
  }

  async function credentials(path: string, body: unknown): Promise<UserView> {
    const response = await webPost(path, body);
    if (!response.ok) throw await errorOf(response);
    const data = (await response.json()) as TokenBody & { user: UserView };
    adopt(data);
    return data.user;
  }

  async function authed(path: string, init: RequestInit = {}): Promise<Response> {
    let response = await deps.fetch(path, bearer(init));
    if (response.status === 401 && (await refresh())) response = await deps.fetch(path, bearer(init));
    if (!response.ok) throw await errorOf(response);
    return response;
  }

  return {
    getState: (): AuthState => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    login: (identifier: string, password: string) => credentials("login", { identifier, password }),
    register(input: RegisterInput) {
      const body: Record<string, string> = { username: input.username, password: input.password };
      if (input.email?.trim()) body.email = input.email.trim();
      if (input.displayName?.trim()) body.displayName = input.displayName.trim();
      return credentials("register", body);
    },
    async logout(): Promise<void> {
      clearTimer();
      try {
        await webPost("logout");
      } catch {
        // The cookie may outlive a failed request; the local state is cleared regardless.
      }
      set({ status: "anonymous" });
    },
    async me(): Promise<UserView> {
      const user = (await (await authed("/auth/me")).json()) as UserView;
      if (state.status === "authenticated") set({ ...state, user });
      return user;
    },
    async desktopCode(codeChallenge: string): Promise<string> {
      const response = await webPost("desktop-code", { code_challenge: codeChallenge });
      if (!response.ok) throw await errorOf(response);
      return ((await response.json()) as { redirectUrl: string }).redirectUrl;
    },
    async linkStart(provider: Provider): Promise<string> {
      const response = await authed(`/auth/oauth/${provider}/link/start`, { method: "POST" });
      return ((await response.json()) as { url: string }).url;
    },
  };
}

export type AuthClient = ReturnType<typeof createAuthClient>;
