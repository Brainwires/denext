// Real-browser e2e for examples/lustre: one Lustre counter (Gleam) used three ways on one page,
// under denext's strict default CSP — what only a real browser, a real Lustre build and a real
// Live socket can prove.
//   • island            — lustreIsland: Lustre adopts the server's markup (the parser's own
//                          nodes survive hydration and Lustre's start), then runs it.
//   • custom element    — lustreElement: the Declarative Shadow DOM the server prerendered is
//                          the shadow root Lustre adopts; attributes drive the component.
//   • server component  — defineLustreView: the model lives on the server; clicks and typing go
//                          over the Live socket as Lustre events and come back as patches, and a
//                          reload of the socket resumes the same runtime.
// The build compiles gleam/ with denext's pinned Gleam (downloaded on first use) and fetches
// Lustre from Hex, so this needs the network the first time. It drives the CLI as a subprocess
// ON PURPOSE: the app's `@gleam/` import-map entry resolves only under the CLI's merged
// framework + app config, not in this test process.
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  collectConsoleErrors,
  launchBrowser,
  pollFor,
  runDeno,
  startCliServer,
} from "./harness.ts";

const EXAMPLE = fromFileUrl(new URL("../../examples/lustre", import.meta.url));
const CLI = fromFileUrl(new URL("../../cli.ts", import.meta.url));
const BUILD_TIMEOUT_MS = 300_000;
const READY_TIMEOUT_MS = 60_000;

Deno.test({
  name: "e2e: examples/lustre runs a Lustre island, custom element and server component",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const built = await runDeno(["run", "-A", CLI, "build", "."], EXAMPLE, BUILD_TIMEOUT_MS);
  assert(built.ok, "denext build failed:\n" + built.out);
  const server = await startCliServer(EXAMPLE, READY_TIMEOUT_MS);
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
          window.__parsed = {
            islandSpan: document.querySelector(".island .count"),
            shadow: host && host.shadowRoot,
            shadowSpan: host && host.shadowRoot && host.shadowRoot.querySelector(".count"),
          };
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
      await page.evaluate(`${view}.querySelector('.inc').click()`);
      await pollFor(page, `${view}.querySelector('.count').textContent === '8'`);
      await page.evaluate(`(() => {
        const i = ${view}.querySelector('.note');
        i.value = 'over the socket';
        i.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await pollFor(page, `${view}.querySelector('.echo').textContent === 'over the socket'`);
    });

    await t.step("no CSP violation and no console error", async () => {
      assertEquals(await page.evaluate("window.__csp"), []);
      assertEquals(errors, []);
    });
  } finally {
    await browser.close();
    await server.close();
  }
});
