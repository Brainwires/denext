// Guards the "converted pnpm/yarn app builds from a local denext checkout" path.
//
// A migrated app keeps its own package manager: its deno.json sets
// `nodeModulesDir: "manual"` and it installs its npm deps itself. When denext runs from
// a LOCAL checkout (a contributor, or `denext migrate --denext-local-path=…`), the build
// re-execs under that manual mode — which resolves EVERY npm specifier from the
// node_modules beside the merged config, the framework's OWN build deps (esbuild, …)
// included. The app's tree carries only the app's deps, so without a framework-deps
// node_modules the re-exec dies with:
//   Could not find a matching package for 'npm:esbuild@^0.24.0' in the node_modules directory
// The fix (ensureFrameworkNodeModules) materializes just the framework's npm deps beside
// the merged config; the app's own deps still resolve via the app's own config.
//
// Two shapes, one per re-exec path: with CSS (the css re-exec) and without (the module
// re-exec). Each asserts the app's OWN npm dep resolved at SSR (a distinctive marker in
// the exported HTML) — proving BOTH halves resolve, not just that the build didn't crash.
//
// Opt-in + NETWORK on a cold cache (the framework-deps `deno install` pulls esbuild/sass/…
// the first time). Local (file://) framework, so this is a source-checkout regression test.

import { assert } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

const REPO = fromFileUrl(new URL("../../", import.meta.url));
const DENO = Deno.execPath();
const BUILD_TIMEOUT_MS = 240_000;

/** A fake npm package (local-only, never on the registry) so resolution is real. */
async function writeFakePkg(app: string): Promise<void> {
  const dir = join(app, "node_modules", "leftpad");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "leftpad", version: "1.0.0", main: "index.js" }),
  );
  await Deno.writeTextFile(join(dir, "index.js"), "module.exports=function(s){return '  '+s};\n");
}

async function exportApp(app: string): Promise<{ ok: boolean; out: string }> {
  const cmd = new Deno.Command(DENO, {
    args: ["run", "-A", `--config=${REPO}deno.json`, `${REPO}cli.ts`, "export", app],
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(BUILD_TIMEOUT_MS),
  });
  const { success, stdout, stderr } = await cmd.output();
  return {
    ok: success,
    out: new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr),
  };
}

Deno.test({
  name: "e2e: manual-node_modules app builds — CSS re-exec path (esbuild + app dep resolve)",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const app = await Deno.makeTempDir({ prefix: "denext_nmd_css_" });
  try {
    await writeFakePkg(app);
    await Deno.writeTextFile(
      join(app, "deno.json"),
      JSON.stringify({
        nodeModulesDir: "manual",
        imports: { leftpad: "npm:leftpad@1.0.0" },
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      }),
    );
    await Deno.mkdir(join(app, "app"));
    // A CSS import forces the css re-exec; the server component USES the app dep so an
    // unresolved `leftpad` would fail SSR rather than silently drop out.
    await Deno.writeTextFile(join(app, "app", "styles.css"), ".t{color:rebeccapurple}\n");
    await Deno.writeTextFile(
      join(app, "app", "page.tsx"),
      `import "./styles.css";\nimport leftpad from "leftpad";\n` +
        `export default function Page(){return <h1 className="t">[{leftpad("CSSMARK")}]</h1>;}\n`,
    );

    const { ok, out } = await exportApp(app);
    assert(ok, `manual-node_modules css build failed:\n${out}`);
    assert(
      !out.includes("Could not find a matching package for 'npm:esbuild"),
      `framework esbuild dep did not resolve under manual mode:\n${out}`,
    );
    const html = await Deno.readTextFile(join(app, "out", "index.html"));
    assert(
      html.includes("[  CSSMARK]"),
      `app npm dep did not resolve at SSR:\n${html.slice(0, 400)}`,
    );
  } finally {
    await Deno.remove(app, { recursive: true }).catch(() => {});
  }
});

Deno.test({
  name: "e2e: manual-node_modules app builds — module re-exec path (no CSS)",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const app = await Deno.makeTempDir({ prefix: "denext_nmd_mod_" });
  try {
    await writeFakePkg(app);
    await Deno.writeTextFile(
      join(app, "deno.json"),
      JSON.stringify({
        nodeModulesDir: "manual",
        imports: { leftpad: "npm:leftpad@1.0.0" },
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      }),
    );
    await Deno.mkdir(join(app, "app"));
    // No CSS → the module re-exec path (writeMergedModuleConfig).
    await Deno.writeTextFile(
      join(app, "app", "page.tsx"),
      `import leftpad from "leftpad";\n` +
        `export default function Page(){return <h1>[{leftpad("MODMARK")}]</h1>;}\n`,
    );

    const { ok, out } = await exportApp(app);
    assert(ok, `manual-node_modules module build failed:\n${out}`);
    assert(
      !out.includes("Could not find a matching package for 'npm:esbuild"),
      `framework esbuild dep did not resolve under manual mode:\n${out}`,
    );
    const html = await Deno.readTextFile(join(app, "out", "index.html"));
    assert(
      html.includes("[  MODMARK]"),
      `app npm dep did not resolve at SSR:\n${html.slice(0, 400)}`,
    );
  } finally {
    await Deno.remove(app, { recursive: true }).catch(() => {});
  }
});
