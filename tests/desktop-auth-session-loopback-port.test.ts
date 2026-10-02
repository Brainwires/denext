// `openAuthSession`'s Deno Desktop loopback flow on a FIXED port (`loopbackPort`): for providers
// that only accept their registered loopback redirect (OpenAI's `http://localhost:1455/...`).
// The listener binds that port, the `redirect_uri` keeps its host and gains the port, a port in use
// fails `port_in_use` (and frees the single-session slot), and a bad port is `invalid`. The client
// half forwards the option and maps the code.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  handleDesktopAuthSession,
  resetDesktopAuthSessionForTesting,
} from "../src/desktop/auth-session-runtime.ts";
import { startDesktopAuthSession } from "../src/desktop/auth-session.ts";

const TOKEN = "per-launch-token-abcdef";
const ENDPOINT = "http://127.0.0.1:8000/_denext/desktop/auth-session";

/** An authorization URL with `redirect` as its `redirect_uri`. */
const authUrl = (redirect: string) =>
  "https://auth.openai.example/oauth/authorize?client_id=x&state=s1&redirect_uri=" +
  encodeURIComponent(redirect);

/** A token-gated, same-origin start request. */
function req(body: unknown): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "x-denext-desktop-token": TOKEN,
      origin: "http://127.0.0.1:8000",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/** A port nothing listens on right now. */
function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

Deno.test("loopbackPort: listens on that port; the redirect keeps its host and gains the port", async () => {
  resetDesktopAuthSessionForTesting();
  const port = freePort();
  let sent: string | undefined;
  let browser: Promise<string> | undefined;
  const openBrowser = (url: string) => {
    sent = new URL(url).searchParams.get("redirect_uri")!;
    const hit = new URL(`http://127.0.0.1:${port}/auth/callback?code=c0de&state=s1`);
    browser = fetch(hit).then((r) => r.text());
  };
  const res = await handleDesktopAuthSession(
    req({ authUrl: authUrl("http://localhost/auth/callback"), loopbackPort: port }),
    TOKEN,
    openBrowser,
  );
  assertEquals(res.status, 200);
  // The provider compares the redirect with the registered one: `localhost` stays `localhost`.
  assertEquals(sent, `http://localhost:${port}/auth/callback`);
  assertStringIncludes((await res.json()).url, "code=c0de");
  assertStringIncludes(await browser!, "You can close this tab.");
});

Deno.test("loopbackPort: a redirect that already names the same port is accepted", async () => {
  resetDesktopAuthSessionForTesting();
  const port = freePort();
  let sent: string | undefined;
  const res = await handleDesktopAuthSession(
    req({
      authUrl: authUrl(`http://127.0.0.1:${port}/cb`),
      loopbackPort: port,
      timeoutMs: 50,
    }),
    TOKEN,
    (url) => {
      sent = new URL(url).searchParams.get("redirect_uri")!;
    },
  );
  assertEquals(res.status, 408); // nobody came back: the timeout
  assertEquals(sent, `http://127.0.0.1:${port}/cb`);
});

Deno.test("loopbackPort: a port in use is port_in_use, and the session slot is freed", async () => {
  resetDesktopAuthSessionForTesting();
  const taken = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (taken.addr as Deno.NetAddr).port;
  let opened = false;
  try {
    const res = await handleDesktopAuthSession(
      req({ authUrl: authUrl("http://localhost/cb"), loopbackPort: port }),
      TOKEN,
      () => {
        opened = true;
      },
    );
    assertEquals(res.status, 409);
    assertEquals((await res.json()).code, "port_in_use");
    assertEquals(opened, false, "the browser must not open without a listener");
  } finally {
    taken.close();
  }
  // Not stuck `busy`: the next session starts (and times out, since nobody calls back).
  const next = await handleDesktopAuthSession(
    req({ authUrl: authUrl("http://localhost/cb"), timeoutMs: 20 }),
    TOKEN,
    () => {},
  );
  assertEquals(next.status, 408);
});

Deno.test("loopbackPort: not a port, or one the redirect contradicts → invalid", async () => {
  resetDesktopAuthSessionForTesting();
  for (const loopbackPort of [0, 65536, 1.5, -1, "1455", null]) {
    const res = await handleDesktopAuthSession(
      req({ authUrl: authUrl("http://localhost/cb"), loopbackPort }),
      TOKEN,
      () => {},
    );
    assertEquals(res.status, 400, String(loopbackPort));
    assertEquals((await res.json()).code, "invalid");
  }
  const res = await handleDesktopAuthSession(
    req({ authUrl: authUrl("http://localhost:1455/cb"), loopbackPort: 1456 }),
    TOKEN,
    () => {},
  );
  assertEquals(res.status, 400);
  assertStringIncludes((await res.json()).message, "1455");
});

Deno.test("startDesktopAuthSession: sends loopbackPort; port_in_use comes back typed", async () => {
  const g = globalThis as { __denext?: unknown };
  const origFetch = globalThis.fetch;
  const origDenext = g.__denext;
  let body: unknown;
  g.__denext = { desktop: true, token: "tok" };
  globalThis.fetch = (_input, init) => {
    body = JSON.parse(String(init?.body));
    return Promise.resolve(
      Response.json({ code: "port_in_use", message: "loopback port 1455 is in use" }, {
        status: 409,
      }),
    );
  };
  try {
    const url = authUrl("http://localhost:1455/auth/callback");
    const err = await assertRejects(() =>
      startDesktopAuthSession(url, { loopbackPort: 1455, cancelOverlay: false })
    );
    assertEquals((err as { code?: string }).code, "port_in_use");
    assertEquals(body, { authUrl: url, loopbackPort: 1455 });
  } finally {
    globalThis.fetch = origFetch;
    g.__denext = origDenext;
  }
});
