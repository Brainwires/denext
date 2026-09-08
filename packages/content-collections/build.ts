/**
 * `@denext/content-collections/build` (internal) — discover `content.config.ts`, run each
 * collection's loader, validate every entry against its schema, and write the built store
 * (`.denext/content-data.json`) plus the generated types (`.denext/content.ts`). Runs from the
 * plugin's prepare step at `denext dev` startup + on content change, and at `denext build`.
 *
 * @module
 */

import { join, toFileUrl } from "@std/path";
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
 * Run the content build: validate every entry, write `content-data.json` + `content.ts`. Invalid
 * entries are dropped and reported in `diagnostics` (never throws for bad content — the `denext
 * content validate` CLI turns diagnostics into a CI failure). Returns `configured: false` when the
 * app defines no `content.config.ts`.
 */
export async function buildContent(ctx: ContentBuildContext): Promise<ContentBuildReport> {
  const found = await discoverContentConfig(ctx.projectRoot);
  if (!found) return { counts: {}, diagnostics: [], ok: true, configured: false };
  const { config, configPath } = found;

  const store: Record<string, Array<{ id: string; data: unknown; body?: string }>> = {};
  const diagnostics: ContentDiagnostic[] = [];
  const counts: Record<string, number> = {};

  for (const [name, collection] of Object.entries(config.collections)) {
    const raw = await collection.loader.load({ projectRoot: ctx.projectRoot });
    const entries: Array<{ id: string; data: unknown; body?: string }> = [];
    for (const entry of raw) {
      let data: unknown = entry.data;
      if (collection.schema) {
        const result = await collection.schema["~standard"].validate(entry.data);
        if ("issues" in result && result.issues) {
          diagnostics.push({
            collection: name,
            id: entry.id,
            filePath: entry.filePath,
            messages: result.issues.map((i) => `${issuePath(i)}: ${i.message}`),
          });
          continue;
        }
        data = result.value;
      }
      entries.push({
        id: entry.id,
        data,
        ...(entry.body !== undefined ? { body: entry.body } : {}),
      });
    }
    entries.sort((a, b) => a.id.localeCompare(b.id));
    store[name] = entries;
    counts[name] = entries.length;
  }

  await Deno.mkdir(ctx.outDir, { recursive: true }).catch(() => {});
  await Deno.writeTextFile(join(ctx.outDir, "content-data.json"), JSON.stringify(store));
  await Deno.writeTextFile(
    join(ctx.outDir, "content.ts"),
    generateContentTypes(ctx.outDir, configPath),
  );

  return { counts, diagnostics, ok: diagnostics.length === 0, configured: true };
}
