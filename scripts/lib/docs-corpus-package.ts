// `@denext/docs-corpus` (packages/docs-corpus): the generated docs corpus, published on its own
// and pinned by `@denext/denext`. Its version tracks the corpus: a corpus whose content changed
// since the last published version needs a new patch version before the denext release that
// pins it. Two places keep that true:
//   - `deno task docs:corpus` (and so the pre-commit hook) bumps the patch when the content
//     changed and the current version already has its `docs-corpus-v*` tag (it was released);
//   - the release script asks JSR: a published version with a different source hash is bumped.

import { fromFileUrl, join } from "@std/path";
import { type Fetch, jsrHasVersion } from "./jsr-pins.ts";

const ROOT = fromFileUrl(new URL("../../", import.meta.url));

/** The package's JSR name. */
export const CORPUS_PACKAGE = "@denext/docs-corpus";
/** Its manifest. */
export const CORPUS_PACKAGE_JSON: string = join(ROOT, "packages", "docs-corpus", "deno.json");
/** Its generated module (the corpus). */
export const CORPUS_MODULE: string = join(ROOT, "packages", "docs-corpus", "mod.ts");
/** The prefix of the tags that publish it (publish.yml). */
export const CORPUS_TAG_PREFIX = "docs-corpus-v";

/** `1.2.3` → `1.2.4` (a prerelease or build tail is dropped). */
export function nextPatch(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) throw new Error(`not a semver: ${version}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/** The version in packages/docs-corpus/deno.json. */
export async function corpusVersion(manifest: string = CORPUS_PACKAGE_JSON): Promise<string> {
  return JSON.parse(await Deno.readTextFile(manifest)).version;
}

/** Rewrite the manifest's `"version"` (only that line: the file keeps its formatting). */
export async function setCorpusVersion(
  version: string,
  manifest: string = CORPUS_PACKAGE_JSON,
): Promise<void> {
  const text = await Deno.readTextFile(manifest);
  const next = text.replace(/("version":\s*)"[^"]*"/, `$1${JSON.stringify(version)}`);
  if (next === text) throw new Error(`${manifest}: no "version" field to set`);
  await Deno.writeTextFile(manifest, next);
}

/** The `CORPUS_SOURCE_HASH` a corpus module declares, or null. */
export function moduleSourceHash(moduleText: string): string | null {
  return /export const CORPUS_SOURCE_HASH(?:: string)? = "([0-9a-f]+)"/.exec(moduleText)?.[1] ??
    null;
}

/** The repository's tags (empty outside a git checkout). */
export async function gitTags(root: string = ROOT): Promise<string[]> {
  const out = await new Deno.Command("git", { args: ["tag", "--list"], cwd: root, stderr: "null" })
    .output().catch(() => null);
  if (!out?.success) return [];
  return new TextDecoder().decode(out.stdout).split("\n").filter(Boolean);
}

/**
 * After a regeneration that changed the corpus: the next patch version when `version` was
 * already released (its tag is in `tags`), else null (the pending version takes the change).
 */
export function versionAfterChange(version: string, tags: readonly string[]): string | null {
  return tags.includes(`${CORPUS_TAG_PREFIX}${version}`) ? nextPatch(version) : null;
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

/**
 * The release's check: when JSR already has the pinned version with other content, the version
 * the release must pin instead (the next patch), else null.
 */
export async function releaseCorpusVersion(fetchFn: Fetch = fetch): Promise<string | null> {
  const version = await corpusVersion();
  const local = moduleSourceHash(await Deno.readTextFile(CORPUS_MODULE));
  const published = await publishedSourceHash(version, fetchFn);
  if (published === null || published === local) return null;
  let next = nextPatch(version);
  while (await jsrHasVersion(CORPUS_PACKAGE, next, fetchFn)) next = nextPatch(next);
  return next;
}
