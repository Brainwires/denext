// The six-layer local security model of `denext ui` (src/ui/security.ts + the server's chain):
// host/origin gate, the single-use `?t=` → cookie handshake, CSRF on mutations, the method table,
// the exact response header set, path containment (including `uiSafeUnder` on a planner's own
// absolute paths and `writeFileAtomic`), the detail-free 500, and `--read-only`.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  applySecurityHeaders,
  constantTimeEqual,
  deriveCsrf,
  MIN_UI_TOKEN_LENGTH,
  newToken,
  StaleWriteError,
  UI_COOKIE,
  UI_CSRF_HEADER,
  uiOriginAllowed,
  uiSafeJoin,
  uiSafeUnder,
  writeFileAtomic,
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
    // Past every gate: the config panel itself answers — a POST that names no section is its
    // own 400 — rather than a 403 from the security chain.
    assertEquals(res.status, 400);
    assertEquals((await res.json()).reason, 'unknown config section ""');
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
    assertEquals(res.headers.get("referrer-policy"), "same-origin");
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
  const token = "an-explicit-token-long-enough";
  const server = await startUiServer({ dir, port: 0, token });
  try {
    assertEquals(server.token, token);
    const res = await fetch(`http://127.0.0.1:${server.port}/?t=${token}`, {
      redirect: "manual",
    });
    await res.body?.cancel();
    assertEquals(res.status, 302);
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a --token under 128 bits of entropy is refused at startup", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_shorttok_" });
  try {
    await assertRejects(
      () => startUiServer({ dir, port: 0, token: "short" }),
      Error,
      `--token must be at least ${MIN_UI_TOKEN_LENGTH} characters`,
    );
    assertEquals("x".repeat(MIN_UI_TOKEN_LENGTH - 1).length + 1, MIN_UI_TOKEN_LENGTH);
    const ok = await startUiServer({ dir, port: 0, token: "y".repeat(MIN_UI_TOKEN_LENGTH) });
    await ok.shutdown();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the ?t= handshake is single-use: a replayed link is 401", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_once_" });
  const server = await startUiServer({ dir, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const first = await fetch(`${base}/?t=${server.token}`, { redirect: "manual" });
    await first.body?.cancel();
    assertEquals(first.status, 302);
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];

    // A second browser (no cookie) replaying the copied link gets nothing.
    const replay = await fetch(`${base}/?t=${server.token}`, { redirect: "manual" });
    assertEquals(replay.status, 401);
    assertEquals((await replay.json()).reason, "unauthorized");

    // The tab that already holds the session may still re-open its own link.
    const again = await fetch(`${base}/config?t=${server.token}`, {
      redirect: "manual",
      headers: { cookie },
    });
    await again.body?.cancel();
    assertEquals(again.status, 302);
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an open /_ui/events stream does not hold shutdown open", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_drain_" });
  const server = await startUiServer({ dir, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const first = await fetch(`${base}/?t=${server.token}`, { redirect: "manual" });
    await first.body?.cancel();
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
    const events = await fetch(`${base}/_ui/events`, { headers: { cookie } });
    const reader = events.body!.getReader();
    await reader.read(); // the `retry:` frame — the stream is live

    const started = performance.now();
    await server.shutdown();
    assert(
      performance.now() - started < 5_000,
      "shutdown drained with a subscriber still attached",
    );
    await reader.cancel().catch(() => {});
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a handler that throws is a hardened, detail-free 500", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_500_" });
  // `/config` reads the project dir; removing it under the server makes `readState` throw.
  const server = await startUiServer({ dir, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const first = await fetch(`${base}/?t=${server.token}`, { redirect: "manual" });
    await first.body?.cancel();
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
    await Deno.remove(dir, { recursive: true });
    const res = await fetch(`${base}/api/config`, { headers: { cookie } });
    const body = await res.json();
    if (res.status === 500) {
      assertEquals(body.reason, "internal error", "no path or stack is echoed to the page");
      assertStringIncludes(res.headers.get("content-security-policy") ?? "", "default-src 'self'");
      assertEquals(res.headers.get("x-content-type-options"), "nosniff");
    }
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── containment: symlinks, absolute paths, atomic writes ─────────────────────

Deno.test("uiSafeUnder refuses an absolute path that resolves out through a symlink", async () => {
  const outside = await Deno.makeTempDir({ prefix: "denext_out_" });
  const dir = await Deno.makeTempDir({ prefix: "denext_in_" });
  try {
    await Deno.symlink(outside, join(dir, "app"));
    assertEquals(await uiSafeUnder(dir, join(dir, "pages", "x.tsx")), join(dir, "pages", "x.tsx"));
    await assertRejects(
      () => uiSafeUnder(dir, join(dir, "app", "x.tsx")),
      Error,
      "outside the project",
    );
    await assertRejects(() => uiSafeUnder(dir, join(outside, "x")), Error, "outside the project");
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("writeFileAtomic renames into place, contains, and leaves no temp behind", async () => {
  const outside = await Deno.makeTempDir({ prefix: "denext_out_" });
  const dir = await Deno.makeTempDir({ prefix: "denext_in_" });
  try {
    const secret = join(outside, "secret.ts");
    await Deno.writeTextFile(secret, "keep me\n");
    await Deno.symlink(secret, join(dir, "denext.config.ts"));

    await assertRejects(
      () => writeFileAtomic(dir, "denext.config.ts", "pwned"),
      Error,
      "outside the project",
    );
    assertEquals(await Deno.readTextFile(secret), "keep me\n");

    const written = await writeFileAtomic(dir, "nested/deno.json", "{}\n");
    assertEquals(written, join(dir, "nested", "deno.json"));
    assertEquals(await Deno.readTextFile(written), "{}\n");
    const leftovers = [];
    for await (const entry of Deno.readDir(join(dir, "nested"))) leftovers.push(entry.name);
    assertEquals(leftovers, ["deno.json"], "the .tmp file was renamed, not left lying around");
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("the handshake never answers with a protocol-relative Location", async () => {
  const s = await ui();
  try {
    const res = await fetch(`${s.base}//evil.example/x?t=${s.server.token}`, {
      redirect: "manual",
    });
    await res.body?.cancel();
    assertEquals(res.status, 302);
    assertEquals(res.headers.get("location"), "/evil.example/x");
  } finally {
    await stop(s);
  }
});

Deno.test("writeFileAtomic: unchangedFrom refuses a file that changed since it was read", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_stale_" });
  try {
    await Deno.writeTextFile(join(dir, "a.txt"), "one");
    await writeFileAtomic(dir, "a.txt", "two", { unchangedFrom: "one" });
    assertEquals(await Deno.readTextFile(join(dir, "a.txt")), "two");
    await assertRejects(
      () => writeFileAtomic(dir, "a.txt", "three", { unchangedFrom: "one" }),
      StaleWriteError,
    );
    assertEquals(await Deno.readTextFile(join(dir, "a.txt")), "two", "nothing was written");
    assertEquals([...Deno.readDirSync(dir)].map((e) => e.name), ["a.txt"], "no .tmp left");
    await writeFileAtomic(dir, "new.txt", "x", { unchangedFrom: "" });
    assertEquals(
      await Deno.readTextFile(join(dir, "new.txt")),
      "x",
      "an absent file reads as empty",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
