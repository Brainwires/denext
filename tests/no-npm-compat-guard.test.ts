// Guard: denext's runtime must depend only on Deno built-ins, JSR (@std, @denext/*,
// @astral), and node: built-ins — never an npm package. This is the CI teeth behind
// the "zero runtime npm dependencies" claim. It scans the whole runtime (jsx,
// runtime, client, server, compat) — not just the compat layer — and resolves each
// import specifier against deno.json's import map, so an npm dependency hidden
// behind an alias (e.g. "@cf-wasm/photon" → "npm:…") is caught, not only a literal
// `npm:` specifier.
//
// It ALSO scans each first-party workspace package under `packages/*` — the shipped
// `@denext/photon`/`@denext/avif`/`@denext/og`/`@denext/sqlite`/`@denext/pages-router`
// codecs and plugins — resolving each against THAT package's own deno.json import
// map, so a package can't reintroduce an npm dependency the root guard wouldn't see.
//
// Out of scope: `src/build` (build-time tooling — esbuild/swc/lightningcss — never
// ships in the runtime). The image/og/sqlite codecs are denext's own first-party JSR
// packages, lazily imported at call time — they resolve to JSR, not npm, so allowed.
// `node:*` built-ins are Deno built-ins and allowed.
//
// EXCEPTION — `@denext/effect`: this package is, by design, a bridge TO an npm library
// (Effect is distributed on npm and deliberately not published to JSR), so it depends
// on `npm:effect` on purpose. It is opt-in — a consumer pulls npm:effect only if they
// choose to use `@denext/effect` — and forms no part of the zero-npm core runtime or the
// first-party codec/plugin packages this guard protects. It is therefore excluded from
// the packages scan (the same opt-in-npm principle as the ORM compat surface).

import { assert } from "@std/assert";
import { walk } from "@std/fs";

const RUNTIME_DIRS = ["jsx", "runtime", "client", "server", "compat", "plugin"] as const;

// Workspace members that are intentional npm bridges (see the header note): excluded
// from the "shipped packages must be zero-npm" scan because depending on npm is their
// entire purpose. Keep this list tiny and deliberate.
const NPM_BRIDGE_PACKAGES = new Set(["effect"]);

/** Load a deno.json's import map (empty when the file is missing or has none). */
async function loadImportMap(url: URL): Promise<Record<string, string>> {
  try {
    const json = JSON.parse(await Deno.readTextFile(url)) as {
      imports?: Record<string, string>;
    };
    return json.imports ?? {};
  } catch {
    return {};
  }
}

/** True when a specifier resolves (directly or via `importMap` alias) to `npm:`. */
function resolvesToNpm(spec: string, importMap: Record<string, string>): boolean {
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

/** Scan every `.ts` under `root` for imports that resolve to npm via `importMap`. */
async function scanForNpm(root: URL, importMap: Record<string, string>): Promise<string[]> {
  const offenders: string[] = [];
  for await (const entry of walk(root, { exts: [".ts"] })) {
    const text = await Deno.readTextFile(entry.path);
    for (const m of text.matchAll(SPEC_RE)) {
      if (resolvesToNpm(m[1], importMap)) offenders.push(`${entry.path}: ${m[1]}`);
    }
  }
  return offenders;
}

Deno.test("no npm dependencies in the denext runtime", async () => {
  const importMap = await loadImportMap(new URL("../deno.json", import.meta.url));
  const offenders: string[] = [];
  for (const dir of RUNTIME_DIRS) {
    offenders.push(...await scanForNpm(new URL(`../src/${dir}/`, import.meta.url), importMap));
  }
  assert(
    offenders.length === 0,
    `runtime modules must not depend on npm — found:\n${offenders.join("\n")}`,
  );
});

Deno.test("no npm dependencies in the shipped packages/* workspace members", async () => {
  const packagesRoot = new URL("../packages/", import.meta.url);
  const offenders: string[] = [];
  let scanned = 0;
  for await (const member of Deno.readDir(packagesRoot)) {
    if (!member.isDirectory) continue;
    if (NPM_BRIDGE_PACKAGES.has(member.name)) continue; // intentional npm bridge
    const pkgRoot = new URL(`${member.name}/`, packagesRoot);
    // Each member resolves imports against its OWN deno.json, not the root's.
    const importMap = await loadImportMap(new URL("deno.json", pkgRoot));
    offenders.push(...await scanForNpm(pkgRoot, importMap));
    scanned++;
  }
  assert(scanned > 0, "expected at least one packages/* member to scan");
  assert(
    offenders.length === 0,
    `shipped packages must not depend on npm — found:\n${offenders.join("\n")}`,
  );
});
