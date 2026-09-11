/**
 * `@denext/content-collections/build` (internal) — discover `content.config.ts`, run each
 * collection's loader, validate every entry against its schema, and write the built store
 * (`.denext/content-data.json`) plus the generated types (`.denext/content.ts`). Runs from the
 * plugin's prepare step at `denext dev` startup + on content change, and at `denext build`.
 *
 * @module
 */

import { dirname, join, toFileUrl } from "@std/path";
import { compileMdxSource } from "@denext/denext/plugin-kit";
import type { ContentConfig, StandardIssue } from "./config.ts";
import { generateContentTypes } from "./codegen.ts";

/** Where a content build reads/writes. */
export interface ContentBuildContext {
  /** Absolute project root (holds `content.config.ts`). */
  readonly projectRoot: string;
  /** Absolute `.denext` output dir (the store + generated types are written here). */
  readonly outDir: string;
}

/** A per-file validation failure. */
export interface ContentDiagnostic {
  /** The collection the entry belongs to. */
  readonly collection: string;
  /** The entry id. */
  readonly id: string;
  /** The source file, when the entry came from one. */
  readonly filePath?: string;
  /** One message per schema issue (`field: message`). */
  readonly messages: string[];
}

/** The outcome of a content build. */
export interface ContentBuildReport {
  /** Entry count per collection (only valid entries). */
  readonly counts: Record<string, number>;
  /** Validation failures (invalid entries are dropped from the store). */
  readonly diagnostics: ContentDiagnostic[];
  /** True when nothing failed validation. */
  readonly ok: boolean;
  /** False when the app has no `content.config.ts` (the build is a no-op). */
  readonly configured: boolean;
}

const CONFIG_FILES = [
  "content.config.ts",
  "content.config.mts",
  "content.config.js",
  "content.config.mjs",
];

/** Find + import the app's `content.config.ts`. Returns null when the app has none. */
export async function discoverContentConfig(
  projectRoot: string,
): Promise<{ config: ContentConfig; configPath: string } | null> {
  for (const name of CONFIG_FILES) {
    const path = join(projectRoot, name);
    try {
      await Deno.stat(path);
    } catch {
      continue;
    }
    const mod = await import(toFileUrl(path).href) as { default?: ContentConfig };
    const config = mod.default;
    if (!config || typeof config !== "object" || !("collections" in config)) {
      throw new Error(
        `content: ${name} must \`export default defineContentConfig({ collections })\``,
      );
    }
    return { config, configPath: path };
  }
  return null;
}

/** Render one Standard Schema issue path as a dotted field string. */
function issuePath(issue: StandardIssue): string {
  if (!issue.path?.length) return "(root)";
  return issue.path
    .map((p) => (typeof p === "object" && p !== null ? String(p.key) : String(p)))
    .join(".");
}

/**
 * A built entry as stored in `content-data.json`. `format` says how `renderContent` renders the
 * body: `"md"` through the first-party Markdown renderer at request time, `"mdx"` through the
 * component module precompiled to `.denext/content/<collection>/<id>.js` (whose `v` — a hash of
 * the source — cache-busts the module import when the entry changes in dev).
 */
type StoreEntry = { id: string; data: unknown; body?: string; format?: "md" | "mdx"; v?: string };

/** The entry's render format from its source extension (absent for data / other text). */
function formatOf(filePath: string | undefined): "md" | "mdx" | undefined {
  if (!filePath) return undefined;
  if (/\.mdx$/i.test(filePath)) return "mdx";
  if (/\.md$/i.test(filePath)) return "md";
  return undefined;
}

/** A short stable hash of a string (djb2, base36) — the MDX module's cache-busting version. */
function hashOf(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Precompile one `.mdx` entry to a component module under `outDir/content/<collection>/`. The
 * compile runs at build (and at `denext dev` startup / on change) through denext's build-time
 * `@mdx-js/mdx` — nothing MDX-related ships to the runtime, which only imports the emitted
 * module. A compile failure is a per-entry diagnostic (the entry is dropped), never fatal.
 */
async function compileMdxEntry(
  collection: string,
  entry: { id: string; body: string; filePath?: string },
  ctx: ContentBuildContext,
): Promise<{ v: string } | { diagnostic: ContentDiagnostic }> {
  try {
    const js = await compileMdxSource(entry.filePath ?? `${entry.id}.mdx`, entry.body, {
      jsxImportSource: "denext",
    });
    const target = join(ctx.outDir, "content", collection, `${entry.id}.js`);
    await Deno.mkdir(dirname(target), { recursive: true });
    await Deno.writeTextFile(target, js);
    return { v: hashOf(entry.body) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = /Cannot find module|not a dependency|@mdx-js/.test(message)
      ? " (MDX compiles with the build-time `npm:@mdx-js/mdx` — add it to your import map)"
      : "";
    return {
      diagnostic: {
        collection,
        id: entry.id,
        filePath: entry.filePath,
        messages: [`mdx compile failed: ${message}${hint}`],
      },
    };
  }
}

/** A collection's schema validator, if any (the Standard Schema surface `buildContent` uses). */
type CollectionSchema = { readonly "~standard": { validate: (v: unknown) => unknown } };

/** Validate one raw entry against the collection schema → a store entry, or a diagnostic. */
async function validateEntry(
  collection: string,
  entry: { id: string; data: unknown; body?: string; filePath?: string; error?: string },
  schema: CollectionSchema | undefined,
): Promise<{ entry: StoreEntry } | { diagnostic: ContentDiagnostic }> {
  const { id, filePath } = entry;
  // The loader flagged this file as unparseable (bad YAML/JSON) — drop it, report it.
  if (entry.error) return { diagnostic: { collection, id, filePath, messages: [entry.error] } };
  let data: unknown = entry.data;
  if (schema) {
    const result = await schema["~standard"].validate(entry.data) as
      | { issues?: readonly StandardIssue[] }
      | { value: unknown };
    if ("issues" in result && result.issues) {
      return {
        diagnostic: {
          collection,
          id,
          filePath,
          messages: result.issues.map((i) => `${issuePath(i)}: ${i.message}`),
        },
      };
    }
    data = (result as { value: unknown }).value;
  }
  const format = formatOf(filePath);
  return {
    entry: {
      id,
      data,
      ...(entry.body !== undefined ? { body: entry.body } : {}),
      ...(format ? { format } : {}),
    },
  };
}

/** Load + validate one collection into its (sorted) store entries plus any diagnostics. */
async function buildCollection(
  name: string,
  collection: ContentConfig["collections"][string],
  ctx: ContentBuildContext,
): Promise<{ entries: StoreEntry[]; diagnostics: ContentDiagnostic[] }> {
  const diagnostics: ContentDiagnostic[] = [];
  let raw;
  try {
    raw = await collection.loader.load({ projectRoot: ctx.projectRoot });
  } catch (err) {
    // A loader that throws wholesale (not per-file) must not abort every OTHER collection's
    // build — report it and continue with an empty collection.
    diagnostics.push({
      collection: name,
      id: "",
      messages: [`loader failed: ${err instanceof Error ? err.message : String(err)}`],
    });
    return { entries: [], diagnostics };
  }
  // Compiled MDX modules are regenerated from scratch so a removed entry leaves no stale module.
  await Deno.remove(join(ctx.outDir, "content", name), { recursive: true }).catch(() => {});
  const entries: StoreEntry[] = [];
  for (const entry of raw) {
    const result = await validateEntry(
      name,
      entry,
      collection.schema as CollectionSchema | undefined,
    );
    if ("diagnostic" in result) {
      diagnostics.push(result.diagnostic);
      continue;
    }
    const built = result.entry;
    if (built.format === "mdx" && built.body !== undefined) {
      const compiled = await compileMdxEntry(
        name,
        { id: built.id, body: built.body, filePath: entry.filePath },
        ctx,
      );
      if ("diagnostic" in compiled) {
        diagnostics.push(compiled.diagnostic);
        continue;
      }
      built.v = compiled.v;
    }
    entries.push(built);
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return { entries, diagnostics };
}

/**
 * Run the content build: validate every entry, write `content-data.json` + `content.ts`. Invalid
 * entries are dropped and reported in `diagnostics` (never throws for bad content — the `denext
 * content validate` CLI turns diagnostics into a CI failure). Returns `configured: false` when the
 * app defines no `content.config.ts`.
 */
export async function buildContent(ctx: ContentBuildContext): Promise<ContentBuildReport> {
  const found = await discoverContentConfig(ctx.projectRoot);
  if (!found) return { counts: {}, diagnostics: [], ok: true, configured: false };
  const { config, configPath } = found;

  const store: Record<string, StoreEntry[]> = {};
  const diagnostics: ContentDiagnostic[] = [];
  const counts: Record<string, number> = {};

  for (const [name, collection] of Object.entries(config.collections)) {
    const built = await buildCollection(name, collection, ctx);
    store[name] = built.entries;
    counts[name] = built.entries.length;
    diagnostics.push(...built.diagnostics);
  }

  await Deno.mkdir(ctx.outDir, { recursive: true }).catch(() => {});
  await Deno.writeTextFile(join(ctx.outDir, "content-data.json"), JSON.stringify(store));
  await Deno.writeTextFile(
    join(ctx.outDir, "content.ts"),
    generateContentTypes(ctx.outDir, configPath),
  );

  return { counts, diagnostics, ok: diagnostics.length === 0, configured: true };
}
