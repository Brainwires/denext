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
import { onFreePort } from "./helpers/port.ts";

const TOKEN = "per-launch-token-abcdef";
const ENDPOINT = "http://127.0.0.1:8000/_denext/desktop/auth-session";

/** An authorization URL with `redirect` as its `redirect_uri`. */
const authUrl = (redirect: string) =>
  "https://auth.openai.example/oauth/authorize?client_id=x&state=s1&redirect_uri=" +
  encodeURIComponent(redirect) +
  "&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256";

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

/** The session's answer on a port another process took after the pick: a fresh port is tried. */
class PortTaken extends Error {}

/**
 * Run `session(port)` on a free port; when the session answers `port_in_use` (the port was taken
 * between the pick and the listen), again on another (onFreePort).
 */
function onFreeLoopback(session: (port: number) => Promise<Response>) {
  return onFreePort(async (port) => {
    resetDesktopAuthSessionForTesting();
    const res = await session(port);
    if (res.status === 409) {
      const body = await res.clone().json().catch(() => ({}));
      if (body.code === "port_in_use") throw new PortTaken(`port ${port} was taken`);
    }
    return { port, res };
  }, { retryIf: (err) => err instanceof PortTaken });
}

Deno.test("loopbackPort: listens on that port; the redirect keeps its host and gains the port", async () => {
  let sent: string | undefined;
  let browser: Promise<string> | undefined;
  const { port, res } = await onFreeLoopback((port) =>
    handleDesktopAuthSession(
      req({ authUrl: authUrl("http://localhost/auth/callback"), loopbackPort: port }),
      TOKEN,
      (url: string) => {
        sent = new URL(url).searchParams.get("redirect_uri")!;
        const hit = new URL(`http://127.0.0.1:${port}/auth/callback?code=c0de&state=s1`);
        browser = fetch(hit).then((r) => r.text());
      },
    )
  );
  assertEquals(res.status, 200);
  // The provider compares the redirect with the registered one: `localhost` stays `localhost`.
  assertEquals(sent, `http://localhost:${port}/auth/callback`);
  assertStringIncludes((await res.json()).url, "code=c0de");
  assertStringIncludes(await browser!, "You can close this tab.");
});

Deno.test("loopbackPort: a redirect that already names the same port is accepted", async () => {
  let sent: string | undefined;
  const { port, res } = await onFreeLoopback((port) =>
    handleDesktopAuthSession(
      req({
        authUrl: authUrl(`http://127.0.0.1:${port}/cb`),
        loopbackPort: port,
        timeoutMs: 50,
      }),
      TOKEN,
      (url) => {
        sent = new URL(url).searchParams.get("redirect_uri")!;
      },
    )
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
    const { session: _session, ...sent } = body as Record<string, unknown>;
    assertEquals(sent, { authUrl: url, loopbackPort: 1455 });
  } finally {
    globalThis.fetch = origFetch;
    g.__denext = origDenext;
  }
});

/** Whether this host has an IPv6 loopback (the `::1` tests need one). */
function hasIpv6Loopback(): boolean {
  try {
    Deno.listen({ hostname: "::1", port: 0 }).close();
    return true;
  } catch {
    return false;
  }
}

Deno.test({
  name:
    "loopbackPort: another listener on [::1]:<port> is port_in_use (it could take the redirect)",
  ignore: !hasIpv6Loopback(),
  fn: async () => {
    resetDesktopAuthSessionForTesting();
    // Another local process holds the IPv6 loopback on the port a `localhost` redirect names: a
    // browser that tries `::1` first would hand it the code.
    const taken = Deno.listen({ hostname: "::1", port: 0 });
    const port = (taken.addr as Deno.NetAddr).port;
    let opened = false;
    try {
      const res = await handleDesktopAuthSession(
        req({ authUrl: authUrl("http://localhost/cb"), loopbackPort: port, timeoutMs: 200 }),
        TOKEN,
        () => void (opened = true),
      );
      assertEquals(res.status, 409);
      assertEquals((await res.json()).code, "port_in_use");
      assertEquals(opened, false, "the browser must not open while ::1 is someone else's");
    } finally {
      taken.close();
    }
  },
});

Deno.test({
  name: "loopback listener: binds ::1 too, on the same port (fixed and ephemeral)",
  ignore: !hasIpv6Loopback(),
  fn: async () => {
    // Ephemeral: the redirect is rewritten to 127.0.0.1, and [::1] on that port is ours as well.
    resetDesktopAuthSessionForTesting();
    let viaV6: Promise<number> | undefined;
    const res = await handleDesktopAuthSession(
      req({ authUrl: authUrl("http://127.0.0.1/cb"), timeoutMs: 5_000 }),
      TOKEN,
      (url) => {
        const port = new URL(new URL(url).searchParams.get("redirect_uri")!).port;
        viaV6 = fetch(`http://[::1]:${port}/cb?code=v6&state=s1`).then(async (r) => {
          await r.body?.cancel();
          return r.status;
        });
      },
    );
    assertEquals(res.status, 200);
    assertStringIncludes((await res.json()).url, "code=v6");
    assertEquals(await viaV6!, 200);
    // Fixed: a `localhost` registration keeps its host, and both addresses answer.
    let fixed: Promise<number> | undefined;
    const { res: fixedRes } = await onFreeLoopback((port) =>
      handleDesktopAuthSession(
        req({ authUrl: authUrl("http://localhost/cb"), loopbackPort: port, timeoutMs: 5_000 }),
        TOKEN,
        () => {
          fixed = fetch(`http://[::1]:${port}/cb?code=v6f&state=s1`).then(async (r) => {
            await r.body?.cancel();
            return r.status;
          });
        },
      )
    );
    assertEquals(fixedRes.status, 200);
    assertStringIncludes((await fixedRes.json()).url, "code=v6f");
    assertEquals(await fixed!, 200);
  },
});
