// `denext_dev_logs` finds a running SPA dev server through the `.denext/dev.json` it wrote —
// including one bound to IPv6 loopback, whose origin must be bracketed (`http://[::1]:N`) for
// a reader to parse it. In-process: the real SPA dev server on an ephemeral port, its
// `.denext` redirected to a temp dir so the example's own tree is left alone.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { resolveProject } from "../src/build/paths.ts";
import { startSpaDevServer } from "../src/build/spa.ts";
import { fetchDevState, readDevInfo } from "../src/mcp/dev-client.ts";
import { runTool } from "../src/mcp/tools.ts";

const SPA = fromFileUrl(new URL("../examples/spa", import.meta.url));

/** Boot the SPA dev server on `hostname`, publishing to `<dir>/.denext`; null when it can't bind. */
async function bootSpaDev(dir: string, hostname: string) {
  const paths = { ...await resolveProject(SPA), outDir: join(dir, ".denext") };
  const controller = new AbortController();
  const listening = Promise.withResolvers<{ hostname: string; port: number }>();
  let server: Deno.HttpServer;
  try {
    server = startSpaDevServer({
      paths,
      port: 0,
      hostname,
      strictPort: true,
      signal: controller.signal,
      onListen: (info) => listening.resolve(info),
    });
  } catch {
    return null; // e.g. no IPv6 loopback in this container
  }
  const info = await listening.promise;
  return {
    info,
    close: async () => {
      controller.abort();
      await server.finished;
    },
  };
}

Deno.test({
  name: "denext_dev_logs finds an SPA dev server bound to [::1] and reads the page's console",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const prior = Deno.env.get("DENEXT_DEV_TYPECHECK");
  Deno.env.set("DENEXT_DEV_TYPECHECK", "0");
  const dir = await Deno.makeTempDir({ prefix: "denext-spa-devlogs-" });
  const dev = await bootSpaDev(dir, "::1");
  try {
    if (!dev) return;
    const published = JSON.parse(await Deno.readTextFile(join(dir, ".denext", "dev.json")));
    assertEquals(published.origin, `http://[::1]:${dev.info.port}`);
    const info = await readDevInfo(dir);
    assert(info, "dev.json reads as a running dev server");
    // The page's console arrives the way the capture script sends it.
    const post = await fetch(`${info.origin}/_denext/dev-log`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ level: "error", message: "boom from the ipv6 page", url: "/" }]),
    });
    assertEquals(post.status, 204);
    await post.body?.cancel();
    // The identity a reader checks: the pid the file names is the pid the server reports —
    // the process that listens, whichever process the user started.
    const state = await fetchDevState(dir);
    assertEquals(state?.pid, info.pid);
    const res = await runTool("denext_dev_logs", { dir });
    assert(!res.isError, res.content[0].text);
    assertStringIncludes(res.content[0].text, "boom from the ipv6 page");
  } finally {
    await dev?.close();
    if (prior === undefined) Deno.env.delete("DENEXT_DEV_TYPECHECK");
    else Deno.env.set("DENEXT_DEV_TYPECHECK", prior);
    await Deno.remove(dir, { recursive: true });
  }
});
