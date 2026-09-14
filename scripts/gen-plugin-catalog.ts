// Generate the machine-readable first-party package catalog (`src/plugin/catalog.json`)
// from the workspace packages themselves: each `packages/*/deno.json` (name, version,
// exports, and an explicit `denext.catalog` block) plus its README (H1 + first paragraph,
// via the shared `scripts/readme-blurb.ts` extractor).
//
//   deno task gen:plugin-catalog   # regenerate catalog.json
//   deno task docs:build           # regenerate + export the site
//
// The catalog is the single source of truth for "which first-party plugins exist, what
// they are called, and which range pins them": `src/build/migrate.ts` reads its `spec`
// values instead of hard-coding pins, and the `denext ui` plugin panel lists it.
// Everything a file can't state about itself (is this a plugin or a plain library? what is
// its factory export called? does it add a CLI verb?) is declared in the package's own
// `deno.json` under `denext.catalog` — never guessed here — and the generator fails when a
// workspace member is missing that block.

import { readmeSummary } from "./readme-blurb.ts";

const ROOT = new URL("../", import.meta.url).pathname;
/** Where the generated catalog is committed (it ships inside the published package). */
export const CATALOG_OUT = `${ROOT}src/plugin/catalog.json`;
const DOCS_DIR = `${ROOT}apps/web/app/docs`;

/** What a first-party package is: a `plugins: []` entry, or a plain library you import. */
export type CatalogKind = "plugin" | "library";

/** The `denext.catalog` block a workspace package declares in its own `deno.json`. */
export interface CatalogBlock {
  kind: CatalogKind;
  /** The factory export placed in `plugins: []` (e.g. `pagesRouter`). Plugins only. */
  factory?: string;
  /** The CLI verb the plugin contributes through `addCommand` (e.g. `openapi`). */
  verb?: string;
  /** The top-level option keys of the factory's options object, for the config UI. */
  configKeys?: string[];
}

/** One catalogued first-party package. */
export interface CatalogEntry {
  /** The JSR package name (`@denext/openapi`). */
  name: string;
  /** The workspace package's current version. */
  version: string;
  /** The `deno add` / import-map specifier pinning it (`jsr:@denext/openapi@^0.3.0`). */
  spec: string;
  /** The package's export keys (`["."]`, `[".", "./command"]`, …). */
  exports: string[];
  kind: CatalogKind;
  factory?: string;
  verb?: string;
  configKeys?: string[];
  /** The README H1, as plain text. */
  title: string;
  /** The README's first paragraph, plain text, ≤200 chars. */
  blurb: string;
  /** The docs-site path documenting it, when the site has a page for it. */
  docs?: string;
}

/** The generated document. */
export interface PluginCatalog {
  generatedBy: string;
  plugins: CatalogEntry[];
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(Deno.readTextFileSync(path)) as Record<string, unknown>;
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The workspace members' directory names, sorted — the exact set the root `deno.json`
 * declares, so a package added to the workspace is catalogued (or fails) automatically.
 */
export function workspaceDirs(): string[] {
  const members = (readJson(`${ROOT}deno.json`).workspace ?? []) as string[];
  return members.map((m) => m.replace(/^\.\//, "")).sort();
}

/** `{ "." : "./mod.ts" }` or `"./mod.ts"` → the export keys, sorted. */
function exportKeys(exports: unknown): string[] {
  if (typeof exports === "string") return ["."];
  if (exports && typeof exports === "object") return Object.keys(exports).sort();
  return [];
}

/**
 * The range that pins a package: always caret + its full current version, so a 0.x
 * package (where `^0.4.0` admits only `0.4.*`) is pinned to the line it is published on.
 */
export function specFor(name: string, version: string): string {
  return `jsr:${name}@^${version}`;
}

/** The declared block, or a throw naming the package that has to declare one. */
function catalogBlock(dir: string, cfg: Record<string, unknown>): CatalogBlock {
  const block = (cfg.denext as { catalog?: CatalogBlock } | undefined)?.catalog;
  if (!block) {
    throw new Error(
      `${dir}/deno.json has no "denext": { "catalog": … } block — every workspace package ` +
        `must declare its kind (and, for a plugin, its factory export) for the catalog`,
    );
  }
  if (block.kind !== "plugin" && block.kind !== "library") {
    throw new Error(`${dir}/deno.json: denext.catalog.kind must be "plugin" or "library"`);
  }
  if (block.kind === "plugin" && !block.factory) {
    throw new Error(`${dir}/deno.json: a plugin must declare denext.catalog.factory`);
  }
  if (block.kind === "library" && (block.factory || block.verb)) {
    throw new Error(`${dir}/deno.json: a library declares neither factory nor verb`);
  }
  return block;
}

function entryFor(dir: string): CatalogEntry {
  const cfg = readJson(`${ROOT}${dir}/deno.json`);
  const name = String(cfg.name ?? "");
  const version = String(cfg.version ?? "");
  const block = catalogBlock(dir, cfg);
  const slug = dir.split("/").pop()!;
  const { title, blurb } = readmeSummary(
    exists(`${ROOT}${dir}/README.md`) ? Deno.readTextFileSync(`${ROOT}${dir}/README.md`) : "",
  );
  return {
    name,
    version,
    spec: specFor(name, version),
    exports: exportKeys(cfg.exports),
    kind: block.kind,
    ...(block.factory ? { factory: block.factory } : {}),
    ...(block.verb ? { verb: block.verb } : {}),
    ...(block.configKeys?.length ? { configKeys: [...block.configKeys] } : {}),
    title: title || name,
    blurb,
    ...(exists(`${DOCS_DIR}/${slug}`) ? { docs: `/docs/${slug}` } : {}),
  };
}

/** The catalog as the exact JSON text that belongs in `src/plugin/catalog.json`. */
export function generatePluginCatalog(): string {
  const plugins = workspaceDirs().map(entryFor).sort((a, b) => a.name.localeCompare(b.name));
  const catalog: PluginCatalog = { generatedBy: "scripts/gen-plugin-catalog.ts", plugins };
  return JSON.stringify(catalog, null, 2) + "\n";
}

if (import.meta.main) {
  const json = generatePluginCatalog();
  await Deno.writeTextFile(CATALOG_OUT, json);
  const { plugins } = JSON.parse(json) as PluginCatalog;
  const n = plugins.filter((p) => p.kind === "plugin").length;
  console.log(
    `plugin catalog: ${plugins.length} packages (${n} plugins) → ${CATALOG_OUT}`,
  );
}
