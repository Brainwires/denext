// `next-auth/react` on denext: `SessionProvider` / `useSession` (`{ data, status, update }`,
// `required`), and `signIn` / `signOut` / `update` sending the CSRF token and keeping every
// `callbackUrl` on the page's origin.

import { assert, assertEquals } from "@std/assert";
import { h } from "denext/jsx-runtime";
import { render, waitFor } from "denext/testing";
import {
  type SessionContextValue,
  SessionProvider,
  signIn,
  signOut,
  useSession,
} from "../src/compat/next-auth/react.ts";

/** A recorded request. */
interface Call {
  url: string;
  method: string;
  body: string;
  headers: Headers;
}

/** Stub `fetch` with a router; returns the calls and a restore. */
function stubFetch(route: (call: Call) => unknown): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? String(init.body) : "",
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    return Promise.resolve(Response.json(route(call)));
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}

/** The handlers' answers for a signed-in user. */
function server(call: Call): unknown {
  if (call.url.endsWith("/csrf")) return { csrfToken: "tok-1" };
  if (call.url.endsWith("/providers")) {
    return {
      credentials: { id: "credentials", type: "credentials" },
      github: { id: "github", type: "oauth" },
    };
  }
  if (call.url.endsWith("/session") && call.method === "POST") {
    return { user: { name: "Updated" }, expires: "2099-01-01T00:00:00.000Z" };
  }
  if (call.url.endsWith("/session")) {
    return { user: { name: "Ada" }, expires: "2099-01-01T00:00:00.000Z" };
  }
  if (call.url.includes("/callback/credentials")) {
    const password = new URLSearchParams(call.body).get("password");
    return password === "pw"
      ? { url: "http://localhost/home" }
      : { url: "http://localhost/api/auth/signin?error=CredentialsSignin&code=credentials" };
  }
  if (call.url.endsWith("/signout")) return { url: "http://localhost/" };
  return {};
}

let latest: SessionContextValue | undefined;

function Viewer(props: { required?: boolean; onUnauthenticated?: () => void }) {
  const session = useSession(props);
  latest = session;
  return h("p", null, `${session.status}:${session.data?.user?.name ?? "-"}`);
}

Deno.test("next-auth/react: SessionProvider fetches /api/auth/session; useSession reads it", async () => {
  const fetched = stubFetch(server);
  try {
    const screen = await render(h(SessionProvider, {}, h(Viewer, {})));
    await screen.findByText("authenticated:Ada");
    assertEquals(fetched.calls.map((c) => c.url), ["/api/auth/session"]);
    await screen.unmount();
  } finally {
    fetched.restore();
  }
});

Deno.test("next-auth/react: a seeded session renders without a fetch", async () => {
  const fetched = stubFetch(server);
  try {
    const session = { user: { name: "Seeded" }, expires: "2099-01-01T00:00:00.000Z" };
    const screen = await render(h(SessionProvider, { session }, h(Viewer, {})));
    await screen.findByText("authenticated:Seeded");
    assertEquals(fetched.calls.length, 0);
    await screen.unmount();
  } finally {
    fetched.restore();
  }
});

Deno.test("next-auth/react: required + onUnauthenticated", async () => {
  const fetched = stubFetch((call) => call.url.endsWith("/session") ? null : {});
  let called = 0;
  try {
    const screen = await render(
      h(SessionProvider, {}, h(Viewer, { required: true, onUnauthenticated: () => void called++ })),
    );
    await waitFor(() => assertEquals(called, 1));
    await screen.findByText("loading:-");
    await screen.unmount();
  } finally {
    fetched.restore();
  }
});

Deno.test("next-auth/react: update(data) POSTs it with the CSRF token", async () => {
  const fetched = stubFetch(server);
  try {
    const screen = await render(h(SessionProvider, {}, h(Viewer, {})));
    await screen.findByText("authenticated:Ada");
    await latest!.update({ nickname: "countess" });
    await screen.findByText("authenticated:Updated");
    const post = fetched.calls.find((c) => c.method === "POST")!;
    assertEquals(JSON.parse(post.body), {
      csrfToken: "tok-1",
      data: JSON.stringify({ nickname: "countess" }),
    });
    await screen.unmount();
  } finally {
    fetched.restore();
  }
});

Deno.test("next-auth/react: signIn(credentials, { redirect: false }) posts the form with the token", async () => {
  const fetched = stubFetch(server);
  try {
    const ok = await signIn("credentials", {
      email: "ada@example.com",
      password: "pw",
      redirect: false,
      callbackUrl: "/home",
    });
    assertEquals(ok, {
      error: undefined,
      code: undefined,
      status: 200,
      ok: true,
      url: "http://localhost/home",
    });
    const post = fetched.calls.find((c) => c.method === "POST")!;
    assertEquals(post.url, "/api/auth/callback/credentials");
    assertEquals(post.headers.get("x-auth-return-redirect"), "1");
    const form = new URLSearchParams(post.body);
    assertEquals(form.get("csrfToken"), "tok-1");
    assertEquals(form.get("email"), "ada@example.com");
    assertEquals(form.get("callbackUrl"), "http://localhost/home");
    assert(!form.has("redirect"), "options are not credentials");
    const refused = await signIn("credentials", { password: "nope", redirect: false });
    assertEquals(refused?.error, "CredentialsSignin");
    assertEquals(refused?.code, "credentials");
    assertEquals(refused?.ok, false);
  } finally {
    fetched.restore();
  }
});

Deno.test("next-auth/react: a foreign callbackUrl is replaced by the current page", async () => {
  const fetched = stubFetch(server);
  try {
    for (const callbackUrl of ["https://evil.test/x", "//evil.test/x", "javascript:alert(1)"]) {
      await signIn("credentials", { password: "pw", redirect: false, callbackUrl });
      const form = new URLSearchParams(fetched.calls.at(-1)!.body);
      assertEquals(new URL(form.get("callbackUrl")!).host, "localhost", callbackUrl);
    }
    const out = await signOut({ redirect: false, callbackUrl: "https://evil.test" });
    assertEquals(out, { url: "http://localhost/" });
    const post = fetched.calls.at(-1)!;
    assertEquals(post.url, "/api/auth/signout");
    assertEquals(new URLSearchParams(post.body).get("csrfToken"), "tok-1");
  } finally {
    fetched.restore();
  }
});
