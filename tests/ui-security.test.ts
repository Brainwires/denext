// The six-layer local security model of `denext ui` (src/ui/security.ts + the server's chain):
// host/origin gate, the `?t=` → cookie handshake, CSRF on mutations, the method table, the exact
// response header set, path containment, and `--read-only`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  applySecurityHeaders,
  constantTimeEqual,
  deriveCsrf,
  newToken,
  UI_COOKIE,
  UI_CSRF_HEADER,
  uiOriginAllowed,
  uiSafeJoin,
} from "../src/ui/security.ts";
import { startUiServer, type UiServer } from "../src/ui/server.ts";

async function ui(options: { readOnly?: boolean } = {}): Promise<
  { server: UiServer; base: string; csrf: string; dir: string }
> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_sec_" });
  await Deno.writeTextFile(join(dir, "deno.json"), '{ "tasks": { "hello": "echo hi" } }');
  const server = await startUiServer({ dir, port: 0, ...options });
  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
    csrf: await deriveCsrf(server.token),
    dir,
  };
}

async function stop(s: { server: UiServer; dir: string }): Promise<void> {
  await s.server.shutdown();
  await Deno.remove(s.dir, { recursive: true });
}

Deno.test("a request with no session cookie is 401", async () => {
  const s = await ui();
  try {
    const res = await fetch(`${s.base}/`);
    assertEquals(res.status, 401);
    assertEquals((await res.json()).reason, "unauthorized");
  } finally {
    await stop(s);
  }
});

Deno.test("a wrong ?t= token is 401 and sets no cookie", async () => {
  const s = await ui();
  try {
    const res = await fetch(`${s.base}/?t=not-the-token`, { redirect: "manual" });
    assertEquals(res.status, 401);
    assertEquals(res.headers.get("set-cookie"), null);
    await res.body?.cancel();
  } finally {
    await stop(s);
  }
});

Deno.test("a wrong cookie is 401", async () => {
  const s = await ui();
  try {
    const res = await fetch(`${s.base}/`, { headers: { cookie: `${UI_COOKIE}=nope` } });
    assertEquals(res.status, 401);
    await res.body?.cancel();
  } finally {
    await stop(s);
  }
});

Deno.test("?t= sets the cookie and 302s to the same path WITHOUT the query", async () => {
  const s = await ui();
  try {
    const res = await fetch(`${s.base}/config?t=${s.server.token}`, { redirect: "manual" });
    await res.body?.cancel();
    assertEquals(res.status, 302);
    assertEquals(res.headers.get("location"), "/config");
    const cookie = res.headers.get("set-cookie") ?? "";
    assertStringIncludes(cookie, `${UI_COOKIE}=${s.server.token}`);
    assertStringIncludes(cookie, "HttpOnly");
    assertStringIncludes(cookie, "SameSite=Strict");
    assertStringIncludes(cookie, "Path=/");
  } finally {
    await stop(s);
  }
});

Deno.test("a cross-site Sec-Fetch-Site is 403 even with a valid cookie", async () => {
  const s = await ui();
  try {
    const res = await fetch(`${s.base}/`, {
      headers: { cookie: `${UI_COOKIE}=${s.server.token}`, "sec-fetch-site": "cross-site" },
    });
    assertEquals(res.status, 403);
    assertEquals((await res.json()).reason, "forbidden origin");
  } finally {
    await stop(s);
  }
});

/**
 * `fetch` refuses to set `Host` (a forbidden header), so the DNS-rebinding case is exercised
 * over a raw socket — which is also exactly how an attacker's page would reach a loopback
 * server through a hostname they control.
 */
async function rawRequest(port: number, lines: string[]): Promise<string> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    await conn.write(new TextEncoder().encode(lines.join("\r\n") + "\r\n\r\n"));
    const buffer = new Uint8Array(4096);
    const read = await conn.read(buffer);
    return new TextDecoder().decode(buffer.subarray(0, read ?? 0));
  } finally {
    conn.close();
  }
}

Deno.test("a rebound Host (evil.test) is 403 even with a valid cookie", async () => {
  const s = await ui();
  try {
    const rebound = await rawRequest(s.server.port, [
      "GET / HTTP/1.1",
      "Host: evil.test",
      `Cookie: ${UI_COOKIE}=${s.server.token}`,
      "Connection: close",
    ]);
    assertStringIncludes(rebound, "403");
    assertStringIncludes(rebound, "forbidden origin");
    const loopback = await rawRequest(s.server.port, [
      "GET / HTTP/1.1",
      `Host: 127.0.0.1:${s.server.port}`,
      `Cookie: ${UI_COOKIE}=${s.server.token}`,
      "Connection: close",
    ]);
    assertStringIncludes(loopback, "200");
  } finally {
    await stop(s);
  }
});

Deno.test("a POST without a CSRF token is 403", async () => {
  const s = await ui();
  try {
    const res = await fetch(`${s.base}/api/config`, {
      method: "POST",
      headers: { cookie: `${UI_COOKIE}=${s.server.token}`, origin: s.base },
      body: new FormData(),
    });
    assertEquals(res.status, 403);
    assertEquals((await res.json()).reason, "bad csrf token");
  } finally {
    await stop(s);
  }
});

Deno.test("a POST with no Origin at all is refused (a mutation defaults to deny)", async () => {
  const s = await ui();
  try {
    const res = await fetch(`${s.base}/api/config`, {
      method: "POST",
      headers: { cookie: `${UI_COOKIE}=${s.server.token}`, [UI_CSRF_HEADER]: s.csrf },
      body: new FormData(),
    });
    assertEquals(res.status, 403);
    assertEquals((await res.json()).reason, "bad origin");
  } finally {
    await stop(s);
  }
});

Deno.test("a POST with the derived CSRF token and a same-origin Origin passes the gates", async () => {
  const s = await ui();
  try {
    const res = await fetch(`${s.base}/api/config`, {
      method: "POST",
      headers: {
        cookie: `${UI_COOKIE}=${s.server.token}`,
        origin: s.base,
        [UI_CSRF_HEADER]: s.csrf,
      },
      body: new FormData(),
    });
    // Past every gate: the feature stub itself answers 501, not a 403.
    assertEquals(res.status, 501);
    assertEquals((await res.json()).reason, "not implemented");
  } finally {
    await stop(s);
  }
});

Deno.test("GET on a POST-only mutation route is 405", async () => {
  const s = await ui();
  try {
    const res = await fetch(`${s.base}/tasks/run`, {
      headers: { cookie: `${UI_COOKIE}=${s.server.token}` },
    });
    assertEquals(res.status, 405);
    assertEquals((await res.json()).reason, "method not allowed");
  } finally {
    await stop(s);
  }
});

Deno.test("--read-only refuses every mutation before the feature runs", async () => {
  const s = await ui({ readOnly: true });
  try {
    for (const path of ["/api/config", "/api/plugins", "/api/generate", "/tasks/run"]) {
      const res = await fetch(`${s.base}${path}`, {
        method: "POST",
        headers: {
          cookie: `${UI_COOKIE}=${s.server.token}`,
          origin: s.base,
          [UI_CSRF_HEADER]: s.csrf,
        },
        body: new FormData(),
      });
      assertEquals(res.status, 403, path);
      assertEquals((await res.json()).reason, "read-only", path);
    }
  } finally {
    await stop(s);
  }
});

Deno.test("every response carries the exact CSP / COOP / CORP / no-store header set", async () => {
  const s = await ui();
  try {
    const res = await fetch(`${s.base}/`, {
      headers: { cookie: `${UI_COOKIE}=${s.server.token}` },
    });
    await res.body?.cancel();
    assertEquals(
      res.headers.get("content-security-policy"),
      "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; " +
        "img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
        "form-action 'self'; frame-ancestors 'none'",
    );
    assertEquals(res.headers.get("referrer-policy"), "no-referrer");
    assertEquals(res.headers.get("cross-origin-opener-policy"), "same-origin");
    assertEquals(res.headers.get("cross-origin-resource-policy"), "same-origin");
    assertEquals(res.headers.get("cache-control"), "no-store");
    assertEquals(res.headers.get("x-content-type-options"), "nosniff");
  } finally {
    await stop(s);
  }
});

Deno.test("refusals are hardened too", async () => {
  const s = await ui();
  try {
    const res = await fetch(`${s.base}/nope`, {
      headers: { cookie: `${UI_COOKIE}=${s.server.token}` },
    });
    assertEquals(res.status, 404);
    await res.body?.cancel();
    assertEquals(res.headers.get("cache-control"), "no-store");
    assert(res.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"));
  } finally {
    await stop(s);
  }
});

// ── unit-level ───────────────────────────────────────────────────────────────

Deno.test("uiOriginAllowed: loopback hosts, Sec-Fetch-Site, Origin fallback", () => {
  const req = (headers: Record<string, string>) =>
    new Request("http://127.0.0.1:5177/", { headers });
  const url = new URL("http://127.0.0.1:5177/");
  assert(uiOriginAllowed(req({}), url));
  assert(uiOriginAllowed(req({ "sec-fetch-site": "same-origin" }), url));
  assert(!uiOriginAllowed(req({ "sec-fetch-site": "cross-site" }), url));
  assert(!uiOriginAllowed(req({ "sec-fetch-site": "same-site" }), url));
  assert(!uiOriginAllowed(req({}), new URL("http://evil.test:5177/")));
  assert(uiOriginAllowed(req({}), new URL("http://localhost:5177/")));
  assert(uiOriginAllowed(req({}), new URL("http://[::1]:5177/")));
  assert(uiOriginAllowed(req({ origin: "http://127.0.0.1:5177" }), url));
  assert(!uiOriginAllowed(req({ origin: "http://attacker.test" }), url));
  assert(!uiOriginAllowed(req({ origin: "not a url" }), url));
});

Deno.test("constantTimeEqual matches only identical strings", () => {
  assert(constantTimeEqual("abc", "abc"));
  assert(!constantTimeEqual("abc", "abd"));
  assert(!constantTimeEqual("abc", "abcd"));
  assert(!constantTimeEqual("", "a"));
  assert(constantTimeEqual("", ""));
});

Deno.test("deriveCsrf is deterministic per token and differs between tokens", async () => {
  const a = await deriveCsrf("token-a");
  assertEquals(a, await deriveCsrf("token-a"));
  assert(a !== await deriveCsrf("token-b"));
  assert(a.length >= 43);
});

Deno.test("uiSafeJoin rejects .., absolute paths, and a symlink escaping the root", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext_ui_join_" });
  const outside = await Deno.makeTempDir({ prefix: "denext_ui_out_" });
  try {
    await Deno.writeTextFile(join(root, "ok.txt"), "in");
    await Deno.writeTextFile(join(outside, "secret.txt"), "out");
    await Deno.symlink(outside, join(root, "escape"));

    assertEquals(await uiSafeJoin(root, "ok.txt"), join(root, "ok.txt"));
    assertEquals(await uiSafeJoin(root, "sub/new.txt"), join(root, "sub/new.txt"));

    for (const bad of ["../secret.txt", "sub/../../secret.txt", join(outside, "secret.txt")]) {
      let threw = false;
      try {
        await uiSafeJoin(root, bad);
      } catch (error) {
        threw = true;
        assertStringIncludes(String(error), "outside the project");
      }
      assert(threw, `expected ${bad} to be refused`);
    }

    let symlinkRefused = false;
    try {
      await uiSafeJoin(root, "escape/secret.txt");
    } catch {
      symlinkRefused = true;
    }
    assert(symlinkRefused, "a symlink pointing outside the project must be refused");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("applySecurityHeaders never allows inline script", () => {
  const csp = applySecurityHeaders(new Response("x")).headers.get("content-security-policy")!;
  assert(!csp.includes("script-src 'self' 'unsafe-inline'"));
  assertStringIncludes(csp, "script-src 'self'");
  assertStringIncludes(csp, "style-src-attr 'unsafe-inline'");
});

Deno.test("newToken mints 256 bits of URL-safe entropy, fresh every call", () => {
  const minted = new Set<string>();
  for (let i = 0; i < 32; i++) {
    const token = newToken();
    assertEquals(token.length, 43, "256 bits, base64url, unpadded");
    assert(/^[A-Za-z0-9_-]+$/.test(token), token);
    minted.add(token);
  }
  assertEquals(minted.size, 32, "every launch gets a distinct token");
});

Deno.test("an explicit --token is adopted verbatim", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_tok_" });
  const server = await startUiServer({ dir, port: 0, token: "an-explicit-token" });
  try {
    assertEquals(server.token, "an-explicit-token");
    const res = await fetch(`http://127.0.0.1:${server.port}/?t=an-explicit-token`, {
      redirect: "manual",
    });
    await res.body?.cancel();
    assertEquals(res.status, 302);
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});
