// The client auth surface: `SessionProvider`/`useSession` (SSR seeding, the mount fetch,
// the `mfa-required` status), `session.update()`, the `refetchInterval` poll and the
// window-focus refetch, and `signIn({ redirect: false })`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type ClientSession, SessionProvider, signIn, useSession } from "denext";
import { h } from "denext/jsx-runtime";
import { render, waitFor } from "denext/testing";

/** One `{basePath}/session` answer. */
type SessionBody = { user?: { id: string } | null; expires?: number | null; mfa?: "required" };

/** Stub `fetch` with a queue of session answers; returns the calls it saw + a restore. */
function stubFetch(
  answer: (call: number) => SessionBody,
): { urls: string[]; restore: () => void } {
  const urls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    urls.push(String(input));
    return Promise.resolve(
      new Response(JSON.stringify(answer(urls.length)), {
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { urls, restore: () => void (globalThis.fetch = real) };
}

/** The latest session every render saw — the test's window into the context. */
let latest: ClientSession | undefined;

/** Renders the session status + user id, and records the session for the test. */
function Viewer(): ReturnType<typeof h> {
  const session = useSession();
  latest = session;
  return h("p", { "data-testid": "out" }, `${session.status}:${session.user?.id ?? "-"}`);
}

/** Render `Viewer` under a provider with `props`. */
function renderProvider(props: Record<string, unknown> = {}) {
  latest = undefined;
  return render(h(SessionProvider, props, h(Viewer, null)));
}

Deno.test("useSession: the mount fetch resolves to authenticated", async () => {
  const fetched = stubFetch(() => ({ user: { id: "u1" } }));
  try {
    const screen = await renderProvider();
    await screen.findByText("authenticated:u1");
    assertEquals(fetched.urls, ["/auth/session"], "the default base path is /auth");
    await screen.unmount();
  } finally {
    fetched.restore();
  }
});

Deno.test("useSession: a signed-out answer resolves to unauthenticated; basePath is honored", async () => {
  const fetched = stubFetch(() => ({ user: null }));
  try {
    const screen = await renderProvider({ basePath: "/account/auth" });
    await screen.findByText("unauthenticated:-");
    assertEquals(fetched.urls, ["/account/auth/session"]);
    await screen.unmount();
  } finally {
    fetched.restore();
  }
});

Deno.test("useSession: an MFA-pending answer surfaces status 'mfa-required' with no user", async () => {
  const fetched = stubFetch(() => ({ user: null, mfa: "required" }));
  try {
    const screen = await renderProvider();
    await screen.findByText("mfa-required:-");
    assertEquals(latest?.mfa, "required");
    assertEquals(latest?.user, null, "the user is never exposed before the second factor");
    await screen.unmount();
  } finally {
    fetched.restore();
  }
});

Deno.test("SessionProvider: an SSR-seeded session renders without a fetch", async () => {
  const fetched = stubFetch(() => ({ user: { id: "other" } }));
  try {
    const screen = await renderProvider({ session: { id: "seeded" } });
    screen.getByText("authenticated:seeded");
    assertEquals(fetched.urls, [], "seeding means no loading flash and no request");
    await screen.unmount();
  } finally {
    fetched.restore();
  }
});

Deno.test("session.update(): refetches, returns the new session, and updates every consumer", async () => {
  const fetched = stubFetch((n) => (n === 1 ? { user: null } : { user: { id: "u2" } }));
  try {
    const screen = await renderProvider();
    await screen.findByText("unauthenticated:-");

    const next = await latest!.update();
    assertEquals(next.status, "authenticated");
    assertEquals(next.user?.id, "u2");
    assertEquals(typeof next.update, "function", "the returned session can update again");
    await screen.findByText("authenticated:u2");
    assertEquals(fetched.urls.length, 2);
    await screen.unmount();
  } finally {
    fetched.restore();
  }
});

Deno.test("refetchInterval polls the session endpoint; unmount stops it", async () => {
  const fetched = stubFetch(() => ({ user: { id: "u1" } }));
  const screen = await renderProvider({ refetchInterval: 10 });
  try {
    await screen.findByText("authenticated:u1");
    await waitFor(() => {
      assert(fetched.urls.length >= 3, `polled only ${fetched.urls.length} times`);
    }, { timeout: 2000 });
  } finally {
    await screen.unmount();
    fetched.restore();
  }
  const afterUnmount = fetched.urls.length;
  await new Promise((r) => setTimeout(r, 40));
  assertEquals(fetched.urls.length, afterUnmount, "the interval is cleared on unmount");
});

Deno.test("refetchOnWindowFocus: a focus event refetches, and opting out does not", async () => {
  const fetched = stubFetch(() => ({ user: { id: "u1" } }));
  const screen = await renderProvider();
  try {
    await screen.findByText("authenticated:u1");
    dispatchEvent(new Event("focus"));
    await waitFor(() => assertEquals(fetched.urls.length, 2, "focus refetched"));
  } finally {
    await screen.unmount();
  }

  const off = await renderProvider({ refetchOnWindowFocus: false });
  try {
    await off.findByText("authenticated:u1");
    const before = fetched.urls.length;
    dispatchEvent(new Event("focus"));
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(fetched.urls.length, before, "opting out registers no listener");
  } finally {
    await off.unmount();
    fetched.restore();
  }
});

Deno.test("signIn({ redirect: false }) returns the URL instead of navigating", async () => {
  const url = await signIn("google", {
    redirect: false,
    callbackUrl: "/dashboard?tab=1",
  }) as string;
  assertStringIncludes(url, "/auth/signin/google?callbackUrl=");
  assertEquals(
    new URL(url, "https://app.test").searchParams.get("callbackUrl"),
    "/dashboard?tab=1",
  );

  const scoped = await signIn("gh:enterprise", {
    redirect: false,
    basePath: "/account/auth",
    callbackUrl: "/",
  }) as string;
  assertStringIncludes(scoped, "/account/auth/signin/gh%3Aenterprise?", "the id is encoded");
});

Deno.test("signIn({ credentials }) POSTs to the callback endpoint and resolves with its JSON", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, user: { id: "u1" } }), {
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  try {
    const result = await signIn("credentials", {
      credentials: { email: "a@x.test", password: "pw" },
      callbackUrl: "/next",
    });
    assertEquals(result, { ok: true, user: { id: "u1" } });
    assertEquals(calls[0].url, "/auth/callback/credentials");
    assertEquals(calls[0].body, { email: "a@x.test", password: "pw", callbackUrl: "/next" });
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("signIn/signOut: a foreign or javascript: callbackUrl is coerced to a same-origin path", async () => {
  // `callbackUrl` is routinely read out of the current URL's query, so it is
  // attacker-influenced — and `signOut` assigns it to `location.href`.
  const target = async (callbackUrl: string) =>
    new URL(
      await signIn("google", { redirect: false, callbackUrl }) as string,
      "https://app.test",
    ).searchParams.get("callbackUrl");

  assertEquals(await target("/dashboard?tab=1"), "/dashboard?tab=1", "a plain path is kept");
  assertEquals(await target("javascript:alert(1)"), "/", "a javascript: URL is an XSS, refused");
  assertEquals(await target("//evil.test/x"), "/", "protocol-relative is a foreign origin");
  assertEquals(await target("https://evil.test/x"), "/", "an absolute foreign URL is refused");
  assertEquals(await target("data:text/html,<script>"), "/", "any other scheme too");
  assertEquals(await target("dashboard"), "/", "an unrooted value is not guessed at");
});

/** Stub `fetch` with one `Response` (or rejection) per call; returns the calls + a restore. */
function stubResponses(
  answer: (call: number) => Response | Promise<Response>,
): { urls: string[]; restore: () => void } {
  const urls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    urls.push(String(input));
    return Promise.resolve(answer(urls.length));
  }) as typeof fetch;
  return { urls, restore: () => void (globalThis.fetch = real) };
}

const signedIn = (): Response => Response.json({ user: { id: "u1" } });

Deno.test("a 429 keeps the signed-in state, and focus refetches wait out Retry-After", async () => {
  const fetched = stubResponses((n) =>
    n === 1 ? signedIn() : new Response("{}", { status: 429, headers: { "retry-after": "60" } })
  );
  const screen = await renderProvider();
  try {
    await screen.findByText("authenticated:u1");
    const next = await latest!.update(); // an explicit update() still asks
    assertEquals(next.status, "authenticated", "a 429 says nothing about who is signed in");
    await screen.findByText("authenticated:u1");
    const before = fetched.urls.length;
    dispatchEvent(new Event("focus"));
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(fetched.urls.length, before, "focus held off for Retry-After");
  } finally {
    await screen.unmount();
    fetched.restore();
  }
});

Deno.test("a server or network error keeps what was known; a first load that learns nothing reads signed out", async () => {
  const fetched = stubResponses((n) => n === 1 ? signedIn() : new Response("", { status: 503 }));
  const screen = await renderProvider();
  try {
    await screen.findByText("authenticated:u1");
    assertEquals((await latest!.update()).status, "authenticated");
    dispatchEvent(new Event("focus")); // a 5xx holds nothing back: focus still refetches
    await waitFor(() => assertEquals(fetched.urls.length, 3));
    await screen.findByText("authenticated:u1");
  } finally {
    await screen.unmount();
    fetched.restore();
  }

  const down = stubResponses(() => Promise.reject(new TypeError("network down")));
  const first = await renderProvider();
  try {
    await first.findByText("unauthenticated:-");
  } finally {
    await first.unmount();
    down.restore();
  }
});
