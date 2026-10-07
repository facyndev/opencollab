import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, REQUEST_TIMEOUT_MS, createAuthClient, type AuthClientDeps } from "./authClient";

const user = { id: "u1", username: "ada", email: null, displayName: null, emailVerifiedAt: null };
const tokens = { accessToken: "access-1", expiresIn: 900, tokenType: "Bearer" };

const json = (status: number, body: unknown = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const build = (fetchImpl: AuthClientDeps["fetch"], extra: Partial<AuthClientDeps> = {}) =>
  createAuthClient({ fetch: fetchImpl, locks: null, ...extra });

describe("auth client requests", () => {
  it("sends the CSRF header and same-origin credentials on every /auth/web call", async () => {
    const fetchMock = vi.fn(async () => json(200, { user, ...tokens }));
    const client = build(fetchMock);
    await client.login("ada", "correct horse battery");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/auth/web/login");
    expect(new Headers(init.headers).get("x-opencollab-csrf")).toBe("1");
    expect(init.credentials).toBe("same-origin");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ identifier: "ada", password: "correct horse battery" });
  });

  it("keeps the access token in memory and exposes it as authenticated state", async () => {
    const client = build(async () => json(200, { user, ...tokens }));
    await client.login("ada", "pw");
    expect(client.getState()).toMatchObject({ status: "authenticated", accessToken: "access-1" });
  });

  it("never writes tokens to web storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const client = build(async () => json(200, { user, ...tokens }));
    await client.login("ada", "pw");
    await client.register({ username: "ada", password: "0123456789" });
    expect(setItem).not.toHaveBeenCalled();
  });

  it("surfaces a 401 from login as an ApiError and does not authenticate", async () => {
    const client = build(async () => json(401, { message: "Invalid credentials" }));
    await expect(client.login("ada", "bad")).rejects.toMatchObject({ status: 401, message: "Invalid credentials" });
    expect(client.getState().status).not.toBe("authenticated");
  });

  it("register posts only the provided optional fields", async () => {
    const fetchMock = vi.fn(async () => json(201, { user, ...tokens }));
    await build(fetchMock).register({ username: "ada", password: "0123456789", email: "", displayName: "Ada" });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({ username: "ada", password: "0123456789", displayName: "Ada" });
  });

  it("logout clears the state and calls the server on success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { user, ...tokens }))
      .mockResolvedValueOnce(json(204));
    const client = build(fetchMock);
    await client.login("ada", "pw");
    await client.logout();
    expect(client.getState().status).toBe("anonymous");
    expect(fetchMock.mock.calls[1]![0]).toBe("/auth/web/logout");
  });

  it("logout rejects and does not claim anonymous when the network fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { user, ...tokens }))
      .mockRejectedValueOnce(new TypeError("offline"));
    const client = build(fetchMock);
    await client.login("ada", "pw");
    await expect(client.logout()).rejects.toBeInstanceOf(TypeError);
    expect(client.getState().status).toBe("authenticated");
  });

  it("logout rejects with an ApiError on a non-2xx response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { user, ...tokens }))
      .mockResolvedValueOnce(json(403, { message: "Forbidden" }));
    const client = build(fetchMock);
    await client.login("ada", "pw");
    await expect(client.logout()).rejects.toMatchObject({ status: 403 });
    expect(client.getState().status).toBe("authenticated");
  });

  it("me() sends the bearer token and not the CSRF header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { user, ...tokens }))
      .mockResolvedValueOnce(json(200, user));
    const client = build(fetchMock);
    await client.login("ada", "pw");
    expect(await client.me()).toEqual(user);
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("/auth/me");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer access-1");
    expect(headers.get("x-opencollab-csrf")).toBeNull();
  });

  it("desktopCode posts the challenge with the CSRF header and returns the redirect URL", async () => {
    const fetchMock = vi.fn(async () => json(200, { redirectUrl: "opencollab://auth/callback?code=abc" }));
    const url = await build(fetchMock).desktopCode("a".repeat(43));
    expect(url).toBe("opencollab://auth/callback?code=abc");
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/auth/web/desktop-code");
    expect(new Headers(init.headers).get("x-opencollab-csrf")).toBe("1");
    expect(JSON.parse(init.body as string)).toEqual({ code_challenge: "a".repeat(43) });
  });

  it("linkStart posts with the bearer token and returns the provider URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { user, ...tokens }))
      .mockResolvedValueOnce(json(200, { url: "https://github.com/login/oauth/authorize?x=1" }));
    const client = build(fetchMock);
    await client.login("ada", "pw");
    expect(await client.linkStart("github")).toBe("https://github.com/login/oauth/authorize?x=1");
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toBe("/auth/oauth/github/link/start");
  });
});

describe("auth client refresh", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("single-flights concurrent refreshes inside a tab", async () => {
    const fetchMock = vi.fn(async () => json(200, tokens));
    const client = build(fetchMock);
    const results = await Promise.all([client.refresh(), client.refresh(), client.refresh()]);
    expect(results).toEqual([true, true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/auth/web/refresh",
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    );
  });

  it("serializes refresh across tabs through navigator.locks", async () => {
    const request = vi.fn(async (_name: string, cb: () => Promise<unknown>) => cb());
    const client = build(async () => json(200, tokens), { locks: { request } as unknown as LockManager });
    await client.refresh();
    expect(request).toHaveBeenCalledWith("opencollab-refresh", expect.any(Function));
  });

  it("falls back to in-tab single-flight when Web Locks is missing", async () => {
    const fetchMock = vi.fn(async () => json(200, tokens));
    const client = build(fetchMock, { locks: null });
    expect(await client.refresh()).toBe(true);
    expect(client.getState().status).toBe("authenticated");
  });

  it("goes logged out on a 401 refresh", async () => {
    const client = build(async () => json(401, { message: "Invalid refresh token" }));
    expect(await client.refresh()).toBe(false);
    expect(client.getState()).toEqual({ status: "anonymous" });
  });

  it("keeps the session on a transient network failure and reports it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, tokens))
      .mockRejectedValueOnce(new TypeError("offline"));
    const client = build(fetchMock);
    await client.refresh();
    await expect(client.refresh()).rejects.toBeInstanceOf(TypeError);
    expect(client.getState().status).toBe("authenticated");
  });

  it("refreshes proactively shortly before the access token expires", async () => {
    const fetchMock = vi.fn(async () => json(200, tokens));
    const client = build(fetchMock);
    await client.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(800_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops the proactive timer on logout", async () => {
    const fetchMock = vi.fn(async () => json(200, tokens));
    const client = build(fetchMock);
    await client.refresh();
    await client.logout();
    const calls = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000_000);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("ignores a refresh that resolves after logout started", async () => {
    let release!: (r: Response) => void;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, tokens))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (release = resolve)))
      .mockResolvedValue(json(204));
    const client = build(fetchMock);
    await client.refresh();
    const pending = client.refresh();
    await client.logout();
    expect(client.getState().status).toBe("anonymous");
    release(json(200, { ...tokens, accessToken: "access-2" }));
    expect(await pending).toBe(false);
    expect(client.getState().status).toBe("anonymous");
    const calls = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000_000);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("notifies subscribers of state changes", async () => {
    const client = build(async () => json(200, tokens));
    const seen: string[] = [];
    client.subscribe(() => seen.push(client.getState().status));
    await client.refresh();
    expect(seen).toContain("authenticated");
  });
});

describe("auth client timeouts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rejects a hanging request after the timeout", async () => {
    const client = build(() => new Promise<Response>(() => undefined));
    const result = expect(client.login("ada", "pw")).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await result;
  });

  it("passes an abort signal to fetch", async () => {
    const fetchMock = vi.fn(async () => json(200, tokens));
    await build(fetchMock).refresh();
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("settles the Web Lock callback when the refresh times out", async () => {
    let settled = false;
    const request = vi.fn(async (_name: string, cb: () => Promise<unknown>) => {
      try {
        return await cb();
      } finally {
        settled = true;
      }
    });
    const client = build(() => new Promise<Response>(() => undefined), { locks: { request } as unknown as LockManager });
    const result = expect(client.refresh()).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await result;
    expect(settled).toBe(true);
  });
});

describe("ApiError", () => {
  it("is an Error carrying the status", () => {
    const e = new ApiError(409, "taken");
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(409);
  });
});
