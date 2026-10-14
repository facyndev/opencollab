import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { createAuthClient } from "./authClient";
import { captureInitialHandoff } from "./handoff";

const user = { id: "u1", username: "ada", email: "ada@example.com", displayName: "Ada L", emailVerifiedAt: null };
const tokens = { accessToken: "access-1", expiresIn: 900, tokenType: "Bearer" };
const challenge = "B".repeat(43);

type Handler = (init: RequestInit) => Response | Promise<Response>;

const json = (status: number, body: unknown = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function setup(path: string, routes: Record<string, Handler> = {}, options: { skipCapture?: boolean } = {}) {
  window.history.replaceState(null, "", path);
  const table: Record<string, Handler> = {
    "POST /auth/web/refresh": () => json(401, { message: "Invalid refresh token" }),
    "GET /auth/me": () => json(200, user),
    "POST /auth/web/logout": () => json(204),
    ...routes,
  };
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const key = `${init.method ?? "GET"} ${input}`;
    calls.push(key);
    const handler = table[key];
    if (!handler) throw new Error(`unexpected request ${key}`);
    return handler(init);
  });
  const client = createAuthClient({ fetch: fetchMock, locks: null });
  if (!options.skipCapture) captureInitialHandoff(window.location);
  const assign = vi.fn();
  render(<App client={client} assign={assign} />);
  return { client, assign, calls, fetchMock };
}

const body = (init: RequestInit) => JSON.parse(init.body as string);

beforeEach(() => sessionStorage.clear());
afterEach(cleanup);

describe("session restore and guards", () => {
  it("restores the session with a silent refresh and shows the account", async () => {
    setup("/account", { "POST /auth/web/refresh": () => json(200, tokens) });
    expect(await screen.findByText("ada@example.com")).toBeTruthy();
    expect(screen.getByText("Ada L")).toBeTruthy();
  });

  it("sends an anonymous visitor of /account to /login", async () => {
    setup("/account");
    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeTruthy();
    expect(window.location.pathname).toBe("/login");
  });

  it("sends the root path to /login when anonymous", async () => {
    setup("/");
    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeTruthy();
  });
});

describe("login", () => {
  it("submits the credentials and lands on the account page", async () => {
    const login = vi.fn((init: RequestInit) => {
      expect(body(init)).toEqual({ identifier: "ada", password: "correct horse battery" });
      return json(200, { user, ...tokens });
    });
    setup("/login", { "POST /auth/web/login": login });
    const ui = userEvent.setup();
    await ui.type(await screen.findByLabelText(/username or email/i), "ada");
    await ui.type(screen.getByLabelText(/^password/i), "correct horse battery");
    await ui.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByText("ada@example.com")).toBeTruthy();
    expect(window.location.pathname).toBe("/account");
    expect(login).toHaveBeenCalledOnce();
  });

  it("shows the server error in a live region", async () => {
    setup("/login", { "POST /auth/web/login": () => json(401, { message: "Invalid credentials" }) });
    const ui = userEvent.setup();
    await ui.type(await screen.findByLabelText(/username or email/i), "ada");
    await ui.type(screen.getByLabelText(/^password/i), "wrong");
    await ui.click(screen.getByRole("button", { name: /sign in/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/invalid credentials/i);
  });

  it("does not send an empty form and flags the fields", async () => {
    const { fetchMock } = setup("/login");
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole("button", { name: /sign in/i }));
    expect(screen.getByLabelText(/username or email/i).getAttribute("aria-invalid")).toBe("true");
    expect(fetchMock.mock.calls.some(([url]) => url === "/auth/web/login")).toBe(false);
  });

  it("explains a ?error= code from the OAuth round trip", async () => {
    setup("/login?error=provider_unavailable");
    expect((await screen.findByRole("alert")).textContent).toMatch(/not available/i);
  });

  it("does not echo an unknown error code", async () => {
    setup("/login?error=%3Cb%3Ehax%3C%2Fb%3E");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toMatch(/hax/);
  });

  it("offers GitHub and Google as full-page navigations", async () => {
    setup("/login");
    const github = await screen.findByRole("link", { name: /github/i });
    const google = screen.getByRole("link", { name: /google/i });
    expect(github.getAttribute("href")).toBe("/auth/oauth/github/start?client=web");
    expect(google.getAttribute("href")).toBe("/auth/oauth/google/start?client=web");
  });
});

describe("register", () => {
  it("validates client-side before sending", async () => {
    const { fetchMock } = setup("/register");
    const ui = userEvent.setup();
    await ui.type(await screen.findByLabelText(/^username/i), "ab");
    await ui.type(screen.getByLabelText(/^password/i), "short");
    await ui.click(screen.getByRole("button", { name: /create account/i }));
    expect(await screen.findByText(/3-32 characters/i)).toBeTruthy();
    expect(screen.getByText(/at least 10 characters/i)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => url === "/auth/web/register")).toBe(false);
  });

  it("registers and lands on the account page, omitting empty optional fields", async () => {
    const register = vi.fn((init: RequestInit) => {
      expect(body(init)).toEqual({ username: "ada", password: "0123456789" });
      return json(201, { user, ...tokens });
    });
    setup("/register", { "POST /auth/web/register": register });
    const ui = userEvent.setup();
    await ui.type(await screen.findByLabelText(/^username/i), "ada");
    await ui.type(screen.getByLabelText(/^password/i), "0123456789");
    await ui.click(screen.getByRole("button", { name: /create account/i }));
    expect(await screen.findByText("ada@example.com")).toBeTruthy();
    expect(register).toHaveBeenCalledOnce();
  });

  it("shows the server 409 message", async () => {
    setup("/register", { "POST /auth/web/register": () => json(409, { message: "Username already taken" }) });
    const ui = userEvent.setup();
    await ui.type(await screen.findByLabelText(/^username/i), "ada");
    await ui.type(screen.getByLabelText(/^password/i), "0123456789");
    await ui.click(screen.getByRole("button", { name: /create account/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already taken/i);
  });
});

describe("continue page", () => {
  const url = `/login?client=desktop&code_challenge=${challenge}`;

  it("shows an error with retry and sign-in-as-someone-else when me() fails", async () => {
    let attempts = 0;
    setup(url, {
      "POST /auth/web/refresh": () => json(200, tokens),
      "GET /auth/me": () => (++attempts === 1 ? json(500, { message: "boom" }) : json(200, user)),
    });
    expect((await screen.findByRole("alert")).textContent).toMatch(/boom/i);
    expect(screen.getByRole("button", { name: /use a different account/i })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByRole("button", { name: /continue as ada/i })).toBeTruthy();
  });
});

describe("handoff capture", () => {
  it("does not write to sessionStorage while rendering", async () => {
    setup(`/login?client=desktop&code_challenge=${challenge}`, {}, { skipCapture: true });
    await screen.findByRole("heading", { name: /sign in/i });
    expect(sessionStorage.length).toBe(0);
  });
});

describe("desktop handoff", () => {
  const url = `/login?client=desktop&code_challenge=${challenge}`;
  const deepLink = "opencollab://auth/callback?code=one-shot";

  it("persists only the challenge and hands off after a password login", async () => {
    const desktopCode = vi.fn((init: RequestInit) => {
      expect(body(init)).toEqual({ code_challenge: challenge });
      return json(200, { redirectUrl: deepLink });
    });
    const { assign } = setup(url, {
      "POST /auth/web/login": () => json(200, { user, ...tokens }),
      "POST /auth/web/desktop-code": desktopCode,
    });
    const ui = userEvent.setup();
    await ui.type(await screen.findByLabelText(/username or email/i), "ada");
    await ui.type(screen.getByLabelText(/^password/i), "correct horse battery");
    expect(Object.values({ ...sessionStorage })).toEqual([challenge]);
    await ui.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(deepLink));
    expect(await screen.findByText(/you can return to opencollab/i)).toBeTruthy();
    expect(sessionStorage.length).toBe(0);
    expect(window.location.search).not.toContain("access");
  });

  it("offers 'Continue as' when already signed in and issues the code on click", async () => {
    const { assign } = setup(url, {
      "POST /auth/web/refresh": () => json(200, tokens),
      "POST /auth/web/desktop-code": () => json(200, { redirectUrl: deepLink }),
    });
    const button = await screen.findByRole("button", { name: /continue as ada/i });
    expect(assign).not.toHaveBeenCalled();
    await userEvent.setup().click(button);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(deepLink));
  });

  it("completes the handoff after the OAuth round trip on /auth/complete", async () => {
    sessionStorage.setItem("opencollab.handoff.challenge", challenge);
    const { assign } = setup("/auth/complete", {
      "POST /auth/web/refresh": () => json(200, tokens),
      "POST /auth/web/desktop-code": () => json(200, { redirectUrl: deepLink }),
    });
    await waitFor(() => expect(assign).toHaveBeenCalledWith(deepLink));
  });

  it("shows an error and keeps the challenge when the code request fails", async () => {
    sessionStorage.setItem("opencollab.handoff.challenge", challenge);
    const { assign } = setup("/auth/complete", {
      "POST /auth/web/refresh": () => json(200, tokens),
      "POST /auth/web/desktop-code": () => json(401, { message: "Invalid session" }),
    });
    expect((await screen.findByRole("alert")).textContent).toMatch(/invalid session/i);
    expect(assign).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(1);
  });
});

describe("/auth/complete", () => {
  it("goes to the account when no handoff is pending", async () => {
    setup("/auth/complete", { "POST /auth/web/refresh": () => json(200, tokens) });
    expect(await screen.findByText("ada@example.com")).toBeTruthy();
    expect(window.location.pathname).toBe("/account");
  });

  it("goes back to /login with an error when there is no session", async () => {
    setup("/auth/complete");
    expect((await screen.findByRole("alert")).textContent).toMatch(/sign-in failed/i);
    expect(window.location.pathname).toBe("/login");
  });
});

describe("account", () => {
  const authed = { "POST /auth/web/refresh": () => json(200, tokens) };

  it("shows the linked banner", async () => {
    setup("/account?linked=github", authed);
    expect((await screen.findByRole("status")).textContent).toMatch(/github.*linked/i);
  });

  it("shows an error banner for ?error=", async () => {
    setup("/account?error=conflict", authed);
    expect((await screen.findByRole("alert")).textContent).toMatch(/already linked/i);
  });

  it("starts linking with the bearer token and navigates to the provider", async () => {
    const { assign } = setup("/account", {
      ...authed,
      "POST /auth/oauth/github/link/start": (init) => {
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer access-1");
        return json(200, { url: "https://github.com/login/oauth/authorize?x=1" });
      },
    });
    await userEvent.setup().click(await screen.findByRole("button", { name: /link github/i }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://github.com/login/oauth/authorize?x=1"));
  });

  it("logs out and returns to /login", async () => {
    const { calls } = setup("/account", authed);
    await userEvent.setup().click(await screen.findByRole("button", { name: /sign out/i }));
    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeTruthy();
    expect(calls).toContain("POST /auth/web/logout");
  });

  it("stays on the account and says so when logout fails", async () => {
    setup("/account", { ...authed, "POST /auth/web/logout": () => json(503, { message: "down" }) });
    await userEvent.setup().click(await screen.findByRole("button", { name: /sign out/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not sign out/i);
    expect(window.location.pathname).toBe("/account");
  });
});
