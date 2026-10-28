// Real-browser e2e for examples/lustre: one Lustre counter (Gleam) used three ways on one page,
// under denext's strict default CSP — what only a real browser, a real Lustre build and a real
// Live socket can prove.
//   • island            — lustreIsland: Lustre adopts the server's markup (the parser's own
//                          nodes survive hydration and Lustre's start), then runs it.
//   • custom element    — lustreElement: the Declarative Shadow DOM the server prerendered is
//                          the shadow root Lustre adopts; attributes drive the component.
//   • server component  — defineLustreView: the server-rendered first paint is adopted when the
//                          view mounts (the parser's nodes kept, and an input focused and typed
//                          into before the mount keeps its focus and text, which reach the
//                          server); clicks and typing go over the Live socket as Lustre events and
//                          come back as patches, and a reload of the socket resumes the same runtime.
//   • a stopped island  — the ticker's timer effect keeps firing after its island unmounts, but
//                          none of its dispatches reaches the stopped app (denext's post-build
//                          fix for Lustre's SPA `shutdown`).
// It runs three ways: the example as it is (Lustre 5.7.1 from Hex), the same app under
// `compatibilityMode: true` (the Next drop-in path), and the app on Lustre's `main` at a pinned
// commit (the runtime fixes match code patterns, not one version's bytes).
// The build compiles gleam/ with denext's pinned Gleam (downloaded on first use) and fetches
// Lustre from Hex, so this needs the network the first time. It drives the CLI as a subprocess
// ON PURPOSE: the app's `@gleam/` import-map entry resolves only under the CLI's merged
// framework + app config, not in this test process.
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs/copy";
import { fromFileUrl, join } from "@std/path";
import {
  collectConsoleErrors,
  launchBrowser,
  pollFor,
  runDeno,
  startCliServer,
} from "./harness.ts";

const REPO = fromFileUrl(new URL("../../", import.meta.url)).replace(/\/$/, "");
const EXAMPLE = join(REPO, "examples", "lustre");
const CLI = join(REPO, "cli.ts");
const BUILD_TIMEOUT_MS = 300_000;
const READY_TIMEOUT_MS = 180_000; // generous: a loaded machine loads the app slowly

/** Lustre's `main`, pinned: the commit the "Lustre main" variant builds against. */
const LUSTRE_MAIN_COMMIT = "f5ac432bb2d625951be4f8731fe446aa03320061";

/**
 * A copy of the example in a temp dir (its sources, not its build output), with `deno.json`'s
 * repo-relative paths made absolute, then `edit`ed.
 */
async function exampleCopy(edit: (dir: string) => Promise<void>): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-lustre-e2e-" }));
  for (const entry of ["app", "public", "denext.config.ts", "gleam/src", "gleam/gleam.toml"]) {
    await copy(join(EXAMPLE, entry), join(dir, entry));
  }
  const denoJson = await Deno.readTextFile(join(EXAMPLE, "deno.json"));
  await Deno.writeTextFile(join(dir, "deno.json"), denoJson.replaceAll('"../../', `"${REPO}/`));
  await edit(dir);
  return dir;
}

/** Build `dir` with the CLI, serve it, and run every check in a headless browser. */
async function checkLustreApp(t: Deno.TestContext, dir: string): Promise<void> {
  const built = await runDeno(["run", "-A", CLI, "build", "."], dir, BUILD_TIMEOUT_MS);
  assert(built.ok, "denext build failed:\n" + built.out);
  // Every Lustre runtime file had a shape the post-build fixes know.
  assert(!built.out.includes("is not a shape denext knows"), built.out);
  const server = await startCliServer(dir, READY_TIMEOUT_MS);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = collectConsoleErrors(page);
    // Record the parser's own nodes ("interactive" fires before module scripts run) and any CSP
    // violation, before the page's scripts.
    await page.unsafelyGetCelestialBindings().Page.addScriptToEvaluateOnNewDocument({
      source: `
        window.__csp = [];
        window.__mounts = [];
        // A capture listener sees each root's (non-bubbling) mount event: Lustre runs it now.
        document.addEventListener("lustre:mount", (e) =>
          window.__mounts.push(e.target.className || e.target.getAttribute("data-dnx-lustre-view")),
          true);
        document.addEventListener("securitypolicyviolation", (e) =>
          window.__csp.push(e.violatedDirective + " " + (e.blockedURI || "inline")));
        document.addEventListener("readystatechange", () => {
          if (document.readyState !== "interactive") return;
          const host = document.querySelector("lustre-counter");
          const view = document.querySelector("[data-dnx-lustre-view]");
          const viewNote = view && view.querySelector(".note");
          window.__parsed = {
            islandSpan: document.querySelector(".island .count"),
            shadow: host && host.shadowRoot,
            shadowSpan: host && host.shadowRoot && host.shadowRoot.querySelector(".count"),
            viewSpan: view && view.querySelector(".count"),
            viewNote,
          };
          // A visitor who focuses the server view's field and types before the view mounts.
          if (viewNote) {
            viewNote.focus();
            viewNote.value = "early";
            viewNote.setSelectionRange(2, 2);
          }
        });
      `,
    });
    await page.goto(server.origin + "/", { waitUntil: "load" });
    const view = "document.querySelector('[data-dnx-lustre-view]')";
    const shadow = "document.querySelector('lustre-counter').shadowRoot";

    await t.step("island: Lustre adopts the server's markup and runs it", async () => {
      // client:visible: the island hydrates once on screen; Lustre then owns its root.
      await pollFor(page, "window.__mounts.includes('island')");
      await page.evaluate("document.querySelector('.island .inc').click()");
      await pollFor(page, "document.querySelector('.island .count').textContent === '4'");
      assert(
        await page.evaluate(
          "window.__parsed.islandSpan === document.querySelector('.island .count')",
        ),
        "the span Lustre updates is the one the HTML parser built",
      );
      await page.evaluate(`(() => {
        const i = document.querySelector('.island .note');
        i.value = 'typed';
        i.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await pollFor(page, "document.querySelector('.island .echo').textContent === 'typed'");
    });

    await t.step("custom element: the declarative shadow root is the one Lustre runs", async () => {
      assert(await page.evaluate("!!window.__parsed.shadow"), "DSD attached by the parser");
      await pollFor(page, "!!customElements.get('lustre-counter')");
      assert(
        await page.evaluate(`window.__parsed.shadowSpan === ${shadow}.querySelector('.count')`),
        "Lustre adopted the prerendered shadow root",
      );
      await page.evaluate(`${shadow}.querySelector('.inc').click()`);
      await pollFor(page, `${shadow}.querySelector('.count').textContent === '6'`);
      await page.evaluate("document.querySelector('lustre-counter').setAttribute('start', '20')");
      await pollFor(page, `${shadow}.querySelector('.count').textContent === '20'`);
    });

    await t.step("server component: events over Live, patches back", async () => {
      // The server's `mount` message: Lustre's reconciler now owns the view's root.
      await pollFor(page, "window.__mounts.includes('counter')");
      assertEquals(await page.evaluate(`${view}.querySelector('.count').textContent`), "7");
      // The first paint was adopted, not replaced: the parser's nodes, focus, caret and text.
      assert(
        await page.evaluate(`window.__parsed.viewSpan === ${view}.querySelector('.count')`),
        "the span Lustre patches is the one the HTML parser built",
      );
      assert(
        await page.evaluate(`window.__parsed.viewNote === ${view}.querySelector('.note')`),
        "the field is the one the HTML parser built",
      );
      assert(
        await page.evaluate("document.activeElement === window.__parsed.viewNote"),
        "the field keeps its focus",
      );
      assertEquals(
        await page.evaluate(
          "[window.__parsed.viewNote.value, window.__parsed.viewNote.selectionStart]",
        ),
        ["early", 2],
      );
      // What was typed before the mount reached the server's model.
      await pollFor(page, `${view}.querySelector('.echo').textContent === 'early'`);
      await page.evaluate(`${view}.querySelector('.inc').click()`);
      await pollFor(page, `${view}.querySelector('.count').textContent === '8'`);
      await page.evaluate(`(() => {
        const i = ${view}.querySelector('.note');
        i.value = 'over the socket';
        i.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await pollFor(page, `${view}.querySelector('.echo').textContent === 'over the socket'`);
    });

    await t.step("a stopped island: its timer's dispatches reach nothing", async () => {
      const ticks = "document.querySelector('.ticker-island .ticks')";
      await pollFor(page, `!!${ticks} && Number(${ticks}.textContent) >= 2`);
      // Keep the span Lustre renders into: once the island unmounts it is detached, and an
      // update the timer still drove would render into it.
      await page.evaluate(`window.__tickSpan = ${ticks}`);
      await page.evaluate("document.querySelector('.toggle-ticker').click()");
      await pollFor(page, "!document.querySelector('.ticker-island')");
      const stoppedAt = await page.evaluate("window.__tickSpan.textContent");
      // The timer fires every 200 ms: five more intervals, none reaching update or view.
      await new Promise((r) => setTimeout(r, 1000));
      assertEquals(await page.evaluate("window.__tickSpan.textContent"), stoppedAt);
      // Shown again, the island starts a fresh app.
      await page.evaluate("document.querySelector('.toggle-ticker').click()");
      await pollFor(page, `!!${ticks} && Number(${ticks}.textContent) >= 1`);
    });

    await t.step("no CSP violation and no console error", async () => {
      assertEquals(await page.evaluate("window.__csp"), []);
      assertEquals(errors, []);
    });
  } finally {
    await browser.close();
    await server.close();
  }
}

Deno.test({
  name: "e2e: examples/lustre runs a Lustre island, custom element and server component",
  sanitizeOps: false,
  sanitizeResources: false,
}, (t) => checkLustreApp(t, EXAMPLE));

Deno.test({
  name: "e2e: examples/lustre under compatibilityMode: true (the Next drop-in path)",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const dir = await exampleCopy(async (dir) => {
    const config = join(dir, "denext.config.ts");
    const text = await Deno.readTextFile(config);
    const compat = text.replace(
      "plugins: [gleam()],",
      "plugins: [gleam()],\n  compatibilityMode: true,",
    );
    assertStringIncludes(compat, "compatibilityMode: true");
    await Deno.writeTextFile(config, compat);
  });
  try {
    await checkLustreApp(t, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: `e2e: examples/lustre on Lustre's main (${LUSTRE_MAIN_COMMIT.slice(0, 8)})`,
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const dir = await exampleCopy(async (dir) => {
    const toml = join(dir, "gleam", "gleam.toml");
    const text = await Deno.readTextFile(toml);
    const pinned = text.replace(
      /^lustre = .*$/m,
      `lustre = { git = "https://github.com/lustre-labs/lustre.git", ref = "${LUSTRE_MAIN_COMMIT}" }`,
    );
    assertStringIncludes(pinned, LUSTRE_MAIN_COMMIT);
    await Deno.writeTextFile(toml, pinned);
  });
  try {
    await checkLustreApp(t, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
