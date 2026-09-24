// `momentumSafeScroll: false` must hold in a PRODUCTION SPA build, whose entry statically imports
// the app's `main.tsx`: ES imports are hoisted, so an opt-out assigned by an entry statement
// would run after main's top-level `createRoot` had already booted the iOS shim. Builds a tiny
// SPA on both bundler paths (native `deno bundle`, and the compat esbuild path), opted out and
// with the default as a control, runs each bundle in a Deno subprocess posing as iOS WebKit, and
// reports whether `Element.prototype.scrollTop` was patched.

import { assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { bundleSpaInto } from "../src/build/spa/bundle.ts";
import { resolveProject } from "../src/build/paths.ts";

const ROOT = new URL("../", import.meta.url);

/** A main.tsx that poses as iOS WebKit, calls `createRoot` at top level, then reports. */
const MAIN = `
import { createRoot } from "denext/client";
class El {
  get scrollTop() { return 0; }
  set scrollTop(_v) {}
  get scrollLeft() { return 0; }
  set scrollLeft(_v) {}
  scrollBy() {}
  scrollTo() {}
  scroll() {}
}
const original = Object.getOwnPropertyDescriptor(El.prototype, "scrollTop").get;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit" },
});
Object.defineProperty(globalThis, "Element", { configurable: true, value: El });
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: { addEventListener() {}, removeEventListener() {} },
});
createRoot({});
setTimeout(() => {
  const patched = Object.getOwnPropertyDescriptor(El.prototype, "scrollTop").get !== original;
  console.log("installed:" + patched);
}, 200);
`;

/** Point the bundle's absolute `/_denext/client/` chunk URLs at the output dir itself. */
async function localizeChunks(clientDir: string): Promise<void> {
  for await (const entry of Deno.readDir(clientDir)) {
    if (!entry.name.endsWith(".js")) continue;
    const file = join(clientDir, entry.name);
    const text = await Deno.readTextFile(file);
    await Deno.writeTextFile(file, text.replaceAll('"/_denext/client/', '"./'));
  }
}

/**
 * Build the fixture SPA with `momentumSafeScroll` set as given, on the compat path when
 * `compat`; returns the run's report.
 */
async function buildAndRun(
  momentumSafeScroll: boolean | undefined,
  compat: boolean,
): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_momentum_spa_" }));
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(join(dir, "src", "main.tsx"), MAIN);
    const setting = momentumSafeScroll === undefined
      ? ""
      : `momentumSafeScroll: ${momentumSafeScroll},`;
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      `export default { mode: "spa", compatibilityMode: ${compat}, ${setting} ` +
        `spa: { entry: "./src/main.tsx" } };\n`,
    );
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
        imports: {
          "denext": new URL("mod.ts", ROOT).href,
          "denext/jsx-runtime": new URL("src/jsx/jsx-runtime.ts", ROOT).href,
          "denext/client": new URL("src/client/mod.ts", ROOT).href,
          "denext/class-runtime": new URL("src/class-runtime.ts", ROOT).href,
        },
      }),
    );
    const paths = await resolveProject(dir);
    const clientDir = join(dir, "out");
    await Deno.mkdir(clientDir);
    await bundleSpaInto(paths, join(dir, "src", "main.tsx"), clientDir, false);
    await localizeChunks(clientDir);
    const run = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--no-config", "--allow-read", toFileUrl(join(clientDir, "index.js")).href],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(run.stdout).trim();
    return out || new TextDecoder().decode(run.stderr);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

for (const compat of [false, true]) {
  Deno.test({
    name: `SPA build (${compat ? "compat esbuild" : "native"}): momentumSafeScroll: false holds ` +
      "against a top-level createRoot in main.tsx",
    sanitizeOps: false,
    sanitizeResources: false,
  }, async () => {
    assertEquals(await buildAndRun(false, compat), "installed:false");
    // Control: the same app with the default installs, so the probe can see an install.
    assertEquals(await buildAndRun(undefined, compat), "installed:true");
  });
}
