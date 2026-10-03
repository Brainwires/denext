// `.denext/dev.json` tells the MCP live tools where the running dev server is. A committed or
// planted one must not point them at another host.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { fetchDevInspect, fetchDevState, readDevInfo } from "../src/mcp/dev-client.ts";
import { writeDevInfo } from "../src/build/dev-server/dev-info.ts";

/** Run `fn` against a temp project holding `.denext/dev.json` = `body`. */
async function withDevJson(body: unknown, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext-dev-info-" });
  try {
    await Deno.mkdir(join(dir, ".denext"));
    await Deno.writeTextFile(join(dir, ".denext", "dev.json"), JSON.stringify(body));
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("readDevInfo: a loopback origin is kept, reduced to scheme, host and port", async () => {
  for (const origin of ["http://127.0.0.1:3000", "http://localhost:3000/", "http://[::1]:5173"]) {
    await withDevJson({ origin, port: 3000, pid: 4242 }, async (dir) => {
      assertEquals((await readDevInfo(dir))?.origin, new URL(origin).origin);
    });
  }
});

Deno.test("readDevInfo: any other origin reads as no dev server", async () => {
  const planted = [
    "http://attacker.example/x#",
    "http://127.0.0.1@attacker.example/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url",
    42,
  ];
  for (const origin of planted) {
    await withDevJson({ origin, port: 3000, pid: 4242 }, async (dir) => {
      assertEquals(await readDevInfo(dir), null, String(origin));
    });
  }
});

Deno.test("a loopback listener that redirects cannot bounce the tools off loopback", async () => {
  // A planted loopback origin is the one `readDevInfo` admits. If the listener there answers
  // `302 Location: elsewhere`, a fetch that followed it would carry the tool to that host with
  // the loopback check already passed. So a redirect is an error, never followed — proved by a
  // trap: the redirect target is a second listener that must see nothing.
  const hits: string[] = [];
  const trap = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (req) => {
    hits.push(new URL(req.url).pathname);
    return Response.json({ events: [{ kind: "server-error" }], total: 1, pid: 1, projectDir: "/" });
  });
  const trapOrigin = `http://127.0.0.1:${trap.addr.port}`;
  const bouncer = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (req) => {
    const to = new URL(req.url);
    return Response.redirect(`${trapOrigin}${to.pathname}${to.search}`, 302);
  });
  try {
    const origin = `http://127.0.0.1:${bouncer.addr.port}`;
    await withDevJson({ origin, port: bouncer.addr.port, pid: 4242 }, async (dir) => {
      assertEquals(await fetchDevState(dir, { kind: "error" }), null, "state: not followed");
      assertEquals((await fetchDevInspect(dir)).ok, false, "inspect: not followed");
    });
    assertEquals(hits, [], "the redirect target was never reached");
  } finally {
    await bouncer.shutdown();
    await trap.shutdown();
  }
});

// ── The writer: an origin a URL parser accepts, for every bind ───────────────────────────────

Deno.test("writeDevInfo: brackets an IPv6 bind and maps a wildcard to loopback", async () => {
  const cases: [string, string][] = [
    ["127.0.0.1", "http://127.0.0.1:5199"],
    ["localhost", "http://localhost:5199"],
    ["::1", "http://[::1]:5199"], // `localhost` that resolved to IPv6 — the T3 case
    ["0.0.0.0", "http://127.0.0.1:5199"],
    ["::", "http://[::1]:5199"],
    ["fe80::1", "http://[fe80::1]:5199"],
  ];
  for (const [hostname, origin] of cases) {
    const dir = await Deno.makeTempDir({ prefix: "denext-dev-info-w-" });
    try {
      writeDevInfo(join(dir, ".denext"), ["192.168.1.9"], { hostname, port: 5199 });
      const info = JSON.parse(await Deno.readTextFile(join(dir, ".denext", "dev.json")));
      assertEquals(info.origin, origin, hostname);
      assert(URL.canParse(info.origin), info.origin);
      assertEquals(info.hostname, hostname, "the bind is kept as given");
      assertEquals(info.pid, Deno.pid);
      assertEquals(info.devOrigins, ["192.168.1.9"]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

// ── The reader: every loopback spelling of the published port ────────────────────────────────

Deno.test("readDevInfo: lists the other loopback spellings after the published origin", async () => {
  await withDevJson({ origin: "http://[::1]:5199", pid: 4242 }, async (dir) => {
    assertEquals((await readDevInfo(dir))?.origins, [
      "http://[::1]:5199",
      "http://127.0.0.1:5199",
      "http://localhost:5199",
    ]);
  });
  await withDevJson({ origin: "http://0.0.0.0:3000", pid: 4242 }, async (dir) => {
    const info = await readDevInfo(dir);
    assertEquals(info?.origin, "http://127.0.0.1:3000", "a wildcard is never fetched as is");
    assertEquals(info?.origins.length, 3);
  });
});

Deno.test("readDevInfo: accepts the unbracketed IPv6 origin an older dev server wrote", async () => {
  await withDevJson({ origin: "http://::1:5199", hostname: "::1", pid: 4242 }, async (dir) => {
    assertEquals((await readDevInfo(dir))?.origin, "http://[::1]:5199");
  });
  // Still loopback only: a legacy-shaped origin naming another IPv6 host is refused.
  await withDevJson({ origin: "http://fe80::1:5199", pid: 4242 }, async (dir) => {
    assertEquals(await readDevInfo(dir), null);
  });
});

/** Serve a fake `/_denext/dev-state` on `[::1]` (ephemeral port); null when IPv6 is off. */
function serveOnIpv6(
  message: string,
): { server: Deno.HttpServer<Deno.NetAddr>; port: number } | null {
  try {
    const server = Deno.serve({ hostname: "::1", port: 0, onListen() {} }, () =>
      Response.json({
        events: [{ kind: "error", message }],
        total: 1,
        pid: Deno.pid,
        projectDir: "/",
      }));
    return { server, port: server.addr.port };
  } catch {
    return null; // no IPv6 loopback on this machine (some CI containers)
  }
}

Deno.test("fetchDevState: reaches a dev server on [::1] through the dev.json its writer wrote", async () => {
  const served = serveOnIpv6("from-ipv6");
  if (!served) return;
  const dir = await Deno.makeTempDir({ prefix: "denext-dev-info-v6-" });
  try {
    writeDevInfo(join(dir, ".denext"), [], { hostname: "::1", port: served.port });
    assertEquals((await fetchDevState(dir))?.events[0].message, "from-ipv6");
  } finally {
    await served.server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fetchDevState: a legacy unbracketed file still reaches the [::1] server", async () => {
  const served = serveOnIpv6("legacy-file");
  if (!served) return;
  try {
    const origin = `http://::1:${served.port}`; // what dev.json held before the fix
    await withDevJson({ origin, hostname: "::1", port: served.port, pid: 4242 }, async (dir) => {
      assertEquals((await fetchDevState(dir))?.events[0].message, "legacy-file");
    });
  } finally {
    await served.server.shutdown();
  }
});

Deno.test("fetchDevState: falls back to [::1] when the published 127.0.0.1 does not answer", async () => {
  // A wildcard (`::`) listener that refuses IPv4, or a file naming the other family: the
  // reader tries the remaining loopback spellings of the same port.
  const served = serveOnIpv6("fallback");
  if (!served) return;
  try {
    const origin = `http://127.0.0.1:${served.port}`;
    await withDevJson({ origin, hostname: "::", port: served.port, pid: 4242 }, async (dir) => {
      assertEquals((await fetchDevState(dir))?.events[0].message, "fallback");
    });
  } finally {
    await served.server.shutdown();
  }
});
