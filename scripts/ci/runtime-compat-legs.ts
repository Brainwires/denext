// The denext releases a runtime candidate must pass before it is signed into the runtime channel
// (.github/workflows/runtime-compat.yml, scripts/runtime-channel.ts `publish`): the latest stable
// denext and the last patch of the minor before it. Release candidates never count.
//
//   deno run -A scripts/ci/runtime-compat-legs.ts     # prints the legs as a JSON matrix list
//
// Reads the repository's `v<major>.<minor>.<patch>` tags (`git tag -l`); the support window is two
// minors, so older denexts stay on the runtime they bundle.

/** One leg: the denext version, its tag, and the runner slot the picker assigns it. */
export interface CompatLegSpec {
  readonly denext: string;
  readonly tag: string;
  readonly slot: string;
}

type Version = [number, number, number];

/** A stable tag's version, or `null` (a prerelease or anything else). */
function stable(tag: string): Version | null {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const newer = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * The compatibility legs among `tags`: the newest stable release, and the newest stable release of
 * any older minor (the previous minor's last patch). Fewer than two stable minors: just one leg.
 *
 * @param tags Git tag names.
 * @returns The legs, newest first.
 */
export function compatLegsFromTags(tags: readonly string[]): CompatLegSpec[] {
  const versions = tags.map(stable).filter((v): v is Version => v !== null).sort((a, b) =>
    newer(b, a)
  );
  const latest = versions[0];
  if (!latest) return [];
  const previous = versions.find((v) => v[0] !== latest[0] || v[1] !== latest[1]);
  return [latest, ...(previous ? [previous] : [])].map((v, i) => ({
    denext: v.join("."),
    tag: `v${v.join(".")}`,
    slot: `compat_${i}`,
  }));
}

if (import.meta.main) {
  const { stdout } = await new Deno.Command("git", { args: ["tag", "-l", "v*"], stdout: "piped" })
    .output();
  console.log(JSON.stringify(compatLegsFromTags(new TextDecoder().decode(stdout).split("\n"))));
}
