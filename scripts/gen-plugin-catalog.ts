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
//
// A plugin row also carries `optionsSchema`: the JSON Schema of its factory's options
// interface (named by `denext.catalog.optionsType`), derived from `deno doc --json` of the
// package's root module through the same mapper as `denext.config.schema.json`
// (`scripts/lib/ts-to-schema.ts`). The generator fails when a plugin names no options type,
// when that interface is not exported, or when `configKeys` lists a key the interface does
// not declare — so the UI's per-plugin form can never drift from the factory's real type.

import { denoDocJson } from "./deno-doc.ts";
import { description, interfaceSchema, type Schema, symbolTable } from "./lib/ts-to-schema.ts";
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
  /** The factory's options interface, exported from the root module. Plugins only. */
  optionsType?: string;
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
  /** The factory's options interface name (plugins only). */
  optionsType?: string;
  /** The JSON Schema of {@link optionsType}, for a per-plugin options form (plugins only). */
  optionsSchema?: Schema;
}

/** The generated document. */
export interface PluginCatalog {
  generatedBy: string;
  plugins: CatalogEntry[];
}

/**
 * One workspace package as the pure {@link buildCatalog} step sees it: everything read from
 * disk (and `deno doc`) up front, so the catalog's rules can be exercised on fakes.
 */
export interface PackageSource {
  /** The workspace-relative directory (`packages/openapi`). */
  dir: string;
  /** The parsed `deno.json`. */
  config: Record<string, unknown>;
  /** The README text (empty when there is none). */
  readme: string;
  /** Whether the docs site has a page named after the directory. */
  hasDocsPage: boolean;
  /** `deno doc --json` of the root export — read for plugins, whose options it describes. */
  doc?: unknown;
}

/**
 * How many interfaces deep an options schema expands (the options interface itself is the
 * first); a deeper reference is `{}`, which keeps catalog.json small whatever graph an
 * option's type reaches.
 */
const OPTIONS_DEPTH = 4;

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
  if (block.kind === "library" && (block.factory || block.verb || block.optionsType)) {
    throw new Error(`${dir}/deno.json: a library declares neither factory, verb nor optionsType`);
  }
  return block;
}

/**
 * The JSON Schema of a plugin's options interface, checked against its declared
 * `configKeys`. Throws when the block names no `optionsType`, when the root module exports
 * no such interface, or when a `configKeys` entry is not one of the interface's properties.
 */
function optionsSchemaFor(dir: string, block: CatalogBlock, doc: unknown): Schema {
  const type = block.optionsType;
  if (!type) {
    throw new Error(
      `${dir}/deno.json: a plugin must declare denext.catalog.optionsType (the interface its ` +
        `factory takes as options) so the catalog can carry its options schema`,
    );
  }
  const table = symbolTable(doc ?? {});
  const decl = table.get(type);
  if (decl?.kind !== "interface") {
    throw new Error(`${dir}: denext.catalog.optionsType \`${type}\` is not an exported interface`);
  }
  const schema = interfaceSchema(type, { table, stack: [], maxDepth: OPTIONS_DEPTH });
  const declared = Object.keys(schema.properties as Record<string, Schema>);
  const drift = (block.configKeys ?? []).filter((key) => !declared.includes(key));
  if (drift.length) {
    throw new Error(
      `${dir}/deno.json: denext.catalog.configKeys lists ${drift.join(", ")}, which ` +
        `\`${type}\` does not declare`,
    );
  }
  const summary = description(decl.jsDoc?.doc);
  return summary ? { description: summary, ...schema } : schema;
}

function entryFor(pkg: PackageSource): CatalogEntry {
  const { dir, config: cfg } = pkg;
  const name = String(cfg.name ?? "");
  const version = String(cfg.version ?? "");
  const block = catalogBlock(dir, cfg);
  const slug = dir.split("/").pop()!;
  const { title, blurb } = readmeSummary(pkg.readme);
  const options = block.kind === "plugin"
    ? { optionsType: block.optionsType, optionsSchema: optionsSchemaFor(dir, block, pkg.doc) }
    : {};
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
    ...(pkg.hasDocsPage ? { docs: `/docs/${slug}` } : {}),
    ...options,
  };
}

/**
 * The catalog JSON text for already-read packages — the pure half of the generator.
 *
 * @param packages Every workspace package, read by the caller.
 * @returns The exact text of `src/plugin/catalog.json`.
 * @throws When a package's `denext.catalog` block is missing or malformed, a plugin names no
 *   (or an unexported) `optionsType`, or its `configKeys` drift from that interface.
 */
export function buildCatalog(packages: readonly PackageSource[]): string {
  const plugins = packages.map(entryFor).sort((a, b) => a.name.localeCompare(b.name));
  const catalog: PluginCatalog = { generatedBy: "scripts/gen-plugin-catalog.ts", plugins };
  return JSON.stringify(catalog, null, 2) + "\n";
}

/** The root-export module of a package (`exports["."]`, or the string form). */
function rootModule(dir: string, exports: unknown): string {
  const root = typeof exports === "string" ? exports : (exports as Record<string, string>)["."];
  return `${ROOT}${dir}/${String(root).replace(/^\.\//, "")}`;
}

/** Read one workspace package from disk; a plugin's root module is `deno doc`ed too. */
async function readPackage(dir: string): Promise<PackageSource> {
  const config = readJson(`${ROOT}${dir}/deno.json`);
  const kind = (config.denext as { catalog?: CatalogBlock } | undefined)?.catalog?.kind;
  const readmePath = `${ROOT}${dir}/README.md`;
  return {
    dir,
    config,
    readme: exists(readmePath) ? Deno.readTextFileSync(readmePath) : "",
    hasDocsPage: exists(`${DOCS_DIR}/${dir.split("/").pop()}`),
    doc: kind === "plugin" ? await denoDocJson(rootModule(dir, config.exports)) : undefined,
  };
}

/** The catalog as the exact JSON text that belongs in `src/plugin/catalog.json`. */
export async function generatePluginCatalog(): Promise<string> {
  return buildCatalog(await Promise.all(workspaceDirs().map(readPackage)));
}

if (import.meta.main) {
  const json = await generatePluginCatalog();
  await Deno.writeTextFile(CATALOG_OUT, json);
  const { plugins } = JSON.parse(json) as PluginCatalog;
  const n = plugins.filter((p) => p.kind === "plugin").length;
  console.log(
    `plugin catalog: ${plugins.length} packages (${n} plugins) → ${CATALOG_OUT}`,
  );
}
