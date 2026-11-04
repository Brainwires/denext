// `next-auth/react` where NextAuth.js v4 differs from v5: `getSession({ req })`,
// `getCsrfToken({ req })` and `getProviders({ req })` on the server (in-process through the app's
// pipeline, else over HTTP with `req`'s cookie to NEXTAUTH_URL, never to the client-chosen Host),
// and `signIn()` with a provider the server
// doesn't list (to the sign-in page) or with no reachable server (to the error page).

import { assert, assertEquals } from "@std/assert";
import {
  getCsrfToken,
  getProviders,
  getSession,
  signIn,
} from "../packages/auth/next-auth/react.ts";
import { type ApiDispatchInit, setApiDispatcher } from "../src/runtime/api-dispatch.ts";

/** A recorded request. */
interface Call {
  url: string;
  headers: Headers;
}

const SESSION = { user: { name: "Ada" }, expires: "2099-01-01T00:00:00.000Z" };

/** Stub `fetch`; returns the calls and a restore. */
function stubFetch(answer: (url: string) => unknown): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    const body = answer(url);
    return Promise.resolve(
      body === undefined ? new Response(null, { status: 503 }) : Response.json(body),
    );
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}

/** Run `fn` with `location` stubbed; returns where the page navigated. */
async function withLocation(fn: () => Promise<unknown>): Promise<string[]> {
  const visits: string[] = [];
  const page = {
    get href() {
      return "http://localhost/account";
    },
    set href(to: string) {
      visits.push(to);
    },
    reload() {},
  };
  Object.defineProperty(globalThis, "location", { value: page, configurable: true });
  try {
    await fn();
  } finally {
    delete (globalThis as { location?: unknown }).location;
  }
  return visits;
}

Deno.test("next-auth/react v4: getSession({ req }) on the server runs in-process", async () => {
  const seen: { url: string; init: ApiDispatchInit }[] = [];
  setApiDispatcher((url, init) => {
    seen.push({ url, init });
    if (url.endsWith("/csrf")) return Promise.resolve(Response.json({ csrfToken: "tok-9" }));
    if (url.endsWith("/providers")) return Promise.resolve(Response.json({ github: {} }));
    return Promise.resolve(Response.json(SESSION));
  });
  const fetched = stubFetch(() => {
    throw new Error("no HTTP when the pipeline answers");
  });
  try {
    const req = new Request("http://app.test/account", { headers: { cookie: "a=1" } });
    assertEquals(await getSession({ req }), SESSION);
    assertEquals(await getSession({ ctx: { req } }), SESSION, "getServerSideProps' context");
    assertEquals(await getCsrfToken({ req }), "tok-9");
    assertEquals(Object.keys((await getProviders({ req }))!), ["github"]);
    assertEquals(seen.map((s) => [s.url, s.init.method]), [
      ["/api/auth/session", "GET"],
      ["/api/auth/session", "GET"],
      ["/api/auth/csrf", "GET"],
      ["/api/auth/providers", "GET"],
    ]);
    assertEquals(fetched.calls.length, 0);
  } finally {
    setApiDispatcher(null);
    fetched.restore();
  }
});

Deno.test("next-auth/react v4: getSession({ req }) outside a request fetches with req's cookie", async () => {
  const fetched = stubFetch((url) => (url.endsWith("/session") ? SESSION : { not: "a session" }));
  const prior = Deno.env.get("NEXTAUTH_URL");
  const priorPort = Deno.env.get("PORT");
  try {
    Deno.env.delete("NEXTAUTH_URL");
    Deno.env.set("PORT", "4123");
    // A Node-style request (an API route's). Its Host is the client's to choose, so it never
    // picks where the server sends the cookie: without NEXTAUTH_URL, the local server is asked.
    const node = { headers: { cookie: "s=1", host: "evil.test", "x-forwarded-proto": "https" } };
    assertEquals(await getSession({ req: node }), SESSION);
    assertEquals(fetched.calls[0].url, "http://localhost:4123/api/auth/session");
    assertEquals(fetched.calls[0].headers.get("cookie"), "s=1");
    // NEXTAUTH_URL (with its path) wins over the Host.
    Deno.env.set("NEXTAUTH_URL", "https://auth.example.test/custom/auth");
    await getSession({ req: node });
    assertEquals(fetched.calls[1].url, "https://auth.example.test/custom/auth/session");
    Deno.env.set("NEXTAUTH_URL", "https://auth.example.test");
    await getSession({ req: new Request("http://x.test/", { headers: { cookie: "s=2" } }) });
    assertEquals(fetched.calls[2].url, "https://auth.example.test/api/auth/session");
    assertEquals(fetched.calls[2].headers.get("cookie"), "s=2");
    fetched.restore();
    // Anything but a session reads as signed out.
    const broken = stubFetch(() => ({ user: {} }));
    try {
      assertEquals(await getSession({ req: node }), null);
    } finally {
      broken.restore();
    }
  } finally {
    if (prior === undefined) Deno.env.delete("NEXTAUTH_URL");
    else Deno.env.set("NEXTAUTH_URL", prior);
    if (priorPort === undefined) Deno.env.delete("PORT");
    else Deno.env.set("PORT", priorPort);
    fetched.restore();
  }
});

Deno.test("next-auth/react v4: a route the pipeline can't reach falls back to HTTP", async () => {
  setApiDispatcher(() => Promise.resolve(Response.json({ error: "not_found" }, { status: 404 })));
  const fetched = stubFetch(() => SESSION);
  try {
    const req = { headers: { cookie: "s=3" } };
    assertEquals(await getSession({ req }), SESSION);
    assertEquals(fetched.calls.length, 1);
    assertEquals(fetched.calls[0].headers.get("cookie"), "s=3");
  } finally {
    setApiDispatcher(null);
    fetched.restore();
  }
});

Deno.test("next-auth/react v4: signIn with an unknown provider opens the sign-in page", async () => {
  const fetched = stubFetch((url) =>
    url.endsWith("/providers") ? { github: { id: "github", type: "oauth" } } : {}
  );
  try {
    const visits = await withLocation(() => signIn("gitlab", { callbackUrl: "/after" }));
    assertEquals(visits, ["/api/auth/signin?callbackUrl=http%3A%2F%2Flocalhost%2Fafter"]);
    assert(!fetched.calls.some((c) => c.url.includes("/signin/")), "nothing was POSTed");
    const proto = await withLocation(() => signIn("constructor"));
    assert(proto[0].startsWith("/api/auth/signin?"), "a prototype key is no provider");
  } finally {
    fetched.restore();
  }
  const down = stubFetch(() => undefined);
  try {
    assertEquals(await withLocation(() => signIn("github")), ["/api/auth/error"]);
  } finally {
    down.restore();
  }
});
