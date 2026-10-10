// `spa.shell` at build time (src/build/spa/shell.ts + the shell HTML in src/build/spa/shared.ts):
// the export server-renders the shell component into `#root` per target (a platform file beside
// it wins for its target), inlines the bundled boot script before it and the field-capture script
// after it, hashes both into the strict CSP, and makes the client entry install the adopt
// runtime; the dev server serves the same shell (per `?__denext_platform`). Plus the config
// validation and the pure helpers. The browser half: tests/spa-shell-runtime.test.ts and
// tests/e2e/spa-shell.e2e.test.ts.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { copy } from "@std/fs";
import { fromFileUrl, join } from "@std/path";
import { staticExport } from "../src/build/export.ts";
import { generateSpaEntry, spaShellHtml, supportInstall } from "../src/build/spa/shared.ts";
import { escapeInlineScript, spaShellFor, spaShellInstall } from "../src/build/spa/shell.ts";
import { SHELL_CAPTURE_SCRIPT } from "../src/build/spa/shell-capture.ts";
import { sha256Base64 } from "../src/server/csp.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig, SpaConfig } from "../src/server/config.ts";
import { startSpaDevOnDir } from "./e2e/harness.ts";

const FIXTURE = fromFileUrl(new URL("./e2e/fixtures/spa-shell", import.meta.url));
const abs = (rel: string) => new URL(`../${rel}`, import.meta.url).href;

/** A private copy of the e2e fixture (exports and dev servers write into the project). */
async function fixtureCopy(): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_spa_shell_" }));
  await copy(join(FIXTURE, "src"), join(dir, "src"));
  await Deno.copyFile(join(FIXTURE, "denext.config.ts"), join(dir, "denext.config.ts"));
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": abs("mod.ts"),
        "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/jsx-dev-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/server": abs("src/server/mod.ts"),
        "denext/client": abs("src/client/mod.ts"),
      },
    }),
  );
  return dir;
}

/** The inline `<script>` bodies of a page, in order. */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

/** Every inline script of `html` is allowed by the page's CSP meta by its hash. */
async function assertScriptsHashed(html: string): Promise<void> {
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? "";
  const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src ")) ?? "";
  for (const source of inlineScripts(html)) {
    assertStringIncludes(scriptSrc, `'sha256-${await sha256Base64(source)}'`);
  }
}

const SPA: SpaConfig = { entry: "./src/main.tsx" };

Deno.test("spa.shell html: the markup fills a marked mount, between the boot and capture scripts", async () => {
  const html = await spaShellHtml({
    spa: { ...SPA, csp: "strict" },
    scriptSrc: "/_denext/client/index.js",
    styleHref: "/_denext/client/index.css",
    shell: { markup: "<main>shell</main>", bootScript: "document.title='x'" },
  });
  assertStringIncludes(
    html,
    `<script>document.title='x'</script>\n    <div id="root" data-denext-shell=""><main>shell</main></div>` +
      `\n    <script>${SHELL_CAPTURE_SCRIPT}</script>`,
  );
  // The stylesheet is linked in <head>, ahead of the shell: first paint has the app's CSS.
  assert(html.indexOf("index.css") < html.indexOf("data-denext-shell"));
  assertEquals(inlineScripts(html).length, 2);
  await assertScriptsHashed(html);
});

Deno.test("spa.shell html: without a shell the mount holds spa.loading, and no script is hashed", async () => {
  const html = await spaShellHtml({
    spa: { ...SPA, csp: "strict", loading: "<p>loading</p>" },
    scriptSrc: "/_denext/client/index.js",
  });
  assertStringIncludes(html, `<div id="root"><p>loading</p></div>`);
  assert(!html.includes("data-denext-shell"));
  assert(!/script-src[^;]*sha256/.test(html));
});

Deno.test("spa.shell: the platforms filter, the entry install and inline-script escaping", () => {
  const shell = { component: "./src/AppShell.tsx", platforms: ["macos" as const] };
  assertEquals(spaShellFor({ ...SPA, shell }, "macos"), shell);
  assertEquals(spaShellFor({ ...SPA, shell }, "web"), null);
  assertEquals(spaShellFor(SPA, "web"), null);
  assertEquals(spaShellInstall(null), "");
  const install = spaShellInstall({ ...shell, readyOn: "shellReady", maxHoldMs: 250 });
  assertStringIncludes(install, `installShellSupport({"readyOn":"shellReady","maxHoldMs":250})`);
  assertStringIncludes(supportInstall({ shell: install }), "installShellSupport(");
  assert(!supportInstall({}).includes("installShellSupport"));
  // The production entry carries it in the seam module evaluated ahead of the app's entry.
  const entry = generateSpaEntry("file:///app/src/main.tsx", false, null, { shell: install });
  assert(entry.indexOf("installShellSupport") < entry.indexOf("file:///app/src/main.tsx"));
  assertEquals(
    escapeInlineScript(`a("</script>");b("<!--")`),
    `a("<\\/script>");b("<\\!--")`,
  );
});

Deno.test("spa.shell config: validated, and never together with spa.loading", () => {
  const config = (shell: unknown, extra: Partial<SpaConfig> = {}): DenextConfig =>
    ({ mode: "spa", spa: { ...SPA, ...extra, shell } }) as DenextConfig;
  validateDenextConfig(config({
    component: "./src/AppShell.tsx",
    props: { a: 1 },
    bootScript: "./src/boot.ts",
    platforms: ["web", "macos"],
    readyOn: "shellReady",
    maxHoldMs: 0,
  }));
  const bad: Array<[unknown, Partial<SpaConfig>, string]> = [
    [{ component: "./a.tsx" }, { loading: "<p/>" }, "`spa.loading`"],
    ["./a.tsx", {}, "`spa.shell` must be an object"],
    [{}, {}, "`spa.shell.component`"],
    [{ component: "./a.tsx", readyOn: "now" }, {}, "`spa.shell.readyOn`"],
    [{ component: "./a.tsx", platforms: ["tv"] }, {}, "`spa.shell.platforms`"],
    [{ component: "./a.tsx", maxHoldMs: -1 }, {}, "`spa.shell.maxHoldMs`"],
    [{ component: "./a.tsx", props: [] }, {}, "`spa.shell.props`"],
    [{ component: "./a.tsx", bootScript: "" }, {}, "`spa.shell.bootScript`"],
    [{ component: "./a.tsx", ready: "x" }, {}, "`spa.shell.ready`"],
  ];
  for (const [shell, extra, field] of bad) {
    const err = assertThrows(() => validateDenextConfig(config(shell, extra)));
    assertStringIncludes((err as Error).message, field);
  }
});

Deno.test({
  name: "spa.shell export: each target's shell is prerendered with hashed scripts",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const dir = await fixtureCopy();
  try {
    const shells: Record<string, string> = {};
    for (const platform of ["web", "macos", "android"] as const) {
      await staticExport(dir, { platform, outDir: `out-${platform}` });
      const html = await Deno.readTextFile(join(dir, `out-${platform}`, "index.html"));
      await assertScriptsHashed(html);
      const [boot, capture] = inlineScripts(html);
      assertStringIncludes(boot, "localStorage");
      assertEquals(capture, SHELL_CAPTURE_SCRIPT);
      assertStringIncludes(html, 'placeholder="Ask anything"');
      assertStringIncludes(html, 'data-denext-shell-key="composer"');
      const client = await Deno.readTextFile(
        join(dir, `out-${platform}`, "_denext/client/index.js"),
      );
      assertStringIncludes(client, "data-denext-shell", "the entry installs the adopt runtime");
      shells[platform] = /data-marker="([\w-]+)"/.exec(html)?.[1] ?? "";
    }
    // `AppShell.desktop.tsx` is the macOS export's shell; web and Android render AppShell.tsx.
    assertEquals(shells, { web: "shell", macos: "shell-desktop", android: "shell" });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "spa.shell dev: the dev server serves the prerendered shell for the page's target",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const dir = await fixtureCopy();
  const server = await startSpaDevOnDir(dir);
  try {
    const web = await (await fetch(server.origin + "/")).text();
    assertStringIncludes(web, `data-denext-shell=""><main class="layout" data-marker="shell">`);
    await assertScriptsHashed(web);
    const mac = await (await fetch(server.origin + "/?__denext_platform=macos")).text();
    assertStringIncludes(mac, `data-marker="shell-desktop"`);
  } finally {
    await server.close();
    await Deno.remove(dir, { recursive: true });
  }
});
