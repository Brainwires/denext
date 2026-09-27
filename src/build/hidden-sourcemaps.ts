// Hidden source maps for `denext export --sourcemaps hidden`: the production bundles are built
// with external source maps (no `sourceMappingURL` comment, so nothing served points at a map),
// and the export then moves every `.map` out of the web root into `.denext/sourcemaps/`, next to
// a copy of the JS it maps, mirroring the web-root paths (`_denext/client/index.js` +
// `index.js.map`). A crash reporter's uploader takes that folder as is, e.g.
//
//   npx @sentry/cli sourcemaps upload --release "$(jq -r .version out/_denext/ota.json)" \
//     --url-prefix "~/" .denext/sourcemaps
//
// which pairs each file with `<file>.map` by name, and matches stack frames by path whatever the
// origin (`capacitor://localhost` on iOS, `https://localhost` on Android). The app package never
// contains a map, and the OTA manifest (written after the move) never lists one.
//
// The switch is the `DENEXT_SOURCEMAPS=hidden` environment variable, which `--sourcemaps hidden`
// sets for the run (the way `denext analyze` sets `DENEXT_ANALYZE`): both bundlers read it, so the
// option needs no plumbing through every build stage.

import { dirname, join, relative } from "@std/path";
import { walk } from "@std/fs";

/** The environment variable that turns hidden source maps on (`hidden`). */
export const SOURCEMAPS_ENV = "DENEXT_SOURCEMAPS";

/** The folder under the build dir (`.denext/`) the maps are moved to. */
const SOURCEMAPS_DIR = "sourcemaps";

/**
 * Whether this run builds hidden source maps (`DENEXT_SOURCEMAPS=hidden`).
 *
 * @returns True when enabled; false without env permission.
 */
export function hiddenSourceMapsEnabled(): boolean {
  try {
    return Deno.env.get(SOURCEMAPS_ENV) === "hidden";
  } catch {
    return false;
  }
}

/** A trailing `//# sourceMappingURL=…` line (a bundler that linked the map anyway). */
const MAPPING_COMMENT = /\n?\/\/# sourceMappingURL=[^\n]*\s*$/;

/**
 * Move every source map out of `webRoot` into `stashDir`, each beside a copy of the file it maps
 * (same relative path), and drop any `sourceMappingURL` comment left in that file. `*.map.gz`
 * siblings (precompression) are deleted. `stashDir` is emptied first, so it holds exactly this
 * export's maps.
 *
 * @param webRoot The export being assembled (its staging folder).
 * @param stashDir Where the maps go (`.denext/sourcemaps`).
 * @returns How many maps were moved.
 */
export async function stashHiddenSourceMaps(webRoot: string, stashDir: string): Promise<number> {
  await Deno.remove(stashDir, { recursive: true }).catch(() => {});
  let moved = 0;
  const maps: string[] = [];
  for await (const e of walk(webRoot, { includeDirs: false, exts: [".map", ".gz"] })) {
    if (e.path.endsWith(".map")) maps.push(e.path);
    else if (e.path.endsWith(".map.gz")) await Deno.remove(e.path);
  }
  for (const map of maps) {
    const rel = relative(webRoot, map);
    const target = join(stashDir, rel);
    await Deno.mkdir(dirname(target), { recursive: true });
    await Deno.writeTextFile(target, await Deno.readTextFile(map));
    await Deno.remove(map);
    moved++;
    const code = map.slice(0, -".map".length);
    let text: string;
    try {
      text = await Deno.readTextFile(code);
    } catch {
      continue;
    }
    const clean = text.replace(MAPPING_COMMENT, "\n");
    if (clean !== text) {
      await Deno.writeTextFile(code, clean);
      await Deno.remove(`${code}.gz`).catch(() => {}); // stale now; served uncompressed instead
    }
    await Deno.writeTextFile(join(stashDir, relative(webRoot, code)), clean);
  }
  return moved;
}

/**
 * The export's last step before the OTA manifest: with hidden source maps on, move them from
 * `webRoot` into `<buildDir>/sourcemaps` and say so. A no-op otherwise.
 *
 * @param webRoot The export being assembled.
 * @param buildDir The project's build folder (`.denext`).
 */
export async function stashSourceMapsIfHidden(webRoot: string, buildDir: string): Promise<void> {
  if (!hiddenSourceMapsEnabled()) return;
  const stash = join(buildDir, SOURCEMAPS_DIR);
  const moved = await stashHiddenSourceMaps(webRoot, stash);
  console.log(
    moved > 0
      ? `  hidden source maps: ${moved} map(s) -> ${stash} (not shipped; upload them to your crash reporter)`
      : "  hidden source maps: the bundler emitted none",
  );
}
