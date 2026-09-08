/**
 * `@denext/content-collections/runtime` — the server-only query API. Import the generated
 * `.denext/content.d.ts` once (it registers your `content.config.ts` type) and `getCollection` /
 * `getEntry` are typed to your collections and their schemas.
 *
 * ```tsx
 * import "./.denext/content.ts"; // registers the types
 * import { getCollection } from "@denext/content-collections/runtime";
 * export default async function Blog() {
 *   const posts = await getCollection("blog", (p) => !p.data.draft);
 *   return <ul>{posts.map((p) => <li key={p.id}>{p.data.title}</li>)}</ul>;
 * }
 * ```
 *
 * Reads the built store (`<cwd>/.denext/content-data.json`, written by the plugin's prepare step at
 * `denext dev` startup and `denext build`). Server-only — call it from Server Components, route
 * handlers, or build code.
 *
 * @module
 */

import { join } from "@std/path";
import type { CollectionConfig, ContentConfig, StandardSchemaV1 } from "./config.ts";

/**
 * Registration seam: the generated `.denext/content.ts` augments this with `config: typeof
 * <your content.config>`, so the query API infers your collections and schemas. Empty until then.
 */
// deno-lint-ignore no-empty-interface
export interface RegisteredContent {}

/** The registered content config type, or the loose base until `.denext/content.ts` is imported. */
export type RegisteredConfig = RegisteredContent extends { config: infer C extends ContentConfig }
  ? C
  : ContentConfig;

/** Every collection name in this app's content config. */
export type CollectionKey = keyof RegisteredConfig["collections"] & string;

/**
 * The validated `data` type of a schema (its Standard Schema output). A collection with no schema
 * (output `unknown`) becomes a loose, indexable `Record<string, unknown>` rather than `unknown`.
 */
type SchemaOut<S> = S extends StandardSchemaV1<infer O>
  ? ([unknown] extends [O] ? Record<string, unknown> : O)
  : Record<string, unknown>;

/** The `data` type for one collection (its schema's output, or a loose record when unschema'd). */
export type DataOf<K extends CollectionKey> = RegisteredConfig["collections"][K] extends
  CollectionConfig<infer S> ? SchemaOut<S>
  : Record<string, unknown>;

/** One entry: a stable `id`/`slug`, the validated `data`, and (for MD/MDX) the raw `body`. */
export interface CollectionEntry<K extends CollectionKey = CollectionKey> {
  /** Stable id — the source path under the loader's base, without extension. */
  readonly id: string;
  /** URL-friendly slug (equals `id` for the file loader). */
  readonly slug: string;
  /** The validated fields (frontmatter / parsed data), typed by the collection's schema. */
  readonly data: DataOf<K>;
  /** The raw MD/MDX body (absent for data collections). */
  readonly body?: string;
}

/** A stored entry as written to `content-data.json` (before `slug` is derived). */
interface StoredEntry {
  id: string;
  data: Record<string, unknown>;
  body?: string;
}

let storePath: string | null = null;
let cache: Promise<Record<string, CollectionEntry[]>> | null = null;

/** The resolved store path — an override (see {@linkcode setContentStorePath}) or `<cwd>/.denext`. */
function resolvedStorePath(): string {
  return storePath ?? join(Deno.cwd(), ".denext", "content-data.json");
}

/** Read + parse the built store once, deriving each entry's `slug`. Missing store → empty. */
function loadStore(): Promise<Record<string, CollectionEntry[]>> {
  return cache ??= (async () => {
    try {
      const raw = JSON.parse(await Deno.readTextFile(resolvedStorePath())) as Record<
        string,
        StoredEntry[]
      >;
      const out: Record<string, CollectionEntry[]> = {};
      for (const [name, arr] of Object.entries(raw)) {
        out[name] = arr.map((e) => ({ id: e.id, slug: e.id, data: e.data, body: e.body }));
      }
      return out;
    } catch {
      return {};
    }
  })();
}

/**
 * Every entry in a collection (optionally filtered), typed by the collection's schema.
 *
 * @param name The collection name.
 * @param filter Keep only entries for which this returns true.
 */
export async function getCollection<K extends CollectionKey>(
  name: K,
  filter?: (entry: CollectionEntry<K>) => boolean,
): Promise<CollectionEntry<K>[]> {
  const store = await loadStore();
  const list = (store[name] ?? []) as CollectionEntry<K>[];
  return filter ? list.filter(filter) : list;
}

/**
 * One entry by id, or `undefined` if there is no such entry.
 *
 * @param name The collection name.
 * @param id The entry id (its path under the loader base, without extension).
 */
export async function getEntry<K extends CollectionKey>(
  name: K,
  id: string,
): Promise<CollectionEntry<K> | undefined> {
  const store = await loadStore();
  return (store[name] as CollectionEntry<K>[] | undefined)?.find((e) => e.id === id);
}

/** Override where the built store is read from (default `<cwd>/.denext/content-data.json`). */
export function setContentStorePath(path: string | null): void {
  storePath = path;
  cache = null;
}

/** Drop the in-process store cache (a dev regeneration; tests). */
export function clearContentCache(): void {
  cache = null;
}
