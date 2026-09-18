// `.denext/dev.json` tells the MCP live tools where the running dev server is. A committed or
// planted one must not point them at another host.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { readDevInfo } from "../src/mcp/dev-client.ts";

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
