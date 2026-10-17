// publish.yml's check that a tag publishes the version it names: `v4.3.0` must find `deno.json`
// at 4.3.0, `docs-corpus-v4.3.0` must find `packages/docs-corpus/deno.json` at 4.3.0. JSR takes
// the version from the config, not the tag, so without this a tag pushed on the wrong commit
// would publish whatever version that commit's config holds, under a tag naming another.
//
//   deno run -A scripts/publish-tag.ts <tag> <config>

import { basename, dirname } from "@std/path";

/**
 * Why `tag` must not publish the package configured by `config` (whose `version` is `version`),
 * or `null` when the tag names exactly that version under that package's prefix.
 *
 * @param tag The pushed tag (`v4.3.0`, `og-v0.2.0`).
 * @param config The config publish.yml resolved for it (`deno.json`, `packages/og/deno.json`).
 * @param version The config's `version`.
 * @returns The refusal, or `null`.
 */
export function tagVersionProblem(tag: string, config: string, version: unknown): string | null {
  const prefix = config === "deno.json" ? "v" : `${basename(dirname(config))}-v`;
  if (!tag.startsWith(prefix)) return `tag ${tag} does not start with ${prefix} (${config})`;
  const named = tag.slice(prefix.length);
  if (typeof version !== "string" || version === "") return `${config} has no version`;
  if (named !== version) {
    return `tag ${tag} names ${named}, but ${config} is at ${version}: refusing to publish ` +
      `${version} under it (tag the commit that bumped it)`;
  }
  return null;
}

if (import.meta.main) {
  const [tag, config] = Deno.args;
  if (!tag || !config) {
    console.error("usage: deno run -A scripts/publish-tag.ts <tag> <config>");
    Deno.exit(2);
  }
  const version = JSON.parse(await Deno.readTextFile(config)).version;
  const problem = tagVersionProblem(tag, config, version);
  if (problem) {
    console.error(`::error::${problem}`);
    Deno.exit(1);
  }
  console.log(`${tag} publishes ${config} at ${version}`);
}
