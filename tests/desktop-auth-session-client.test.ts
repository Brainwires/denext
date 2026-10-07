// The browser-side `startDesktopAuthSession` (src/desktop/auth-session.ts): it reads the
// per-launch desktop token, POSTs to the loopback endpoint, and maps the response (or a failure)
// to an AuthSessionError. Driven with a stubbed `fetch` and `globalThis.__denext` — no runtime.

import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import {
  startDesktopAuthSession,
  startDesktopSchemeAuthSession,
} from "../src/desktop/auth-session.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import { createFakeDesktopRuntime, type FakeMethod } from "./helpers/desktop-fake-runtime.ts";
import { installFakeDocument } from "./helpers/fake-overlay-dom.ts";

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
  const { session, ...sent } = JSON.parse(String(seen?.init?.body));
  assertEquals(sent, { authUrl: AUTH_URL, timeoutMs: 1000 });
  assertMatch(session, /^[0-9a-f-]{36}$/, "a per-call session key binds the session to this page");
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

/** A stubbed loopback endpoint whose start answers only once a cancel (or `finish`) arrives. */
function cancellableEndpoint() {
  const bodies: unknown[] = [];
  let finish: (r: Response) => void = () => {};
  const fetchImpl: typeof fetch = (_input, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (body.cancel === true) {
      finish(jsonResponse(499, { code: "cancelled", message: "the sign-in was cancelled" }));
      return Promise.resolve(jsonResponse(200, { cancelled: true }));
    }
    return new Promise((r) => (finish = r));
  };
  return { bodies, fetchImpl, finish: (r: Response) => finish(r) };
}

const tick = () => new Promise((r) => setTimeout(r, 1));

Deno.test("startDesktopAuthSession: the cancel overlay's button cancels the browser sign-in", async () => {
  const { doc, restore } = installFakeDocument();
  const ep = cancellableEndpoint();
  try {
    await withDesktop("tok-1", ep.fetchImpl, async () => {
      const run = startDesktopAuthSession(AUTH_URL, {});
      await tick();
      const button = doc.button();
      assert(button, "the overlay is shown while the browser has the sign-in");
      button.dispatch("click");
      const err = await assertRejects(() => run);
      assertEquals(codeOf(err), "cancelled");
      // The cancel names the session the start opened (bound to this page).
      const start = ep.bodies[0] as { session?: string };
      assert(typeof start.session === "string" && start.session.length >= 16);
      assertEquals(ep.bodies[1], { cancel: true, session: start.session });
      assertEquals(doc.button(), undefined, "the overlay is gone");
    });
  } finally {
    restore();
  }
});

Deno.test("startDesktopAuthSession: signal cancels; cancelOverlay: false shows nothing", async () => {
  const { doc, restore } = installFakeDocument();
  const ep = cancellableEndpoint();
  try {
    await withDesktop("tok-1", ep.fetchImpl, async () => {
      const abort = new AbortController();
      const run = startDesktopAuthSession(AUTH_URL, {
        signal: abort.signal,
        cancelOverlay: false,
      });
      await tick();
      assertEquals(doc.button(), undefined);
      abort.abort();
      assertEquals(codeOf(await assertRejects(() => run)), "cancelled");
      // Already aborted: rejects before any request.
      const before = ep.bodies.length;
      const err = await assertRejects(() =>
        startDesktopAuthSession(AUTH_URL, { signal: abort.signal })
      );
      assertEquals(codeOf(err), "cancelled");
      assertEquals(ep.bodies.length, before);
    });
  } finally {
    restore();
  }
});

Deno.test("startDesktopAuthSession: the overlay leaves when the sign-in finishes", async () => {
  const { doc, restore } = installFakeDocument();
  const ep = cancellableEndpoint();
  try {
    await withDesktop("tok-1", ep.fetchImpl, async () => {
      const run = startDesktopAuthSession(AUTH_URL, {
        cancelOverlay: { message: "Weiter im Browser.", cancelLabel: "Abbrechen" },
      });
      await tick();
      assertEquals(doc.button()?.textContent, "Abbrechen");
      ep.finish(jsonResponse(200, { url: "http://127.0.0.1/cb?code=1" }));
      assertEquals(await run, { url: "http://127.0.0.1/cb?code=1" });
      assertEquals(doc.button(), undefined);
    });
  } finally {
    restore();
  }
});

/** Run `fn` with a fake runtime whose `authSession` is `methods`, and a fake DOM. */
async function withScheme(
  methods: Record<string, FakeMethod>,
  fn: (doc: ReturnType<typeof installFakeDocument>["doc"]) => Promise<void>,
): Promise<void> {
  const rt = createFakeDesktopRuntime({ authSession: methods });
  const restoreRt = rt.install();
  const { doc, restore } = installFakeDocument();
  try {
    await fn(doc);
  } finally {
    restore();
    resetDesktopBridgeForTesting();
    restoreRt();
  }
}

const SCHEME_URL = "https://auth.example.com/authorize?redirect_uri=myapp%3A%2F%2Fauth%2Fcb";

Deno.test("startDesktopSchemeAuthSession: the OS sheet (macOS) gets no overlay, ephemeral reaches it", async () => {
  const starts: unknown[] = [];
  await withScheme({
    capabilities: () => ({ osSession: true, ephemeral: true }),
    start: (a) => (starts.push(a), { url: "myapp://auth/cb?code=1" }),
  }, async (doc) => {
    const shown: Array<boolean> = [];
    const out = startDesktopSchemeAuthSession(SCHEME_URL, {
      callbackScheme: "myapp",
      preferEphemeral: true,
    });
    await tick();
    shown.push(doc.button() !== undefined);
    assertEquals(await out, { url: "myapp://auth/cb?code=1" });
    assertEquals(shown, [false]);
    assertEquals((starts[0] as { ephemeral?: boolean }).ephemeral, true);
  });
});

Deno.test("startDesktopSchemeAuthSession: the system browser (Windows, Linux) gets the overlay", async () => {
  let cancelled = 0;
  let release: (v: unknown) => void = () => {};
  await withScheme({
    capabilities: () => ({ osSession: false, ephemeral: false }),
    start: (a) => {
      assertEquals((a as { ephemeral?: boolean }).ephemeral, undefined);
      return new Promise((r) => (release = r));
    },
    cancel: () => {
      cancelled++;
      release(null); // the fake's start ends without a URL once cancelled
      return { cancelled: true };
    },
  }, async (doc) => {
    const out = startDesktopSchemeAuthSession(SCHEME_URL, { callbackScheme: "myapp" });
    for (let i = 0; i < 50 && !doc.button(); i++) await tick();
    doc.button()!.dispatch("click");
    await assertRejects(() => out);
    assertEquals(cancelled, 1);
    assertEquals(doc.button(), undefined);
  });
});

Deno.test("startDesktopSchemeAuthSession: a runtime that cannot say gets the overlay; false hides it", async () => {
  await withScheme({
    start: () => new Promise((r) => setTimeout(() => r({ url: "myapp://auth/cb?code=2" }), 30)),
  }, async (doc) => {
    let seen = false;
    const out = startDesktopSchemeAuthSession(SCHEME_URL, { callbackScheme: "myapp" });
    for (let i = 0; i < 50 && !seen; i++) {
      seen = doc.button() !== undefined;
      await tick();
    }
    await out;
    assert(seen, "no capabilities method: the overlay is the safe default");
    const quiet = startDesktopSchemeAuthSession(SCHEME_URL, {
      callbackScheme: "myapp",
      cancelOverlay: false,
    });
    await tick();
    assertEquals(doc.button(), undefined);
    await quiet;
  });
});

Deno.test("startDesktopSchemeAuthSession: a signal aborted during the capability probe cancels", async () => {
  let starts = 0;
  const abort = new AbortController();
  await withScheme({
    capabilities: () => (abort.abort(), { osSession: true }),
    start: () => (starts++, { url: "myapp://auth/cb" }),
    cancel: () => ({ cancelled: false }),
  }, async () => {
    const err = await assertRejects(() =>
      startDesktopSchemeAuthSession(SCHEME_URL, { callbackScheme: "myapp", signal: abort.signal })
    );
    assertEquals(codeOf(err), "cancelled");
    assertEquals(starts, 0);
  });
});

Deno.test("openAuthSession (desktop, loopback): signal and cancelOverlay reach the browser flow", async () => {
  const { openAuthSession } = await import("../src/mobile/auth-session.ts");
  const { doc, restore } = installFakeDocument();
  const ep = cancellableEndpoint();
  try {
    await withDesktop("tok-1", ep.fetchImpl, async () => {
      const abort = new AbortController();
      const run = openAuthSession(AUTH_URL, {
        callbackScheme: "myapp",
        signal: abort.signal,
        cancelOverlay: false,
      });
      for (let i = 0; i < 50 && ep.bodies.length === 0; i++) await tick();
      assertEquals(doc.button(), undefined);
      abort.abort();
      assertEquals(codeOf(await assertRejects(() => run)), "cancelled");
    });
  } finally {
    restore();
  }
});
