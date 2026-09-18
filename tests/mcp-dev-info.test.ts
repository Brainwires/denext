// `.denext/dev.json` tells the MCP live tools where the running dev server is. A committed or
// planted one must not point them at another host.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { fetchDevInspect, fetchDevState, readDevInfo } from "../src/mcp/dev-client.ts";

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
