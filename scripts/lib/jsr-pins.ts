// The workspace members `@denext/denext` imports at run time. `deno publish` rewrites each bare
// `@denext/<name>` specifier to `jsr:@denext/<name>@^<that member's version>` (`@denext/docs-corpus`
// to the exact `jsr:@denext/docs-corpus@<denext's version>` root deno.json maps it to), so a
// denext release is broken on arrival when one of those versions is not on JSR yet (4.1.0's
// `@denext/og`). The release script refuses to tag until every pin resolves (scripts/release.ts).

import { fromFileUrl, join } from "@std/path";

const ROOT = fromFileUrl(new URL("../../", import.meta.url));

/**
 * The `packages/<dir>` members the published framework imports (tests/release-tools.test.ts
 * checks this list against the published sources' `@denext/*` specifiers).
 */
export const RUNTIME_MEMBERS: readonly string[] = ["avif", "docs-corpus", "og", "photon"];

/** One pinned member: its JSR name, the version a release would pin, and its release tag. */
export interface MemberPin {
  name: string;
  version: string;
  /** The tag that publishes it (`og-v0.1.2`, publish.yml). */
  tag: string;
}

/** A member's pin, from its `packages/<dir>/deno.json`. */
export async function memberPin(dir: string, root: string = ROOT): Promise<MemberPin> {
  const json = JSON.parse(await Deno.readTextFile(join(root, "packages", dir, "deno.json")));
  return { name: json.name, version: json.version, tag: `${dir}-v${json.version}` };
}

/** `fetch`, or a stand-in (tests). */
export type Fetch = (url: string) => Promise<Response>;

/**
 * Whether JSR lists `version` of `name` (`https://jsr.io/<name>/meta.json`), yanked or not: a
 * version JSR has is a version `deno publish` can no longer reuse. Throws when JSR cannot be asked.
 */
export async function jsrHasVersion(
  name: string,
  version: string,
  fetchFn: Fetch = fetch,
): Promise<boolean> {
  const res = await fetchFn(`https://jsr.io/${name}/meta.json`);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`jsr.io/${name}/meta.json: HTTP ${res.status}`);
  const meta = await res.json() as { versions?: Record<string, unknown> };
  return Object.hasOwn(meta.versions ?? {}, version);
}

/** The runtime members whose pinned version JSR does not have. */
export async function missingPins(
  fetchFn: Fetch = fetch,
  root: string = ROOT,
): Promise<MemberPin[]> {
  const missing: MemberPin[] = [];
  for (const dir of RUNTIME_MEMBERS) {
    const pin = await memberPin(dir, root);
    if (!await jsrHasVersion(pin.name, pin.version, fetchFn)) missing.push(pin);
  }
  return missing;
}
