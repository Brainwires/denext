// `@denext/docs-corpus` (packages/docs-corpus): the generated docs corpus, published on its own
// and pinned EXACTLY by `@denext/denext`: denext X.Y.Z ships with `@denext/docs-corpus` X.Y.Z
// (root deno.json maps `@denext/docs-corpus` to `jsr:@denext/docs-corpus@<version>`, which the
// workspace member satisfies locally and `deno publish` writes into the published source).
//   - the bump (scripts/bump-version.ts) moves both versions together, rc versions included;
//   - the release (scripts/release.ts, step 6) publishes `docs-corpus-v<version>` before `v*`, and
//     refuses when JSR already has that version with another source hash, or with another copy of
//     any data module the package also carries for denext (CORPUS_DATA_MODULES).

import { dirname, fromFileUrl, join } from "@std/path";
import { type Fetch, jsrHasVersion } from "./jsr-pins.ts";

const ROOT = fromFileUrl(new URL("../../", import.meta.url));

/** The package's JSR name. */
export const CORPUS_PACKAGE = "@denext/docs-corpus";
/** Its manifest. */
export const CORPUS_PACKAGE_JSON: string = join(ROOT, "packages", "docs-corpus", "deno.json");
/** Its generated module (the corpus). */
export const CORPUS_MODULE: string = join(ROOT, "packages", "docs-corpus", "mod.ts");
/**
 * The package's other modules: generated data `@denext/denext` loads from here to stay under
 * JSR's 20 MiB cap (packages/docs-corpus/<file>). A resumed release compares each whole with the
 * copy JSR serves, as it compares the corpus by its source hash. Only data denext reads on a
 * path that can wait for it belongs here: denext run from a checkout reads the checkout's copy
 * (src/build/native-templates.packed.ts), never a docs-corpus release; the data every CLI start,
 * the project UI or a build reads ships in @denext/denext itself, packed.
 */
export const CORPUS_DATA_MODULES: readonly string[] = ["native-templates.ts"];

/** The version in packages/docs-corpus/deno.json. */
export async function corpusVersion(manifest: string = CORPUS_PACKAGE_JSON): Promise<string> {
  return JSON.parse(await Deno.readTextFile(manifest)).version;
}

/** The `CORPUS_SOURCE_HASH` a corpus module declares, or null. */
export function moduleSourceHash(moduleText: string): string | null {
  return /export const CORPUS_SOURCE_HASH(?:: string)? = "([0-9a-f]+)"/.exec(moduleText)?.[1] ??
    null;
}

/** The source hash of the corpus JSR serves at `version`, or null when it has no such version. */
export async function publishedSourceHash(
  version: string,
  fetchFn: Fetch = fetch,
): Promise<string | null> {
  if (!await jsrHasVersion(CORPUS_PACKAGE, version, fetchFn)) return null;
  const res = await fetchFn(`https://jsr.io/${CORPUS_PACKAGE}/${version}/mod.ts`);
  if (!res.ok) throw new Error(`jsr.io/${CORPUS_PACKAGE}/${version}/mod.ts: HTTP ${res.status}`);
  return moduleSourceHash(await res.text());
}

/** Where a release's corpus version stands on JSR. */
export type CorpusRelease =
  /** JSR does not list the version: the release publishes it (`docs-corpus-v<version>`). */
  | { state: "missing"; version: string }
  /** JSR has the version with this corpus (a resumed release): nothing to publish. */
  | { state: "published"; version: string }
  /**
   * JSR has the version with another corpus, or another copy of the data module `module`: the
   * release cannot go on. `local` / `published` are the corpus's source hashes, or the module's
   * SHA-256 when `module` is set.
   */
  | {
    state: "conflict";
    version: string;
    local: string | null;
    published: string | null;
    module?: string;
  };

/** Hex SHA-256 of a text. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The first data module (CORPUS_DATA_MODULES) whose copy on JSR at `version` differs from the
 * local one, with both SHA-256s (`published` null when JSR does not serve it), or null.
 */
export async function dataModuleConflict(
  version: string,
  fetchFn: Fetch = fetch,
  dir: string = join(ROOT, "packages", "docs-corpus"),
  modules: readonly string[] = CORPUS_DATA_MODULES,
): Promise<{ module: string; local: string; published: string | null } | null> {
  for (const module of modules) {
    const local = await sha256Hex(await Deno.readTextFile(join(dir, module)));
    const res = await fetchFn(`https://jsr.io/${CORPUS_PACKAGE}/${version}/${module}`);
    if (!res.ok && res.status !== 404) {
      throw new Error(`jsr.io/${CORPUS_PACKAGE}/${version}/${module}: HTTP ${res.status}`);
    }
    let published: string | null = null;
    if (res.ok) published = await sha256Hex(await res.text());
    else await res.body?.cancel();
    if (published !== local) return { module, local, published };
  }
  return null;
}

/**
 * The release's check of `packages/docs-corpus`: its version must be the release's (`version`),
 * and when JSR already lists that version its source hash must be the local corpus's. Never
 * another version: denext X.Y.Z pins exactly `@denext/docs-corpus` X.Y.Z.
 */
export async function corpusReleaseState(
  version: string,
  fetchFn: Fetch = fetch,
  manifest: string = CORPUS_PACKAGE_JSON,
  module: string = CORPUS_MODULE,
): Promise<CorpusRelease> {
  const pinned = await corpusVersion(manifest);
  if (pinned !== version) {
    throw new Error(
      `${CORPUS_PACKAGE} is at ${pinned}, not ${version} — the bump moves both ` +
        "(scripts/bump-version.ts)",
    );
  }
  if (!await jsrHasVersion(CORPUS_PACKAGE, version, fetchFn)) return { state: "missing", version };
  const local = moduleSourceHash(await Deno.readTextFile(module));
  const published = await publishedSourceHash(version, fetchFn);
  if (local === null || published !== local) {
    return { state: "conflict", version, local, published };
  }
  const data = await dataModuleConflict(version, fetchFn, dirname(module));
  return data ? { state: "conflict", version, ...data } : { state: "published", version };
}

/** The refusal for a corpus version JSR has with another corpus. */
export function corpusConflictMessage(c: Extract<CorpusRelease, { state: "conflict" }>): string {
  if (c.module) {
    return `jsr.io already has ${CORPUS_PACKAGE}@${c.version} with another ${c.module} ` +
      `(SHA-256 ${c.published ?? "missing"}, this tree's is ${c.local ?? "unknown"}). ` +
      `denext ${c.version} must ship exactly that module and a published version cannot change, ` +
      "so this release cannot go on: regenerate it from the tree the corpus was published from " +
      "(its docs-corpus-v tag), or release the next denext version.";
  }
  return `jsr.io already has ${CORPUS_PACKAGE}@${c.version} with another corpus ` +
    `(source hash ${c.published ?? "unknown"}, this tree's is ${c.local ?? "unknown"}). ` +
    `denext ${c.version} must ship exactly that corpus and a published version cannot change, ` +
    "so this release cannot go on: regenerate the corpus from the tree it was published from " +
    "(its docs-corpus-v tag), or release the next denext version.";
}
