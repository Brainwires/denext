// Coverage for the next-compat build pipeline (`src/build/next-compat.ts`):
//   1. A real, in-process build of `examples/next-compat` — a plain-React page
//      importing the `@radix-ui/react-collapsible` npm package — which drives the
//      whole compat bundle path (react-family aliasing, package `exports`
//      resolution, prebuilt runtime, esbuild plugins). Browser-free: it builds and
//      asserts on the emitted output; it does not serve.
//   2. Unit tests of the pure resolver/helpers: `resolveReactFamilyFile`,
//      `splitPackageSpecifier`, `resolveExportsField`, `checkEnvPoison`,
//      `toImportUrl`, and the MDX compiler wiring (`compileMdxSource`).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { build } from "../src/build/build.ts";
import {
  BROWSER_CONDITIONS,
  checkEnvPoison,
  compileMdxSource,
  resolveExportsField,
  resolveReactFamilyFile,
  splitPackageSpecifier,
  stopNextCompat,
  toImportUrl,
} from "../src/build/next-compat.ts";

const NEXT_COMPAT = new URL("../examples/next-compat", import.meta.url).pathname;

// ── Full compat build (in-process; exercises the bundle pipeline) ──────────────

Deno.test({
  name: "next-compat build: bundles a real-npm React page through the compat pipeline",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    try {
      const result = await build(NEXT_COMPAT);
      // The build produced its output dir (the static page ships 0 KB JS, so it has
      // no client route bundle — but the whole compat bundle pipeline still ran).
      assertStringIncludes(result.outDir, ".denext");
      assert(Array.isArray(result.routes), "build returns a routes array");
      // The manifest is written into the output dir and lists the `/` route.
      const manifest = JSON.parse(
        await Deno.readTextFile(`${result.outDir}/manifest.json`),
      );
      assert(manifest, "a manifest.json was emitted");
      assertStringIncludes(JSON.stringify(manifest), "/");
    } finally {
      // Release esbuild's service so the test process can exit cleanly.
      await stopNextCompat();
    }
  },
});

// ── resolveReactFamilyFile ─────────────────────────────────────────────────────

Deno.test("resolveReactFamilyFile: every mapped react-family specifier resolves directly", () => {
  assertEquals(resolveReactFamilyFile("react-dom/server"), { file: "react-dom-server.js" });
  assertEquals(resolveReactFamilyFile("react-dom/server.edge"), { file: "react-dom-server.js" });
  assertEquals(resolveReactFamilyFile("react-is"), { file: "react-is.js" });
  assertEquals(resolveReactFamilyFile("react/jsx-dev-runtime"), { file: "jsx-runtime.js" });
  // No warning on a mapped specifier.
  assert(resolveReactFamilyFile("react").warning === undefined);
});

Deno.test("resolveReactFamilyFile: an unmapped react subpath fails safe + warns", () => {
  const r = resolveReactFamilyFile("react/some-internal");
  assertEquals(r.file, "react.js");
  assert(r.warning && r.warning.includes("never real React"));
});

// ── splitPackageSpecifier ──────────────────────────────────────────────────────

Deno.test("splitPackageSpecifier: splits bare, subpath, scoped, and deep specifiers", () => {
  assertEquals(splitPackageSpecifier("react"), ["react", ""]);
  assertEquals(splitPackageSpecifier("react-dom/client"), ["react-dom", "/client"]);
  assertEquals(splitPackageSpecifier("@radix-ui/react-collapsible"), [
    "@radix-ui/react-collapsible",
    "",
  ]);
  assertEquals(splitPackageSpecifier("@scope/pkg/sub/deep"), ["@scope/pkg", "/sub/deep"]);
});

// ── resolveExportsField ────────────────────────────────────────────────────────

Deno.test("resolveExportsField: a string exports resolves only the root subpath", () => {
  assertEquals(resolveExportsField("./index.js", ""), "./index.js");
  assertEquals(resolveExportsField("./index.js", "/sub"), null);
});

Deno.test("resolveExportsField: a bare conditions map resolves the root by priority", () => {
  const exp = { browser: "./b.js", import: "./i.js", default: "./d.js" };
  // BROWSER_CONDITIONS puts `browser` first.
  assertEquals(resolveExportsField(exp, "", BROWSER_CONDITIONS), "./b.js");
  // A subpath into a bare (non-subpath) conditions map does not resolve.
  assertEquals(resolveExportsField(exp, "/x", BROWSER_CONDITIONS), null);
  // Custom conditions can prefer the node build.
  assertEquals(resolveExportsField(exp, "", ["import", "default"]), "./i.js");
});

Deno.test("resolveExportsField: a subpath map resolves `.` and explicit subpaths", () => {
  const exp = {
    ".": { import: "./esm/index.js", default: "./cjs/index.js" },
    "./feature": "./feature.js",
  };
  assertEquals(resolveExportsField(exp, "", BROWSER_CONDITIONS), "./esm/index.js");
  assertEquals(resolveExportsField(exp, "/feature", BROWSER_CONDITIONS), "./feature.js");
  assertEquals(resolveExportsField(exp, "/missing", BROWSER_CONDITIONS), null);
});

Deno.test("resolveExportsField: a `./*` wildcard substitutes the matched segment", () => {
  const exp = { "./*": "./dist/*.js" };
  assertEquals(resolveExportsField(exp, "/utils", BROWSER_CONDITIONS), "./dist/utils.js");
  assertEquals(
    resolveExportsField(exp, "/nested/thing", BROWSER_CONDITIONS),
    "./dist/nested/thing.js",
  );
});

Deno.test("resolveExportsField: nested conditions recurse; null/non-object returns null", () => {
  const exp = { ".": { browser: { import: "./browser-esm.js" } } };
  assertEquals(resolveExportsField(exp, "", BROWSER_CONDITIONS), "./browser-esm.js");
  assertEquals(resolveExportsField(null, ""), null);
  assertEquals(resolveExportsField(42, ""), null);
});

// ── checkEnvPoison ─────────────────────────────────────────────────────────────

Deno.test("checkEnvPoison: only the wrong-side import is an error", () => {
  // server-only wrong on the client; fine on the server.
  assert(checkEnvPoison("server-only", false, "a.ts")?.includes("CLIENT bundle"));
  assertEquals(checkEnvPoison("server-only", true), null);
  // client-only wrong on the server; fine on the client.
  assert(checkEnvPoison("client-only", true)?.includes("SERVER bundle"));
  assertEquals(checkEnvPoison("client-only", false), null);
  // A normal specifier is never poisoned.
  assertEquals(checkEnvPoison("react", true), null);
  assertEquals(checkEnvPoison("react", false), null);
});

// ── toImportUrl ────────────────────────────────────────────────────────────────

Deno.test("toImportUrl: produces an absolute file:// URL", () => {
  const url = toImportUrl("examples/hello/app/page.tsx");
  assert(url.startsWith("file://"), `expected a file URL, got ${url}`);
  assertStringIncludes(url, "examples/hello/app/page.tsx");
});

// ── compileMdxSource ───────────────────────────────────────────────────────────

Deno.test("compileMdxSource: compiles Markdown to a React-runtime JS module", async () => {
  const out = await compileMdxSource("doc.mdx", "# Title\n\nSome **bold** text.\n");
  // Automatic runtime, jsxImportSource react (aliased to denext downstream).
  assertStringIncludes(out, "react/jsx-runtime");
  assertStringIncludes(out, "MDXContent");
});

Deno.test("compileMdxSource: providerImportSource wires useMDXComponents", async () => {
  const out = await compileMdxSource(
    "doc.mdx",
    "Hello.\n",
    { providerImportSource: "@mdx-js/react" },
  );
  assertStringIncludes(out, "@mdx-js/react");
  assertStringIncludes(out, "useMDXComponents");
});
