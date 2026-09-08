/**
 * `@denext/content-collections/config` — the author-facing API for `content.config.ts`:
 * `defineContentConfig` / `defineCollection`, the `glob` loader for local files, and the
 * `Loader` interface for remote/custom sources.
 *
 * ```ts
 * // content.config.ts
 * import { defineCollection, defineContentConfig, glob } from "@denext/content-collections/config";
 * import { z } from "zod";
 * export default defineContentConfig({
 *   collections: {
 *     blog: defineCollection({
 *       loader: glob({ pattern: "**\/*.md", base: "content/blog" }),
 *       schema: z.object({ title: z.string(), date: z.string(), draft: z.boolean().default(false) }),
 *     }),
 *   },
 * });
 * ```
 *
 * @module
 */

import { extractYaml, test as hasFrontmatter } from "@std/front-matter";
import { parse as parseYaml } from "@std/yaml";
import { walk } from "@std/fs";
import { globToRegExp, join, relative } from "@std/path";
// The Standard Schema types come from denext (which defines the same validator-agnostic surface for
// `defineApi`/`defineAction`), so a collection `schema` is the exact type those APIs accept.
import type { StandardIssue, StandardResult, StandardSchemaV1 } from "@denext/denext/server";

export type { StandardIssue, StandardResult, StandardSchemaV1 };

/** A raw entry a {@linkcode Loader} yields, before schema validation. */
export interface RawEntry {
  /** Stable id — the source path under the loader's base, without extension (`guides/intro`). */
  id: string;
  /** The entry's fields: frontmatter (for MD/MDX) or the parsed object (for YAML/JSON). */
  data: Record<string, unknown>;
  /** The raw MD/MDX body (absent for data files). */
  body?: string;
  /** Absolute source path (for build diagnostics). */
  filePath?: string;
}

/** Context passed to a {@linkcode Loader.load}. */
export interface LoaderContext {
  /** Absolute project root (the dir holding `content.config.ts`). */
  readonly projectRoot: string;
}

/** A source of entries for a collection: local files ({@linkcode glob}), or a remote/custom function. */
export interface Loader {
  /** A short loader name (for diagnostics). */
  readonly name: string;
  /** Enumerate this collection's raw entries. */
  load(ctx: LoaderContext): RawEntry[] | Promise<RawEntry[]>;
}

/** A collection definition (its loader, an optional validation schema, and its kind). */
export interface CollectionConfig<S extends StandardSchemaV1 = StandardSchemaV1> {
  /** Where the entries come from. */
  readonly loader: Loader;
  /** Standard Schema validating (and typing) each entry's `data`. Omit to accept any fields. */
  readonly schema?: S;
  /** `content` (MD/MDX with a `body`) or `data` (YAML/JSON). Informational; the loader decides. */
  readonly type?: "content" | "data";
}

/** Identity helper: define one collection with full type inference for its schema. */
export function defineCollection<S extends StandardSchemaV1>(
  config: CollectionConfig<S>,
): CollectionConfig<S> {
  return config;
}

/** The `content.config.ts` shape: a named map of collections. */
export interface ContentConfig {
  /** Collections keyed by name (the name you pass to `getCollection`). */
  readonly collections: Record<string, CollectionConfig>;
}

/** Identity helper: define the content config with full type inference. */
export function defineContentConfig<T extends ContentConfig>(config: T): T {
  return config;
}

/** Options for the built-in {@linkcode glob} loader. */
export interface GlobOptions {
  /** Glob pattern(s) relative to `base` (e.g. `**\/*.md` or `["**\/*.md", "**\/*.mdx"]`). */
  readonly pattern: string | string[];
  /** Directory the pattern is relative to, itself relative to the project root (e.g. `content/blog`). */
  readonly base: string;
}

const MARKDOWN = /\.mdx?$/;
const YAML_EXT = /\.ya?ml$/;
const JSON_EXT = /\.json$/;

/** Parse one file's text into an entry's `{ data, body }` by extension. */
function parseFile(path: string, text: string): { data: Record<string, unknown>; body?: string } {
  if (MARKDOWN.test(path)) {
    if (hasFrontmatter(text)) {
      const { attrs, body } = extractYaml(text);
      return { data: attrs as Record<string, unknown>, body };
    }
    return { data: {}, body: text };
  }
  if (YAML_EXT.test(path)) return { data: (parseYaml(text) ?? {}) as Record<string, unknown> };
  if (JSON_EXT.test(path)) return { data: (JSON.parse(text) ?? {}) as Record<string, unknown> };
  return { data: {}, body: text };
}

/**
 * A loader that reads local files matching `pattern` under `base`. MD/MDX files yield their YAML
 * frontmatter as `data` and the rest as `body`; YAML/JSON files yield the parsed object as `data`.
 * The entry `id` is the source path under `base`, without its extension.
 */
export function glob(options: GlobOptions): Loader {
  const patterns = Array.isArray(options.pattern) ? options.pattern : [options.pattern];
  return {
    name: `glob(${options.base})`,
    async load(ctx) {
      const baseDir = join(ctx.projectRoot, options.base);
      const regexps = patterns.map((p) => globToRegExp(p, { globstar: true, extended: true }));
      const entries: RawEntry[] = [];
      let root: string;
      try {
        root = baseDir;
        // Confirm the base exists; a missing content dir yields no entries (not an error).
        await Deno.stat(baseDir);
      } catch {
        return entries;
      }
      for await (const item of walk(root, { includeDirs: false })) {
        const rel = relative(baseDir, item.path).replaceAll("\\", "/");
        if (!regexps.some((re) => re.test(rel))) continue;
        const text = await Deno.readTextFile(item.path);
        const { data, body } = parseFile(item.path, text);
        const id = rel.replace(/\.[^./]+$/, "");
        entries.push({ id, data, body, filePath: item.path });
      }
      return entries;
    },
  };
}
