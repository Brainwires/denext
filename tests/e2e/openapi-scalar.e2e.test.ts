// Headless e2e for `openapi({ ui: "scalar" })`: the docs page runs the VENDORED Scalar bundle
// from the app's own origin and makes no third-party request at all — no CDN script, no Scalar
// web fonts, no telemetry, no hosted proxy — while it renders the document. Every request the
// page makes is observed through CDP's Network domain, and the page's CSP must name no other
// origin, admit no inline script but the start-up script (by hash), and report no violation
// beyond Zod's JIT probe: the bundled Zod tries `Function("")` once inside a try/catch to decide
// whether it may compile validators, and falls back to interpreting them when the CSP says no.
//
// Real browser, so opt-in: `deno task test:e2e`.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { applyPlugins, getPluginRequestHandler, resetPlugins } from "../../src/plugin/mod.ts";
import { scanRoutes } from "../../src/router/manifest.ts";
import type { DenextConfig } from "../../src/server/config.ts";
import { defineApi } from "../../src/server/mod.ts";
import { openapi } from "../../packages/openapi/mod.ts";
import { launchBrowser, pollFor } from "./harness.ts";

/** Records every CSP violation the page reports, before any of its scripts run. */
const VIOLATIONS = `window.__violations = [];
document.addEventListener("securitypolicyviolation", (e) => {
  window.__violations.push(e.violatedDirective + " " + e.blockedURI + " " + e.sourceFile);
});`;

const schema = (validate: (v: unknown) => boolean) => ({
  "~standard": {
    version: 1 as const,
    vendor: "test",
    validate: (v: unknown) => validate(v) ? { value: v } : { issues: [{ message: "bad" }] },
  },
});

Deno.test({
  name: 'e2e: openapi ui: "scalar" renders from the app\'s origin with zero third-party requests',
}, async () => {
  const root = await Deno.makeTempDir({ prefix: "denext_scalar_e2e_" });
  const appDir = join(root, "app");
  await Deno.mkdir(join(appDir, "api", "pets"), { recursive: true });
  await Deno.writeTextFile(join(appDir, "api", "pets", "route.ts"), "");
  const GET = defineApi(
    { query: schema((v) => typeof v === "object"), errors: { not_found: 404 } },
    () => [{ id: "1", name: "Rex" }],
  );
  resetPlugins();
  await applyPlugins({
    projectRoot: root,
    appDir,
    config: {
      plugins: [openapi({ ui: "scalar", info: { title: "Scalar Pets", version: "1.0.0" } })],
    } as DenextConfig,
    mode: "prod",
    load: () => Promise.resolve({ GET }),
  });
  await scanRoutes(appDir);
  const handle = getPluginRequestHandler()!;
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => (await handle(req)) ?? new Response("not found", { status: 404 }),
  );
  const origin = `http://127.0.0.1:${server.addr.port}`;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    // deno-lint-ignore no-explicit-any
    const cdp = page.unsafelyGetCelestialBindings() as any;
    const requested: string[] = [];
    cdp.addEventListener(
      "Network.requestWillBeSent",
      (e: { detail: { request: { url: string } } }) => void requested.push(e.detail.request.url),
    );
    await cdp.Network.enable({});
    await cdp.Page.addScriptToEvaluateOnNewDocument({ source: VIOLATIONS });

    const docs = await fetch(origin + "/docs");
    const csp = docs.headers.get("content-security-policy") ?? "";
    await docs.body?.cancel();
    assert(!/https?:\/\//.test(csp), `the CSP names no other origin: ${csp}`);
    assert(!/\*/.test(csp), csp);
    assert(!/script-src[^;]*'unsafe-inline'/.test(csp), csp);
    assert(!/'unsafe-eval'/.test(csp), csp);

    await page.goto(origin + "/docs", { waitUntil: "load" });
    // Scalar fetched the document and rendered it: the title and the operation's path.
    await pollFor(
      page,
      `document.body.innerText.includes("Scalar Pets") && document.body.innerText.includes("/api/pets")`,
    );
    // Let late, lazy work settle (fonts, deferred chunks, idle callbacks) before judging.
    await new Promise((r) => setTimeout(r, 1500));

    const foreign = requested.filter((url) => {
      if (url.startsWith("data:") || url.startsWith("blob:")) return false;
      return new URL(url).origin !== origin;
    });
    assertEquals(foreign, [], "no request leaves the app's origin");
    assert(
      requested.some((u) => /\/docs\/scalar\/standalone\.[0-9a-f]{16}\.js$/.test(u)),
      `the vendored bundle was loaded: ${requested.join(", ")}`,
    );
    assert(requested.includes(origin + "/openapi.json"), "the document was fetched");
    const violations = (await page.evaluate("window.__violations")) as string[];
    const unexpected = violations.filter((v) =>
      !/^script-src eval https?:\/\/[^/]+\/docs\/scalar\/standalone\.[0-9a-f]{16}\.js$/.test(v)
    );
    assertEquals(unexpected, [], "no CSP violation but the bundle's own eval probe");
    // Scalar's injected stylesheet is in the page.
    assert(
      await page.evaluate(`!!document.getElementById("scalar-style")`),
      "Scalar injected its stylesheet",
    );
    await page.close();
  } finally {
    await browser.close();
    await server.shutdown();
    resetPlugins();
    await Deno.remove(root, { recursive: true });
  }
});
