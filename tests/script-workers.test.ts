// `<Script strategy="worker">` through Partytown (`nextScriptWorkers`): the markup `<Script>`
// renders for each state of the slot, finding the app's Partytown package, the generated boot
// script, and publishing + serving the files (build, dev, prod, export).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { Script, scriptWorkerNonce, setScriptWorkers } from "../src/runtime/script.ts";
import { computeCsp, computeStreamingCsp } from "../src/server/csp.ts";
import { Fragment } from "../src/jsx/jsx-runtime.ts";
import {
  findPartytownLib,
  loadPartytownBuild,
  PARTYTOWN_BUILD_DIR,
  PARTYTOWN_MISSING_WARNING,
  PARTYTOWN_UNSUPPORTED_WARNING,
  partytownBootSource,
  partytownPublicLib,
  partytownServiceWorkerSource,
  preparePartytown,
  scriptWorkersEnabled,
  servePartytown,
} from "../src/build/partytown.ts";
import { createProdHandler } from "../src/build/prod-server/handler.ts";
import type { DenextConfig } from "../src/server/config.ts";
import { boundedOutput } from "./helpers/bounded-command.ts";

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

/** A snippet in the shape Partytown's lib/partytown.js has (its last argument picks atomics). */
const SNIPPET = "!function(t,a){t.__ptMode=a}(window,window.crossOriginIsolated);";

/** A fake installed Partytown package under `<root>/node_modules/<name>`. */
async function fakePartytown(root: string, name: string, snippet = SNIPPET): Promise<string> {
  const dir = join(root, "node_modules", ...name.split("/"));
  await Deno.mkdir(join(dir, "lib", "debug"), { recursive: true });
  await Deno.writeTextFile(join(dir, "package.json"), JSON.stringify({ name }));
  await Deno.writeTextFile(join(dir, "lib", "partytown.js"), snippet);
  await Deno.writeTextFile(join(dir, "lib", "partytown-sw.js"), "/*sw*/");
  await Deno.writeTextFile(join(dir, "lib", "partytown-media.js"), "/*media*/");
  await Deno.writeTextFile(join(dir, "lib", "partytown-atomics.js"), "/*atomics*/");
  await Deno.writeTextFile(join(dir, "lib", "debug", "partytown-sw.js"), "/*debug sw*/");
  return join(dir, "lib");
}

/** The `nonce="…"` values in rendered markup. */
function nonces(html: string): string[] {
  return [...html.matchAll(/nonce="([^"]*)"/g)].map((m) => m[1]);
}

Deno.test("Script worker with Partytown published: boot + text/partytown, one per-response nonce", async () => {
  const html = await withWorkers(
    { lib: LIB },
    () =>
      renderToString(
        h(
          Fragment,
          null,
          h(Script, { src: "/w.js", strategy: "worker", id: "w" }),
          h(Script, {
            src: "/v.js",
            strategy: "worker",
            nonce: "app-set", // the app's own nonce prop cannot widen what runs
          }),
        ),
      ),
  );
  const [nonce] = nonces(html);
  assert(/^[0-9a-f]{32}$/.test(nonce), html);
  assertEquals(nonces(html), [nonce, nonce, nonce, nonce], "every tag carries the same nonce");
  assertStringIncludes(html, `<script src="${LIB}boot.js" nonce="${nonce}"></script>`);
  assertStringIncludes(
    html,
    `<script src="/w.js" id="w" type="text/partytown" nonce="${nonce}"></script>`,
  );
  assert(!html.includes("defer"), html);
  assert(html.indexOf("boot.js") < html.indexOf("/w.js"), "the boot script comes first");
});

Deno.test("Script worker inline source runs as text/partytown, verbatim", async () => {
  const html = await withWorkers(
    { lib: LIB },
    () => renderToString(h(Script, { strategy: "worker", children: "self.x = 1 < 2" })),
  );
  assertStringIncludes(html, `type="text/partytown" nonce="`);
  assertStringIncludes(html, `">self.x = 1 < 2</script>`);
});

Deno.test("scriptWorkerNonce: none when off, the boot's in the browser, none in shared output", () => {
  assertEquals(scriptWorkerNonce(), null);
  setScriptWorkers({ missing: true });
  assertEquals(scriptWorkerNonce(), null);
  setScriptWorkers({ lib: LIB, nonce: "abc" }); // what boot.js sets in the browser
  assertEquals(scriptWorkerNonce(), "abc");
  setScriptWorkers({ lib: LIB, nonce: "" }); // the boot refused the page
  assertEquals(scriptWorkerNonce(), null);
  const g = globalThis as { __denextScriptWorkersShared?: () => boolean };
  const prior = g.__denextScriptWorkersShared;
  try {
    setScriptWorkers({ lib: LIB });
    g.__denextScriptWorkersShared = () => true; // a "use cache" body or a PPR shell
    assertEquals(scriptWorkerNonce(), null);
    g.__denextScriptWorkersShared = () => false;
    assert(scriptWorkerNonce());
  } finally {
    g.__denextScriptWorkersShared = prior;
    setScriptWorkers(undefined);
  }
});

Deno.test("Script worker in output that outlives the response takes the fallback, saying why", async () => {
  const g = globalThis as { __denextScriptWorkersShared?: () => boolean };
  const prior = g.__denextScriptWorkersShared;
  g.__denextScriptWorkersShared = () => true;
  let html = "";
  try {
    const warnings = await devWarnings(() =>
      withWorkers({ lib: LIB }, async () => {
        html = await renderToString(h(Script, { src: "/w.js", strategy: "worker" }));
      })
    );
    assertStringIncludes(warnings.join("\n"), '"use cache"');
  } finally {
    g.__denextScriptWorkersShared = prior;
  }
  assertEquals(html, `<script src="/w.js" defer=""></script>`);
});

Deno.test("the CSP lists the worker-script nonce only while Partytown is published", async () => {
  const scriptSrc = (csp: string) => csp.split("; ").find((d) => d.startsWith("script-src "));
  assertEquals(scriptSrc(await computeCsp("<p></p>")), "script-src 'self'");
  await withWorkers({ lib: LIB }, async () => {
    const nonce = scriptWorkerNonce();
    assertEquals(scriptSrc(await computeCsp("<p></p>")), `script-src 'self' 'nonce-${nonce}'`);
    assertStringIncludes(
      scriptSrc(await computeStreamingCsp("<p></p>"))!,
      `'nonce-${nonce}'`,
    );
    // A nonce would switch a route's 'unsafe-inline' off (CSP Level 2): left out there.
    assertEquals(
      scriptSrc(await computeCsp("<p></p>", { scriptSrc: ["'unsafe-inline'"] })),
      "script-src 'self' 'unsafe-inline'",
    );
  });
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

Deno.test("partytownBootSource checks nonces, holds scripts until then, and scopes the snippet", () => {
  const src = partytownBootSource(LIB, "const t = 1;");
  assert(/^\(function \(w, d\) \{$/m.test(src)); // the snippet's top-level bindings stay local
  assertStringIncludes(src, "})(window, document);");
  assertStringIncludes(src, `var LIB = "${LIB}";`);
  assertStringIncludes(src, "me && me.nonce"); // the nonce each boot tag ran with
  assertStringIncludes(src, 'var HELD = "text/denext-partytown-held";');
  assertStringIncludes(src, "probe.nonce = n;"); // the page's CSP must list it
  assertStringIncludes(src, "{ lib: LIB, debug: false }"); // only the published files exist
  assertStringIncludes(src, "denextPartytownTab"); // announces its tab to the gate
  assert(src.indexOf("function start()") < src.indexOf("const t = 1;"), "Partytown starts late");
});

/** Load the service-worker gate into a fake worker global with a stand-in Partytown. */
function gate() {
  const self: Record<string, unknown> = {};
  const imported: string[] = [];
  const importScripts = (url: string) => {
    imported.push(url);
    self.onfetch = (ev: { respondWith(r: Response): void }) =>
      ev.respondWith(new Response("sandbox"));
    self.onmessage = (ev: { data: unknown }) => void (self.lastMessage = ev.data);
  };
  new Function("self", "importScripts", partytownServiceWorkerSource())(self, importScripts);
  const fetch = (url: string) => {
    let out: Promise<Response> | Response | undefined;
    (self.onfetch as (ev: unknown) => void)({
      request: new Request(url),
      respondWith: (r: Promise<Response> | Response) => void (out = r),
    });
    return out;
  };
  const message = (data: unknown) => (self.onmessage as (ev: unknown) => void)({ data });
  return { self, imported, fetch, message };
}

Deno.test("the service worker serves a sandbox only to a tab a boot announced, once", async () => {
  const sw = gate();
  assertEquals(sw.imported, ["./partytown-sw-impl.js"]);
  const sandbox = `http://x${LIB}partytown-sandbox-sw.html?`;
  sw.message({ denextPartytownTab: "111" });
  assertEquals(await (await sw.fetch(sandbox + "111"))!.text(), "sandbox");
  // Used once: the same tab again, and a tab nobody announced (an injected iframe), are refused.
  const [again, rogue] = await Promise.all([sw.fetch(sandbox + "111"), sw.fetch(sandbox + "222")]);
  assertEquals([again!.status, rogue!.status], [403, 403]);
  // An announcement that arrives while the iframe's request waits still admits it.
  const pending = sw.fetch(sandbox + "333");
  sw.message({ denextPartytownTab: "333" });
  assertEquals((await pending!).status, 200);
  // Partytown's own messages and requests pass through.
  sw.message({ $msgId$: "m" });
  assertEquals(sw.self.lastMessage, { $msgId$: "m" });
  assertEquals(await (await sw.fetch(`http://x${LIB}proxytown`))!.text(), "sandbox");
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

    const lib = await fakePartytown(root, "@builder.io/partytown");
    assertEquals(await preparePartytown({ ...ON, basePath: "/b" }, root, dest), true);
    const boot = await Deno.readTextFile(join(dest, "boot.js"));
    assertStringIncludes(boot, `var LIB = "/b${LIB}";`);
    // The snippet, pinned to the service-worker mode (never atomics).
    assertStringIncludes(boot, "!function(t,a){t.__ptMode=a}(window,!1);");
    assertStringIncludes(await Deno.readTextFile(join(dest, "partytown-sw.js")), "importScripts");
    assertEquals(await Deno.readTextFile(join(dest, "partytown-sw-impl.js")), "/*sw*/");
    assertEquals(await Deno.readTextFile(join(dest, "partytown-media.js")), "/*media*/");
    // Nothing that starts Partytown as a page script is published.
    const published = [...Deno.readDirSync(dest)].map((e) => e.name).sort();
    assertEquals(published, [
      "boot.js",
      "partytown-media.js",
      "partytown-sw-impl.js",
      "partytown-sw.js",
    ]);
    const html = await renderToString(h(Script, { src: "/w.js", strategy: "worker" }));
    assertStringIncludes(html, `<script src="/b${LIB}boot.js" nonce="`);

    // A snippet of another shape is refused rather than run in atomics mode.
    await Deno.writeTextFile(join(lib, "partytown.js"), "!function(){}();");
    warnings.length = 0;
    assertEquals(await preparePartytown(ON, root, dest), false);
    assertEquals(warnings, [PARTYTOWN_UNSUPPORTED_WARNING]);
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
    await Deno.mkdir(join(dir, "app", "about"));
    await Deno.writeTextFile(
      join(dir, "app", "about", "page.tsx"),
      `import { Script } from "denext";
export default function About() {
  return <main><Script src="/base/probe.js" strategy="worker" /></main>;
}
`,
    );
    await fakePartytown(dir, "@builder.io/partytown");
    const cli = fromFileUrl(new URL("../cli.ts", import.meta.url));
    const out = await boundedOutput(Deno.execPath(), {
      args: ["run", "-A", cli, "export", dir],
      cwd: dir,
    });
    const log = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
    assert(out.success, log);
    const outDir = join(dir, "out");
    const html = await Deno.readTextFile(join(outDir, "index.html"));
    const [nonce] = nonces(html);
    assertStringIncludes(html, `<script src="/base${LIB}boot.js" nonce="${nonce}"></script>`);
    assertStringIncludes(
      html,
      `<script src="/base/probe.js" type="text/partytown" nonce="${nonce}"></script>`,
    );
    // Each page is its own response, with its own nonce.
    const about = await Deno.readTextFile(join(outDir, "about", "index.html"));
    assert(nonces(about).length === 2 && nonces(about)[0] !== nonce, about);
    const boot = await Deno.readTextFile(join(outDir, "_denext", "~partytown", "boot.js"));
    assertStringIncludes(boot, `var LIB = "/base${LIB}";`);
    assertStringIncludes(boot, "(window,!1);");
    await Deno.stat(join(outDir, "_denext", "~partytown", "partytown-sw.js"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an ISR page with a worker script is never stored: each visitor gets their own nonce", async () => {
  const { createApp } = await import("../src/server/app.ts");
  const { parsePattern } = await import("../src/router/segments.ts");
  const { inMemoryCacheStore, PageCache, setCacheStore } = await import("../src/server/cache.ts");
  setCacheStore(inMemoryCacheStore());
  const page = (filePath: string, routePath: string) => ({
    kind: "page" as const,
    pattern: parsePattern(routePath === "/" ? "" : routePath.slice(1)),
    routePath,
    filePath,
    layoutChain: [],
    templateChain: [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
  });
  const modules: Record<string, unknown> = {
    "/app/page.tsx": {
      default: () => h("main", null, h(Script, { src: "/w.js", strategy: "worker" })),
      revalidate: 60,
    },
    "/app/plain/page.tsx": { default: () => h("main", null, "plain"), revalidate: 60 },
  };
  const app = createApp({
    getManifest: () => ({
      pages: [page("/app/page.tsx", "/"), page("/app/plain/page.tsx", "/plain")],
      api: [],
      rootLayout: null,
      rootNotFound: null,
      rootGlobalError: null,
      directives: new Map(),
    }),
    load: (fp) => Promise.resolve(modules[fp]),
    clientEntryFor: () => "/_denext/entry.js",
    appDir: "/app",
    pageCache: new PageCache(),
  });
  await withWorkers({ lib: LIB }, async () => {
    const seen: { nonce: string | undefined; csp: string; cache: string | null }[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await app(new Request("http://localhost/"));
      seen.push({
        nonce: nonces(await res.text())[0],
        csp: res.headers.get("content-security-policy") ?? "",
        cache: res.headers.get("x-denext-cache"),
      });
    }
    assert(seen[0].nonce && seen[1].nonce, JSON.stringify(seen));
    assert(seen[0].nonce !== seen[1].nonce, "the second visitor was replayed the first's nonce");
    assertStringIncludes(seen[1].csp, `'nonce-${seen[1].nonce}'`);
    assert(seen.every((s) => s.cache !== "HIT"), JSON.stringify(seen.map((s) => s.cache)));
    // A page without a worker script lists no nonce, so its cached copy replays none.
    for (let i = 0; i < 2; i++) {
      const res = await app(new Request("http://localhost/plain"));
      await res.body?.cancel();
      assert(!(res.headers.get("content-security-policy") ?? "").includes("'nonce-"));
    }
  });
});
