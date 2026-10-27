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

/** A page's component tree, as the DevTools sink posts it. */
function snapshot(url: string) {
  return {
    url,
    at: Date.now(),
    truncated: false,
    nodes: [{
      id: 1,
      name: "SpaCounter",
      key: null,
      props: { preview: "{label}", type: "object", size: 1 },
      hooks: [{
        index: 0,
        kind: "state",
        value: { preview: "3", type: "number" },
        editable: true,
        name: "count",
        hook: "useState",
      }],
      contexts: [],
      hooksNamed: true,
      reason: { props: ["label"], hooks: [0], contexts: [], count: 2 },
      children: [],
    }],
  };
}

/**
 * Act as an open SPA page: subscribe to the reload stream and answer each `inspect` frame by
 * posting the tree, as the reload script + DevTools sink do. Returns how many pulls it answered.
 */
function fakePage(
  origin: string,
  signal: AbortSignal,
): { pulls: () => number; ready: Promise<void> } {
  let pulls = 0;
  const ready = Promise.withResolvers<void>();
  (async () => {
    const res = await fetch(`${origin}/_denext/reload`, { signal });
    ready.resolve();
    const decoder = new TextDecoder();
    for await (const chunk of res.body!) {
      for (const m of decoder.decode(chunk).matchAll(/^data: (.*)$/gm)) {
        if (m[1] !== "inspect") continue;
        pulls++;
        const post = await fetch(`${origin}/_denext/dev-inspect`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(snapshot("/")),
        });
        await post.body?.cancel();
      }
    }
  })().catch(() => {});
  return { pulls: () => pulls, ready: ready.promise };
}

Deno.test({
  name: "SPA dev: the DevTools tools pull the open page's tree over the reload stream",
}, async () => {
  const prior = Deno.env.get("DENEXT_DEV_TYPECHECK");
  Deno.env.set("DENEXT_DEV_TYPECHECK", "0");
  const dir = await Deno.makeTempDir({ prefix: "denext-spa-inspect-" });
  const dev = await bootSpaDev(dir, "127.0.0.1");
  const page = new AbortController();
  try {
    assert(dev, "the SPA dev server binds 127.0.0.1");
    const origin = `http://127.0.0.1:${dev.info.port}`;
    // The endpoint sits behind the dev origin gate, as on the App Router dev server.
    const foreign = await fetch(`${origin}/_denext/dev-inspect`, {
      headers: { origin: "https://evil.example" },
    });
    assertEquals(foreign.status, 403);
    await foreign.body?.cancel();
    // No page open: the read answers at once, saying so.
    const none = await runTool("denext_component_tree", { dir });
    assert(none.isError);
    assertStringIncludes(none.content[0].text, "open the app in a browser");

    const tab = fakePage(origin, page.signal);
    await tab.ready;
    // The FIRST read already has the tree: it asked the page for it.
    const tree = await runTool("denext_component_tree", { dir });
    assert(!tree.isError, tree.content[0].text);
    assertStringIncludes(tree.content[0].text, "SpaCounter");
    assertEquals(tab.pulls(), 1);
    const why = await runTool("denext_why_render", { dir, component: "SpaCounter" });
    assert(!why.isError, why.content[0].text);
    assertStringIncludes(why.content[0].text, "label");
    const hooks = await runTool("denext_hook_state", { dir, component: "SpaCounter" });
    assert(!hooks.isError, hooks.content[0].text);
    assertStringIncludes(hooks.content[0].text, "count");
  } finally {
    page.abort();
    await dev?.close();
    if (prior === undefined) Deno.env.delete("DENEXT_DEV_TYPECHECK");
    else Deno.env.set("DENEXT_DEV_TYPECHECK", prior);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("SPA dev: the reload script hands an `inspect` frame to the DevTools sink", async () => {
  const { SPA_DEV_RELOAD } = await import("../src/build/spa/dev-reload-script.ts");
  assertStringIncludes(SPA_DEV_RELOAD, 'e.data === "inspect"');
  assertStringIncludes(SPA_DEV_RELOAD, "__denextInspectPull");
});
