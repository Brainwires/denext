// Real-browser proof that `<Script strategy="worker">` runs OFF the main thread through
// Partytown, as Next's `experimental.nextScriptWorkers` does (`nextScriptWorkers` here), under
// denext's strict default CSP: the app installs `@builder.io/partytown` (the package Next checks
// for) into its node_modules, the build publishes it under `/_denext/~partytown/`, and the probe
// script — rendered as `type="text/partytown"` — runs in Partytown's web worker, where it still
// reads `document.title` and writes the page's DOM through the proxy.
//
// And that ONLY denext's own worker scripts run there: a `text/partytown` script an HTML
// injection adds — with no nonce, a guessed one, or one copied from another response — never
// does, nor does an injected boot tag or sandbox iframe on a page that renders none.
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run; headless). Needs the
// network once, to install the npm package.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { Browser } from "@astral/astral";
import { buildAndServe, cacheNpm, launchBrowser, pollFor, startDevOnDir } from "./harness.ts";

const ROOT = new URL("../../", import.meta.url);
const at = (rel: string) => new URL(rel, ROOT).href;

/**
 * The probe: what it sees, recorded on `#out` through Partytown's DOM proxy. Partytown runs a
 * script inside `with (windowProxy)` (a bare `self` is the proxied page `window`) and deletes
 * `WorkerGlobalScope` / `importScripts` from its worker, so `self instanceof WorkerGlobalScope`
 * cannot be asked directly. A function made by the worker realm's own `Function` constructor
 * has no `with` scope: its `globalThis` is the real global, whose brand says where it runs.
 */
const PROBE = `
var realGlobal = (function () {}).constructor("return Object.prototype.toString.call(globalThis)");
var out = document.getElementById("out");
out.setAttribute("data-realm", realGlobal());
out.setAttribute("data-stack", String(new Error("probe").stack));
out.setAttribute("data-title", document.title);
window.probeGlobal = 1;
var chained = document.createElement("script"); // a worker script loading another, as tag managers do
chained.src = "/chain.js";
document.body.appendChild(chained);
`;

/** What an injected script would do if it ran anywhere: mark `#evil` (through the proxy too). */
const EVIL = (id: string) => `document.getElementById("evil").setAttribute("data-${id}", "ran");`;

/**
 * Markup an HTML injection writes into a page (rendered through `dangerouslySetInnerHTML`, the
 * way a stored or reflected injection reaches it): worker scripts with no nonce, a guessed one,
 * and \`copy\` — a nonce read from another response — all ahead of the page's own worker script,
 * so Partytown (which runs them in document order) would have run them before it.
 */
const INJECTED = `\`<div id="evil"></div>
<script type="text/partytown">${EVIL("bare")}</script>
<script type="text/partytown" nonce="00000000000000000000000000000000">${EVIL("guessed")}</script>
<script type="text/partytown" nonce="\${copy}">${EVIL("copied")}</script>
<script type="text/partytown" nonce="\${copy}" src="/evil.js"></script>\``;

/** Write the app: a worker-strategy probe on `/`, the flag on, Partytown in node_modules. */
async function writeApp(dir: string): Promise<void> {
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      nodeModulesDir: "auto",
      compilerOptions: {
        jsx: "react-jsx",
        jsxImportSource: "denext",
        lib: ["deno.window", "dom", "dom.iterable", "dom.asynciterable"],
      },
      imports: {
        "denext": at("mod.ts"),
        "denext/jsx-runtime": at("src/jsx/jsx-runtime.ts"),
        "denext/jsx-dev-runtime": at("src/jsx/jsx-runtime.ts"),
        "denext/server": at("src/server/mod.ts"),
        "denext/client": at("src/client/mod.ts"),
      },
    }),
  );
  await Deno.writeTextFile(
    join(dir, "package.json"),
    JSON.stringify({ dependencies: { "@builder.io/partytown": "0.10.3" } }),
  );
  await Deno.writeTextFile(
    join(dir, "denext.config.ts"),
    "export default { nextScriptWorkers: true };\n",
  );
  await Deno.mkdir(join(dir, "app"));
  await Deno.mkdir(join(dir, "public"));
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
import { Later } from "./later.tsx";
export const metadata = { title: "Partytown probe" };
export default function Page() {
  return (
    <main>
      <div id="out">waiting</div>
      <div id="out2">waiting</div>
      <div id="chain"></div>
      <Later />
      <Script id="probe" src="/probe.js" strategy="worker" />
    </main>
  );
}
`,
  );
  await Deno.writeTextFile(join(dir, "public", "probe.js"), PROBE);
  await Deno.writeTextFile(
    join(dir, "public", "chain.js"),
    PROBE.split("\n").slice(0, 3).join("\n") +
      '\ndocument.getElementById("chain").setAttribute("data-realm", realGlobal());\n',
  );
  await Deno.writeTextFile(join(dir, "public", "evil.js"), EVIL("src"));
  // A page with its own worker script and an injection ahead of it.
  await Deno.mkdir(join(dir, "app", "inject"));
  await Deno.writeTextFile(
    join(dir, "app", "inject", "page.tsx"),
    `import { Script } from "denext";
export const metadata = { title: "Partytown probe" };
export default async function Inject({ searchParams }: { searchParams: Promise<{ copy?: string }> }) {
  const copy = (await searchParams).copy ?? "";
  return (
    <main>
      <div id="out">waiting</div>
      <div id="chain"></div>
      <div dangerouslySetInnerHTML={{ __html: ${INJECTED} }} />
      <Script id="probe" src="/probe.js" strategy="worker" />
    </main>
  );
}
`,
  );
  // A page with NO worker script of its own: the injection brings a boot tag (with the copied
  // nonce) and a sandbox iframe too.
  await Deno.mkdir(join(dir, "app", "rogue"));
  await Deno.writeTextFile(
    join(dir, "app", "rogue", "page.tsx"),
    `export default async function Rogue({ searchParams }: { searchParams: Promise<{ copy?: string }> }) {
  const copy = (await searchParams).copy ?? "";
  const html = \`<script src="/_denext/~partytown/boot.js" nonce="\${copy}"></script>\` + ${INJECTED} +
    \`<iframe id="rogue-sandbox" src="/_denext/~partytown/partytown-sandbox-sw.html?1"></iframe>\`;
  return <main><div dangerouslySetInnerHTML={{ __html: html }} /></main>;
}
`,
  );
  // A worker script a client render adds after load (handed over by the boot's `ptupdate`).
  await Deno.writeTextFile(
    join(dir, "app", "later.tsx"),
    `"use client";
import { Script, useState } from "denext";
export function Later() {
  const [on, setOn] = useState(false);
  return (
    <div>
      <button type="button" id="later-btn" onClick={() => setOn(true)}>load</button>
      {on ? <Script id="later" src="/later.js" strategy="worker" /> : null}
    </div>
  );
}
`,
  );
  await Deno.writeTextFile(
    join(dir, "public", "later.js"),
    PROBE.replaceAll('getElementById("out")', 'getElementById("out2")'),
  );
}

/** Open `/` and assert the probe ran in Partytown's worker and read the page through it. */
async function assertProbeRanInWorker(
  browser: Browser,
  origin: string,
  clientRender: boolean,
  path = "/",
): Promise<void> {
  const page = await browser.newPage(origin + path);
  const errors: string[] = [];
  page.addEventListener("console", (e) => {
    // deno-lint-ignore no-explicit-any
    const d = (e as any).detail;
    if (d?.type === "error") errors.push(String(d.text));
  });
  try {
    await pollFor(page, `document.getElementById("out").hasAttribute("data-title")`);
    const result = JSON.parse(String(
      await page.evaluate(`JSON.stringify((() => {
        const out = document.getElementById("out");
        const frame = document.querySelector('iframe[src*="partytown-sandbox-sw"]');
        return {
          realm: out.getAttribute("data-realm"),
          stack: out.getAttribute("data-stack"),
          title: out.getAttribute("data-title"),
          mainGlobal: typeof window.probeGlobal,
          sandboxControlled: !!frame?.contentWindow?.navigator.serviceWorker.controller,
        };
      })())`),
    ));
    // In Partytown's web worker, not on the main thread:
    assertEquals(result.realm, "[object DedicatedWorkerGlobalScope]", JSON.stringify(result));
    assertStringIncludes(result.stack, "blob:" + origin); // the worker's own frames
    assertEquals(result.mainGlobal, "undefined", "the script never ran on the main thread");
    // …and the page is still reachable synchronously through the proxy:
    assertEquals(result.title, "Partytown probe");
    // Through the service-worker transport (no cross-origin isolation needed).
    assert(result.sandboxControlled, "the sandbox iframe is controlled by partytown-sw.js");
    // A script the worker script loads (as a tag manager does) runs in the worker too.
    await pollFor(
      page,
      `document.getElementById("chain").getAttribute("data-realm") === "[object DedicatedWorkerGlobalScope]"`,
    );
    if (path !== "/") {
      // The injected scripts sat ahead of the page's own in document order, so Partytown would
      // have run them first: none ran, and each was left inert.
      const evil = JSON.parse(String(
        await page.evaluate(`JSON.stringify({
          ran: [...document.getElementById("evil").attributes].map((a) => a.name).filter((n) => n !== "id"),
          types: [...document.querySelectorAll("#evil ~ script, div > script")].map((s) => s.type),
        })`),
      ));
      assertEquals(evil.ran, [], "an injected script ran");
      assertEquals(evil.types, Array(4).fill("text/denext-partytown-blocked"), evil.types.join());
      return;
    }
    if (!clientRender) return assertEquals(errors, []);
    // A worker <Script> a client component renders after load runs in the worker too.
    // (A click before hydration is a no-op, so keep clicking until the script has run.)
    await pollFor(
      page,
      `(document.getElementById("later-btn").click(),
        document.getElementById("out2").getAttribute("data-realm") ===
          "[object DedicatedWorkerGlobalScope]")`,
    );
    assertEquals(
      await page.evaluate(`document.getElementById("out2").getAttribute("data-title")`),
      "Partytown probe",
    );
    assertEquals(errors, []);
  } finally {
    await page.close();
  }
}

/** On a page with no worker script of its own, nothing an injection brings runs anywhere. */
async function assertRogueRefused(browser: Browser, origin: string, copy: string): Promise<void> {
  const page = await browser.newPage(`${origin}/rogue?copy=${copy}`);
  try {
    // The injected sandbox iframe gets no sandbox: the service worker (registered by the
    // earlier visits) refuses a tab no boot announced.
    await pollFor(
      page,
      `(() => { const f = document.getElementById("rogue-sandbox"); const d = f && f.contentDocument;
        return !!d && d.readyState === "complete" && d.location.href.includes("sandbox"); })()`,
    );
    const state = JSON.parse(String(
      await page.evaluate(`JSON.stringify({
        controlled: !!navigator.serviceWorker && !!document.getElementById("rogue-sandbox").contentWindow.navigator.serviceWorker.controller,
        sandboxScripts: document.getElementById("rogue-sandbox").contentDocument.querySelectorAll("script").length,
        boot: window.__denextScriptWorkers && window.__denextScriptWorkers.nonce,
        ran: [...document.getElementById("evil").attributes].map((a) => a.name).filter((n) => n !== "id"),
        types: [...document.querySelectorAll("div > script")].map((s) => s.type),
      })`),
    ));
    assert(state.controlled, "the iframe's request reached the service worker");
    assertEquals(state.sandboxScripts, 0, "the service worker served it a sandbox");
    // The injected boot tag ran with the copied nonce, which this response's CSP does not list.
    assertEquals(state.boot, "");
    assertEquals(state.ran, []);
    assert(state.types.every((t: string) => t !== "text/partytown"), state.types.join());
  } finally {
    await page.close();
  }
}

Deno.test({
  name: 'e2e: <Script strategy="worker"> runs in Partytown\'s web worker under the strict CSP',
}, async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "denext-script-worker-" });
  const browser = await launchBrowser();
  try {
    await writeApp(dir);
    const installed = await cacheNpm(dir, ["npm:@builder.io/partytown@0.10.3"]);
    assert(installed.success, new TextDecoder().decode(installed.stderr));
    await Deno.stat(join(dir, "node_modules", "@builder.io", "partytown", "lib", "partytown.js"));

    const server = await buildAndServe(dir);
    try {
      const res = await fetch(server.origin + "/");
      const csp = res.headers.get("content-security-policy") ?? "";
      const html = await res.text();
      const nonce = html.match(/boot\.js" nonce="([0-9a-f]{32})"/)?.[1] ?? "";

      await t.step("the page carries the boot script and a text/partytown script", () => {
        assertStringIncludes(html, `<script src="/_denext/~partytown/boot.js" nonce="${nonce}">`);
        assertStringIncludes(html, `type="text/partytown" nonce="${nonce}"`);
        // The strict default plus this response's nonce: no inline or eval'd script, no
        // worker-src opt-in.
        assertStringIncludes(csp, `script-src 'self' 'nonce-${nonce}';`);
        assert(!/script-src[^;]*'unsafe-/.test(csp), csp);
        assert(!csp.includes("worker-src"), csp);
      });

      await t.step("only what Partytown needs is served, from the app's origin", async () => {
        for (const f of ["boot.js", "partytown-sw.js", "partytown-sw-impl.js"]) {
          const asset = await fetch(`${server.origin}/_denext/~partytown/${f}`);
          assertEquals(asset.status, 200, f);
          assertStringIncludes(asset.headers.get("content-type") ?? "", "javascript");
          await asset.body?.cancel();
        }
        for (const f of ["partytown.js", "partytown-atomics.js", "debug/partytown-sw.js"]) {
          const asset = await fetch(`${server.origin}/_denext/~partytown/${f}`);
          assertEquals(asset.status, 404, f);
          await asset.body?.cancel();
        }
      });

      await t.step(
        "denext start: the probe ran in the worker, reading the page through it",
        () => assertProbeRanInWorker(browser, server.origin, true),
      );

      await t.step(
        "an injected text/partytown script never runs: no nonce, a guessed one, or a copied one",
        () => assertProbeRanInWorker(browser, server.origin, false, `/inject?copy=${nonce}`),
      );

      await t.step(
        "a page without worker scripts: an injected boot tag and sandbox iframe run nothing",
        () => assertRogueRefused(browser, server.origin, nonce),
      );
    } finally {
      await server.close();
    }

    const dev = await startDevOnDir(dir);
    try {
      await t.step(
        "denext dev: the same, published from node_modules at startup",
        () => assertProbeRanInWorker(browser, dev.origin, true),
      );
    } finally {
      await dev.close();
    }
  } finally {
    await browser.close();
    await Deno.remove(dir, { recursive: true });
  }
});
