// `<Script strategy="worker">` through Partytown (`nextScriptWorkers`): the markup `<Script>`
// renders for each state of the slot, finding the app's Partytown package, the generated boot
// script, and publishing + serving the files (build, dev, prod, export).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { Script, setScriptWorkers } from "../src/runtime/script.ts";
import {
  findPartytownLib,
  loadPartytownBuild,
  PARTYTOWN_BUILD_DIR,
  PARTYTOWN_MISSING_WARNING,
  partytownBootSource,
  partytownPublicLib,
  preparePartytown,
  scriptWorkersEnabled,
  servePartytown,
} from "../src/build/partytown.ts";
import { createProdHandler } from "../src/build/prod-server/handler.ts";
import type { DenextConfig } from "../src/server/config.ts";

const LIB = "/_denext/~partytown/";
const ON: DenextConfig = { nextScriptWorkers: true };

/** Run `fn` with the slot set to `value`, restoring "off" after. */
async function withWorkers<T>(
  value: Parameters<typeof setScriptWorkers>[0],
  fn: () => Promise<T>,
): Promise<T> {
  setScriptWorkers(value);
  try {
    return await fn();
  } finally {
    setScriptWorkers(undefined);
  }
}

/** Capture `console.warn` while `fn` runs, with the dev flag on. */
async function devWarnings(fn: () => Promise<unknown>): Promise<string[]> {
  const g = globalThis as { __denextDev?: boolean };
  const prior = g.__denextDev;
  const original = console.warn;
  const seen: string[] = [];
  console.warn = (...args: unknown[]) => void seen.push(args.join(" "));
  g.__denextDev = true;
  try {
    await fn();
  } finally {
    console.warn = original;
    g.__denextDev = prior;
  }
  return seen;
}

/** A fake installed Partytown package under `<root>/node_modules/<name>`. */
async function fakePartytown(root: string, name: string, snippet = "/*pt*/"): Promise<string> {
  const dir = join(root, "node_modules", ...name.split("/"));
  await Deno.mkdir(join(dir, "lib", "debug"), { recursive: true });
  await Deno.writeTextFile(join(dir, "package.json"), JSON.stringify({ name }));
  await Deno.writeTextFile(join(dir, "lib", "partytown.js"), snippet);
  await Deno.writeTextFile(join(dir, "lib", "partytown-sw.js"), "/*sw*/");
  await Deno.writeTextFile(join(dir, "lib", "debug", "partytown-sw.js"), "/*debug sw*/");
  return join(dir, "lib");
}

Deno.test("Script worker with Partytown published: boot script + text/partytown, no defer", async () => {
  const html = await withWorkers(
    { lib: LIB },
    () => renderToString(h(Script, { src: "/w.js", strategy: "worker", id: "w" })),
  );
  assertStringIncludes(html, `<script src="${LIB}boot.js"></script>`);
  assertStringIncludes(html, `<script src="/w.js" id="w" type="text/partytown"></script>`);
  assert(!html.includes("defer"), html);
  assert(html.indexOf("boot.js") < html.indexOf("/w.js"), "the boot script comes first");
});

Deno.test("Script worker inline source runs as text/partytown, verbatim", async () => {
  const html = await withWorkers(
    { lib: LIB },
    () => renderToString(h(Script, { strategy: "worker", children: "self.x = 1 < 2" })),
  );
  assertStringIncludes(html, `<script type="text/partytown">self.x = 1 < 2</script>`);
});

Deno.test("Script worker falls back to the main thread when Partytown is missing, naming the fix", async () => {
  let html = "";
  const warnings = await devWarnings(() =>
    withWorkers({ missing: true }, async () => {
      html = await renderToString(h(Script, { src: "/w.js", strategy: "worker" }));
    })
  );
  assertStringIncludes(html, `<script src="/w.js" defer="">`);
  assert(!html.includes("partytown"), html);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "Partytown is not installed");
  assertStringIncludes(warnings[0], "@qwik.dev/partytown");
});

Deno.test("Script worker with the option off falls back and names the config flag", async () => {
  let html = "";
  const warnings = await devWarnings(async () => {
    html = await renderToString(h(Script, { src: "/w.js", strategy: "worker" }));
  });
  assertStringIncludes(html, `<script src="/w.js" defer="">`);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "set `nextScriptWorkers: true`");
});

Deno.test("other strategies ignore the Partytown slot", async () => {
  const html = await withWorkers(
    { lib: LIB },
    () => renderToString(h(Script, { src: "/a.js", strategy: "afterInteractive" })),
  );
  assertEquals(html, `<script src="/a.js" defer=""></script>`);
});

Deno.test("scriptWorkersEnabled: the top-level field, else Next's experimental spelling", () => {
  assert(scriptWorkersEnabled(ON));
  assert(scriptWorkersEnabled({ experimental: { nextScriptWorkers: true } }));
  assert(
    !scriptWorkersEnabled({ nextScriptWorkers: false, experimental: { nextScriptWorkers: true } }),
  );
  assert(!scriptWorkersEnabled({}));
  assert(!scriptWorkersEnabled(null));
  assert(!scriptWorkersEnabled({ nextScriptWorkers: "yes" as unknown as boolean }));
});

Deno.test("partytownPublicLib sits below basePath", () => {
  assertEquals(partytownPublicLib(ON), LIB);
  assertEquals(partytownPublicLib({ ...ON, basePath: "/docs/" }), "/docs" + LIB);
});

/** Run a boot script against a fake page; returns the page and its MutationObserver callback. */
function bootPage(src: string, page: Record<string, unknown> = {}) {
  const observed: Array<(records: unknown[]) => void> = [];
  class FakeObserver {
    constructor(cb: (records: unknown[]) => void) {
      observed.push(cb);
    }
    observe() {}
  }
  const events: string[] = [];
  page.dispatchEvent = (e: Event) => void events.push(e.type);
  new Function("window", "document", "MutationObserver", src)(page, {}, FakeObserver);
  return { page, observed, events };
}

Deno.test("partytownBootSource configures lib, keeps the app's keys, and runs once", () => {
  const src = partytownBootSource(LIB, "window.__runs = (window.__runs || 0) + 1;");
  const { page } = bootPage(src, { partytown: { debug: true } });
  new Function("window", "document", "MutationObserver", src)(page, {}, class {});
  assertEquals(page.__runs, 1); // a second worker <Script> carries the boot script again
  assertEquals(page.partytown, { lib: LIB, debug: true });
  assertEquals(page.__denextScriptWorkers, { lib: LIB });
  // An app-set lib wins (Next's `data-partytown-config` override, as the docs describe).
  const custom = bootPage(src, { partytown: { lib: "/pt/" } }).page;
  assertEquals((custom.partytown as { lib: string }).lib, "/pt/");
});

Deno.test("partytownBootSource hands worker scripts a client render adds to Partytown", async () => {
  const { observed, events } = bootPage(partytownBootSource(LIB, ""));
  assertEquals(observed.length, 1);
  const added = (...nodes: unknown[]) => [{ addedNodes: nodes }];
  observed[0](added({ nodeName: "DIV" }, { nodeName: "SCRIPT", type: "text/javascript" }));
  await new Promise((r) => setTimeout(r, 5));
  assertEquals(events, []);
  // Two in one batch, and another before the update fires: one `ptupdate`.
  const worker = { nodeName: "SCRIPT", type: "text/partytown" };
  observed[0](added(worker, worker));
  observed[0](added(worker));
  await new Promise((r) => setTimeout(r, 5));
  assertEquals(events, ["ptupdate"]);
});

Deno.test("partytownBootSource scopes the snippet's top-level bindings", () => {
  // Partytown's lib/partytown.js declares top-level `const t=…`: unscoped, a second copy (or
  // any other script's `t`) would throw a redeclaration error.
  const src = partytownBootSource(LIB, "const t = 1; window.t = t;");
  assert(/^\(function \(\) \{$/m.test(src));
  assertStringIncludes(src, "})();");
});

Deno.test("findPartytownLib prefers @qwik.dev/partytown, then Next's @builder.io/partytown", async () => {
  const root = await Deno.makeTempDir();
  try {
    const app = join(root, "app");
    await Deno.mkdir(app);
    assertEquals(await findPartytownLib(app), null);
    const builder = await fakePartytown(root, "@builder.io/partytown"); // hoisted one level up
    assertEquals(await findPartytownLib(app), await Deno.realPath(builder));
    const qwik = await fakePartytown(app, "@qwik.dev/partytown");
    assertEquals(await findPartytownLib(app), await Deno.realPath(qwik));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("preparePartytown: off clears the slot, missing warns, installed publishes", async () => {
  const root = await Deno.makeTempDir();
  const dest = join(root, "out", "pt");
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    setScriptWorkers({ lib: "/stale/" });
    assertEquals(await preparePartytown({}, root, dest), false);
    assertEquals(
      await renderToString(h(Script, { src: "/w.js", strategy: "worker" })),
      `<script src="/w.js" defer=""></script>`,
    );

    assertEquals(await preparePartytown(ON, root, dest), false);
    assertEquals(warnings, [PARTYTOWN_MISSING_WARNING]);

    await fakePartytown(root, "@builder.io/partytown", "/*the snippet*/");
    assertEquals(await preparePartytown({ ...ON, basePath: "/b" }, root, dest), true);
    const boot = await Deno.readTextFile(join(dest, "boot.js"));
    assertStringIncludes(boot, `lib: "/b${LIB}"`);
    assertStringIncludes(boot, "/*the snippet*/");
    assertEquals(await Deno.readTextFile(join(dest, "partytown-sw.js")), "/*sw*/");
    assertEquals(await Deno.readTextFile(join(dest, "debug", "partytown-sw.js")), "/*debug sw*/");
    const html = await renderToString(h(Script, { src: "/w.js", strategy: "worker" }));
    assertStringIncludes(html, `<script src="/b${LIB}boot.js"></script>`);
  } finally {
    console.warn = original;
    setScriptWorkers(undefined);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("loadPartytownBuild points <Script> at the build's files, or keeps the fallback", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await loadPartytownBuild(ON, dir);
    let html = await renderToString(h(Script, { src: "/w.js", strategy: "worker" }));
    assertStringIncludes(html, `defer=""`);
    await Deno.writeTextFile(join(dir, "boot.js"), "/*boot*/");
    await loadPartytownBuild(ON, dir);
    html = await renderToString(h(Script, { src: "/w.js", strategy: "worker" }));
    assertStringIncludes(html, `type="text/partytown"`);
    await loadPartytownBuild({}, dir); // the option turned off again
    html = await renderToString(h(Script, { src: "/w.js", strategy: "worker" }));
    assertStringIncludes(html, `defer=""`);
  } finally {
    setScriptWorkers(undefined);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("servePartytown serves JavaScript under the prefix only, never outside its dir", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "boot.js"), "/*boot*/");
    const req = (p: string) => new Request("http://localhost" + p);
    assertEquals(servePartytown(dir, "/_denext/client/x.js", req("/x"), false, undefined), null);
    const res = await servePartytown(dir, LIB + "boot.js", req(LIB + "boot.js"), false, undefined)!;
    assertEquals(res.status, 200);
    assertStringIncludes(res.headers.get("content-type") ?? "", "javascript");
    assert(!(res.headers.get("cache-control") ?? "").includes("immutable"));
    assertEquals(await res.text(), "/*boot*/");
    const out = await servePartytown(dir, LIB + "../../etc/passwd", req("/"), false, undefined)!;
    assertEquals(out.status, 404);
    await out.body?.cancel();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the production handler serves the build's Partytown files below basePath", async () => {
  const clientDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(clientDir, PARTYTOWN_BUILD_DIR));
    await Deno.writeTextFile(join(clientDir, PARTYTOWN_BUILD_DIR, "partytown-sw.js"), "/*sw*/");
    const handler = createProdHandler(
      { config: null } as unknown as Parameters<typeof createProdHandler>[0],
      clientDir,
      "/b",
      false,
      () => Promise.resolve(new Response("app", { status: 404 })),
    );
    const res = await handler(new Request(`http://localhost/b${LIB}partytown-sw.js`));
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "/*sw*/");
    assertEquals(res.headers.get("x-content-type-options"), "nosniff");
  } finally {
    await Deno.remove(clientDir, { recursive: true });
  }
});

Deno.test({
  name: "denext export publishes Partytown below basePath and the pages point at it",
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-pt-export-" });
  try {
    const root = new URL("../", import.meta.url).href;
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
        imports: {
          "denext": `${root}mod.ts`,
          "denext/jsx-runtime": `${root}src/jsx/jsx-runtime.ts`,
          "denext/server": `${root}src/server/mod.ts`,
          "denext/client": `${root}src/client/mod.ts`,
        },
      }),
    );
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      // Next's spelling, as a migrated next.config carries it (honored, with a moved warning).
      'export default { basePath: "/base", experimental: { nextScriptWorkers: true } };\n',
    );
    await Deno.mkdir(join(dir, "app"));
    await Deno.writeTextFile(
      join(dir, "app", "layout.tsx"),
      `export default function Layout({ children }: { children: unknown }) {
  return <html lang="en"><body>{children}</body></html>;
}
`,
    );
    await Deno.writeTextFile(
      join(dir, "app", "page.tsx"),
      `import { Script } from "denext";
export default function Page() {
  return <main><Script src="/base/probe.js" strategy="worker" /></main>;
}
`,
    );
    await fakePartytown(dir, "@builder.io/partytown", "/*the snippet*/");
    const cli = new URL("../cli.ts", import.meta.url).pathname;
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", cli, "export", dir],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const log = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
    assert(out.success, log);
    const outDir = join(dir, "out");
    const html = await Deno.readTextFile(join(outDir, "index.html"));
    assertStringIncludes(html, `<script src="/base${LIB}boot.js"></script>`);
    assertStringIncludes(html, `<script src="/base/probe.js" type="text/partytown"></script>`);
    const boot = await Deno.readTextFile(join(outDir, "_denext", "~partytown", "boot.js"));
    assertStringIncludes(boot, `lib: "/base${LIB}"`);
    assertStringIncludes(boot, "/*the snippet*/");
    await Deno.stat(join(outDir, "_denext", "~partytown", "partytown-sw.js"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
