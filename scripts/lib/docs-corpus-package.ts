// `@denext/docs-corpus` (packages/docs-corpus): the generated docs corpus, published on its own
// and pinned EXACTLY by `@denext/denext`: denext X.Y.Z ships with `@denext/docs-corpus` X.Y.Z
// (root deno.json maps `@denext/docs-corpus` to `jsr:@denext/docs-corpus@<version>`, which the
// workspace member satisfies locally and `deno publish` writes into the published source).
//   - the bump (scripts/bump-version.ts) moves both versions together, rc versions included;
//   - the release (scripts/release.ts, step 6) publishes `docs-corpus-v<version>` before `v*`, and
//     refuses when JSR already has that version with another source hash.

import { fromFileUrl, join } from "@std/path";
import { type Fetch, jsrHasVersion } from "./jsr-pins.ts";

const ROOT = fromFileUrl(new URL("../../", import.meta.url));

/** The package's JSR name. */
export const CORPUS_PACKAGE = "@denext/docs-corpus";
/** Its manifest. */
export const CORPUS_PACKAGE_JSON: string = join(ROOT, "packages", "docs-corpus", "deno.json");
/** Its generated module (the corpus). */
export const CORPUS_MODULE: string = join(ROOT, "packages", "docs-corpus", "mod.ts");
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
  /** JSR has the version with another corpus: the release cannot go on. */
  | { state: "conflict"; version: string; local: string | null; published: string | null };

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
  return local !== null && published === local
    ? { state: "published", version }
    : { state: "conflict", version, local, published };
}

/** The refusal for a corpus version JSR has with another corpus. */
export function corpusConflictMessage(c: Extract<CorpusRelease, { state: "conflict" }>): string {
  return `jsr.io already has ${CORPUS_PACKAGE}@${c.version} with another corpus ` +
    `(source hash ${c.published ?? "unknown"}, this tree's is ${c.local ?? "unknown"}). ` +
    `denext ${c.version} must ship exactly that corpus and a published version cannot change, ` +
    "so this release cannot go on: regenerate the corpus from the tree it was published from " +
    "(its docs-corpus-v tag), or release the next denext version.";
}
