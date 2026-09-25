// The browser-side `startDesktopAuthSession` (src/desktop/auth-session.ts): it reads the
// per-launch desktop token, POSTs to the loopback endpoint, and maps the response (or a failure)
// to an AuthSessionError. Driven with a stubbed `fetch` and `globalThis.__denext` — no runtime.

import { assertEquals, assertRejects } from "@std/assert";
import { startDesktopAuthSession } from "../src/desktop/auth-session.ts";

const AUTH_URL = "https://auth.example.com/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%2Fcb";

/** Run `fn` with `__denext` and `fetch` stubbed, restoring both afterwards. */
async function withDesktop(
  token: string | undefined,
  fetchImpl: typeof fetch,
  fn: () => Promise<void>,
): Promise<void> {
  const g = globalThis as { __denext?: { desktop?: boolean; token?: string } };
  const origFetch = globalThis.fetch;
  const origDenext = g.__denext;
  g.__denext = token === undefined ? undefined : { desktop: true, token };
  globalThis.fetch = fetchImpl;
  try {
    await fn();
  } finally {
    globalThis.fetch = origFetch;
    g.__denext = origDenext;
  }
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const neverFetch: typeof fetch = () => {
  throw new Error("fetch should not be called");
};

function codeOf(err: unknown): string | undefined {
  return (err as { code?: string }).code;
}

Deno.test("startDesktopAuthSession: no desktop token → unsupported, no request made", async () => {
  await withDesktop(undefined, neverFetch, async () => {
    const err = await assertRejects(() => startDesktopAuthSession(AUTH_URL, {}));
    assertEquals(codeOf(err), "unsupported");
  });
});

Deno.test("startDesktopAuthSession: 200 with a url resolves, sending the token + authUrl", async () => {
  let seen: { url: string; init?: RequestInit } | undefined;
  const fetchImpl: typeof fetch = (input, init) => {
    seen = { url: String(input), init };
    return Promise.resolve(jsonResponse(200, { url: "myapp-cb://done?code=abc&state=xyz" }));
  };
  await withDesktop("tok-123", fetchImpl, async () => {
    const res = await startDesktopAuthSession(AUTH_URL, { timeoutMs: 1000 });
    assertEquals(res.url, "myapp-cb://done?code=abc&state=xyz");
  });
  assertEquals(seen?.url, "/_denext/desktop/auth-session");
  assertEquals(seen?.init?.method, "POST");
  const headers = new Headers(seen?.init?.headers);
  assertEquals(headers.get("x-denext-desktop-token"), "tok-123");
  assertEquals(headers.get("content-type"), "application/json");
  assertEquals(JSON.parse(String(seen?.init?.body)), { authUrl: AUTH_URL, timeoutMs: 1000 });
});

Deno.test("startDesktopAuthSession: a non-200 maps the response code", async () => {
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(jsonResponse(408, { code: "timeout", message: "no redirect" }));
  await withDesktop("tok", fetchImpl, async () => {
    const err = await assertRejects(() => startDesktopAuthSession(AUTH_URL, {}));
    assertEquals(codeOf(err), "timeout");
  });
});

Deno.test("startDesktopAuthSession: a non-200 without a code → unsupported", async () => {
  const fetchImpl: typeof fetch = () => Promise.resolve(jsonResponse(500, {}));
  await withDesktop("tok", fetchImpl, async () => {
    const err = await assertRejects(() => startDesktopAuthSession(AUTH_URL, {}));
    assertEquals(codeOf(err), "unsupported");
  });
});

Deno.test("startDesktopAuthSession: a fetch failure → unsupported", async () => {
  const fetchImpl: typeof fetch = () => Promise.reject(new Error("refused"));
  await withDesktop("tok", fetchImpl, async () => {
    const err = await assertRejects(() => startDesktopAuthSession(AUTH_URL, {}));
    assertEquals(codeOf(err), "unsupported");
  });
});

Deno.test("startDesktopAuthSession: a 200 without a url → unsupported", async () => {
  const fetchImpl: typeof fetch = () => Promise.resolve(jsonResponse(200, { nope: true }));
  await withDesktop("tok", fetchImpl, async () => {
    const err = await assertRejects(() => startDesktopAuthSession(AUTH_URL, {}));
    assertEquals(codeOf(err), "unsupported");
  });
});

Deno.test("startDesktopAuthSession: a non-JSON response → unsupported", async () => {
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(
      new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
  await withDesktop("tok", fetchImpl, async () => {
    const err = await assertRejects(() => startDesktopAuthSession(AUTH_URL, {}));
    assertEquals(codeOf(err), "unsupported");
  });
});
