// `desktop.preload` (Electron-preload parity): the bundled module is inlined as the FIRST page
// script — right after the `__denext` global, before any script of the page — of every top-level
// document served over the memory transport, with its own CSP hash. Never into an iframe, a
// non-memory (TCP) response, or a loopback-world page. Plus the bundler (a classic IIFE with
// dynamic imports inlined) and the inline-safety escaping.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createDesktopHandler, injectDesktopGlobal } from "../src/build/desktop.ts";
import { createDesktopBridge } from "../src/desktop/bridge.ts";
import { sha256Base64 } from "../src/server/csp.ts";
import type { DesktopServeInfo, DesktopTrust } from "../src/desktop/transport.ts";
import { inlineSafeScript, readDesktopPreload } from "../src/desktop/preload.ts";
import { bundleDesktopPreload, desktopPreloadBundleArgs } from "../src/build/desktop-preload.ts";

const APP = "t3code://app";
const TOKEN = "preload-token-0123";
const MEMORY: DesktopTrust = { kind: "memory", origin: APP };
const LOOPBACK: DesktopTrust = { kind: "loopback" };
const MEM_INFO: DesktopServeInfo = { remoteAddr: { transport: "memory" } };
const TCP_INFO: DesktopServeInfo = { remoteAddr: { transport: "tcp" } };
const PRELOAD = "window.desktopBridge={ready:true};";
const CSP =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'">`;
const SHELL = `<!doctype html><html><head>${CSP}<script src="/_denext/client/index.js"></script>` +
  `</head><body><script>window.page=1</script></body></html>`;

/** Every inline / src script element in document order. */
function scripts(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[0]);
}

Deno.test("injectDesktopGlobal: the preload is the second script, before every page script", async () => {
  const html = await injectDesktopGlobal(SHELL, TOKEN, false, PRELOAD);
  const list = scripts(html);
  assertStringIncludes(list[0], "globalThis.__denext=");
  assertEquals(list[1], `<script>${PRELOAD}</script>`);
  assertStringIncludes(list[2], 'src="/_denext/client/index.js"');
  assertStringIncludes(list[3], "window.page=1");
});

Deno.test("injectDesktopGlobal: the CSP meta allows both injected scripts by hash", async () => {
  const html = await injectDesktopGlobal(SHELL, TOKEN, false, PRELOAD);
  const preloadHash = `'sha256-${await sha256Base64(PRELOAD)}'`;
  const global = scripts(html)[0].replace(/^<script>|<\/script>$/g, "");
  const globalHash = `'sha256-${await sha256Base64(global)}'`;
  const policy = html.match(/content="([^"]*)"/)![1];
  assertStringIncludes(policy, `script-src 'self' ${globalHash} ${preloadHash}`);
});

Deno.test("injectDesktopGlobal: no token (an iframe / --lan) means no preload", async () => {
  const html = await injectDesktopGlobal(SHELL, null, false, PRELOAD);
  assert(!html.includes(PRELOAD));
  assertEquals(scripts(html).length, 3);
});

/** A one-page export dir. */
async function exportDir(): Promise<string> {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(join(dir, "index.html"), SHELL);
  return dir;
}

function handler(dir: string, trust: DesktopTrust) {
  const bridge = createDesktopBridge([], { trust });
  return createDesktopHandler(
    {},
    dir,
    undefined,
    TOKEN,
    undefined,
    undefined,
    false,
    bridge,
    undefined,
    trust,
    PRELOAD,
  );
}

async function page(
  handle: ReturnType<typeof handler>,
  base: string,
  info: DesktopServeInfo | undefined,
  headers: Record<string, string> = {},
): Promise<string> {
  const request = new Request(`${base}/`, { headers });
  const res = await handle(request, new URL(request.url), info);
  assertEquals(res.status, 200);
  return await res.text();
}

Deno.test("memory world: a top-level document gets the preload; an iframe and TCP do not", async () => {
  const dir = await exportDir();
  try {
    const handle = handler(dir, MEMORY);
    const top = await page(handle, "http+memory://app", MEM_INFO, { "sec-fetch-dest": "document" });
    assertStringIncludes(top, `<script>${PRELOAD}</script>`);
    // Absent Sec-Fetch-Dest is a document too.
    assertStringIncludes(await page(handle, "http+memory://app", MEM_INFO), PRELOAD);
    const frame = await page(handle, "http+memory://app", MEM_INFO, { "sec-fetch-dest": "iframe" });
    assert(!frame.includes(PRELOAD), "an iframe must not get the preload");
    const tcp = await page(handle, "http+memory://app", TCP_INFO);
    assert(!tcp.includes(PRELOAD), "a non-memory response must not get the preload");
    const foreign = await page(handle, "http+memory://app", MEM_INFO, {
      origin: "https://evil.example",
    });
    assert(!foreign.includes(PRELOAD));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loopback world (the stock runtime): never the preload, even with the token", async () => {
  const dir = await exportDir();
  try {
    const html = await page(handler(dir, LOOPBACK), "http://127.0.0.1:8000", undefined);
    assertStringIncludes(html, TOKEN);
    assert(!html.includes(PRELOAD), "the loopback world must not get the preload");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("inlineSafeScript: </script and <!-- cannot end or confuse the element", () => {
  assertEquals(
    inlineSafeScript('a="</script><!--";b="</SCRIPT>"'),
    'a="<\\/script><\\!--";b="<\\/SCRIPT>"',
  );
});

Deno.test("readDesktopPreload: missing → undefined; present → inline-safe text", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await readDesktopPreload(join(dir, "nope.js")), undefined);
    await Deno.writeTextFile(join(dir, "p.js"), 'x("</script>")');
    assertEquals(await readDesktopPreload(join(dir, "p.js")), 'x("<\\/script>")');
    // Any other read failure (here: the path is a directory) is not "no preload": it surfaces.
    await assertRejects(() => readDesktopPreload(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktopPreloadBundleArgs: a browser IIFE with the project's config", () => {
  const args = desktopPreloadBundleArgs({
    projectDir: "/p",
    preload: "./desktop/preload.ts",
    configPath: "file:///p/deno.json",
    outFile: "/p/out/_denext/desktop-preload.js",
    minify: true,
  });
  for (const flag of ["--platform=browser", "--format=iife", "--minify"]) {
    assert(args.includes(flag), flag);
  }
  assertEquals(args.slice(args.indexOf("--config"), args.indexOf("--config") + 2), [
    "--config",
    "/p/deno.json",
  ]);
  assertEquals(args.at(-1), join("/p", "./desktop/preload.ts"));
  // A remote (framework) config is not passed.
  const remote = desktopPreloadBundleArgs({
    projectDir: "/p",
    preload: "p.ts",
    configPath: "https://jsr.io/x/deno.json",
    outFile: "/o.js",
    minify: false,
  });
  assert(!remote.includes("--config") && !remote.includes("--minify"));
});

Deno.test("bundleDesktopPreload: one classic script, dynamic imports inlined, runs in order", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "dep.ts"), "export const name: string = 'bridge';\n");
    await Deno.writeTextFile(
      join(dir, "preload.ts"),
      "import { name } from './dep.ts';\n" +
        "(globalThis as Record<string, unknown>).seen = [name];\n" +
        "import('./dep.ts').then((m) => ((globalThis as { seen: string[] }).seen.push(m.name)));\n",
    );
    const outFile = join(dir, "out", "preload.js");
    await bundleDesktopPreload({ projectDir: dir, preload: "preload.ts", outFile, minify: false });
    const code = await Deno.readTextFile(outFile);
    assert(!/^\s*(import|export)\b/m.test(code), "no module syntax left");
    const g = globalThis as { seen?: string[] };
    delete g.seen;
    // A classic script: evaluating it as a plain function body works.
    new Function(code)();
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(g.seen, ["bridge", "bridge"]);
    delete g.seen;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bundleDesktopPreload: a missing module is a clear error", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let message = "";
    try {
      await bundleDesktopPreload({
        projectDir: dir,
        preload: "missing.ts",
        outFile: join(dir, "o.js"),
        minify: false,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    assertStringIncludes(message, "desktop.preload: no module at");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeDesktopPreload: the export step bundles desktop.preload into the out dir", async () => {
  const { writeDesktopPreload } = await import("../src/build/desktop-preload.ts");
  const { DESKTOP_PRELOAD_FILE } = await import("../src/desktop/preload.ts");
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, "pre.ts"),
      "(globalThis as Record<string, unknown>).p = 1;\n",
    );
    await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
    const out = join(dir, "out");
    const paths = { projectDir: dir, configPath: join(dir, "deno.json") };
    // No desktop.preload → nothing written.
    await writeDesktopPreload({ ...paths, config: {} } as never, out);
    assertEquals(await readDesktopPreload(join(out, DESKTOP_PRELOAD_FILE)), undefined);
    await writeDesktopPreload(
      { ...paths, config: { desktop: { preload: "pre.ts" } } } as never,
      out,
    );
    assertStringIncludes((await readDesktopPreload(join(out, DESKTOP_PRELOAD_FILE)))!, "p");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
