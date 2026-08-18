// Guard: denext's runtime must depend only on Deno built-ins, JSR (@std, @denext/*,
// @astral), and node: built-ins — never an npm package. This is the CI teeth behind
// the "zero runtime npm dependencies" claim. It scans the whole runtime (jsx,
// runtime, client, server, compat) — not just the compat layer — and resolves each
// import specifier against deno.json's import map, so an npm dependency hidden
// behind an alias (e.g. "@cf-wasm/photon" → "npm:…") is caught, not only a literal
// `npm:` specifier.
//
// Out of scope: `src/build` (build-time tooling — esbuild/swc/lightningcss — never
// ships in the runtime). The image/og/sqlite codecs are denext's own first-party JSR
// packages (`@denext/photon`, `@denext/avif`, `@denext/og`, `@denext/sqlite`), lazily
// imported at call time — they resolve to JSR, not npm, so the guard allows them.
// `node:*` built-ins are Deno built-ins and allowed.

import { assert } from "@std/assert";
import { walk } from "@std/fs";

const RUNTIME_DIRS = ["jsx", "runtime", "client", "server", "compat"] as const;

const denoJson = JSON.parse(
  await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
) as { imports?: Record<string, string> };
const importMap = denoJson.imports ?? {};

/** True when a specifier resolves (directly or via a deno.json alias) to `npm:`. */
function resolvesToNpm(spec: string): boolean {
  if (spec.startsWith("npm:")) return true;
  const exact = importMap[spec];
  if (exact) return exact.startsWith("npm:");
  // Prefix aliases (e.g. "@scope/pkg/sub" via a "@scope/pkg/" entry).
  for (const [alias, target] of Object.entries(importMap)) {
    if (alias.endsWith("/") && spec.startsWith(alias)) return target.startsWith("npm:");
  }
  return false;
}

// Matches `... from "X"` and `import("X")` / `await import("X")` with a *literal*
// specifier. Runtime-value specifiers (`import(spec)`) are intentionally invisible.
const SPEC_RE = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g;

Deno.test("no npm dependencies in the denext runtime", async () => {
  const offenders: string[] = [];
  for (const dir of RUNTIME_DIRS) {
    const root = new URL(`../src/${dir}/`, import.meta.url);
    for await (const entry of walk(root, { exts: [".ts"] })) {
      const text = await Deno.readTextFile(entry.path);
      for (const m of text.matchAll(SPEC_RE)) {
        const spec = m[1];
        if (resolvesToNpm(spec)) offenders.push(`${entry.path}: ${spec}`);
      }
    }
  }
  assert(
    offenders.length === 0,
    `runtime modules must not depend on npm — found:\n${offenders.join("\n")}`,
  );
});
