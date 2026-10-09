// Keeping a project's tracked `routeTree.gen.ts` exactly as committed when a denext build
// regenerates the same routes.
//
// The TanStack route generator that `spa.tanstackRouter` runs is denext's pinned
// `@tanstack/router-plugin`, not the app's own: another version orders the imports and route
// declarations differently, and the Vite config's inline generator settings (`quoteStyle`,
// `semicolons`) do not reach it (`tsr.config.json` does). Without this, every denext build of a
// Vite-era app rewrote the committed tree, and every Vite dev run wrote it back.
//
// After generation, a tree whose top-level statements are the committed tree's, in any order and
// up to quote style, semicolons and indentation, is restored byte for byte. Anything else (a route
// added, renamed or removed) keeps the generator's output.

import { resolve } from "@std/path";
import { endOf, parseModule, startOf } from "./swc-ast.ts";

/** The generator settings that place the tree (inline options win over `tsr.config.json`). */
interface TreeSettings {
  generatedRouteTree?: unknown;
  disableTypes?: unknown;
}

/** `tsr.config.json` in `root`, or an empty object when absent or unreadable. */
async function tsrConfig(root: string): Promise<TreeSettings> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(resolve(root, "tsr.config.json")));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Where the generator writes the route tree, resolved as `@tanstack/router-generator`'s
 * `getConfig` does: the inline setting, else `tsr.config.json`'s, else `./src/routeTree.gen.ts`,
 * relative to `root`; `disableTypes` turns `.ts`/`.tsx` into `.js`.
 *
 * @param root The generator's root (the project directory).
 * @param inline The settings denext passes the plugin.
 * @returns The absolute path of the generated tree.
 */
export async function generatedRouteTreePath(root: string, inline: TreeSettings): Promise<string> {
  const settings = { ...await tsrConfig(root), ...inline };
  const rel = typeof settings.generatedRouteTree === "string"
    ? settings.generatedRouteTree
    : "./src/routeTree.gen.ts";
  const path = resolve(root, rel);
  return settings.disableTypes === true ? path.replace(/\.(ts|tsx)$/, ".js") : path;
}

/** One line with its style removed: indentation, a trailing `;`, and the quote character. */
const normalizeLine = (line: string): string => line.trim().replace(/;$/, "").replaceAll('"', "'");

/**
 * A module's top-level statements, each reduced to its normalized lines in sorted order, the
 * statements themselves sorted: equal for two trees that differ only in statement order, line
 * order within a declaration (an interface's members), or style. Null when it does not parse.
 */
async function statementShape(source: string): Promise<string[] | null> {
  const parsed = await parseModule(source);
  if (!parsed) return null;
  const decoder = new TextDecoder();
  return parsed.body.map((item) => {
    const text = decoder.decode(
      parsed.ctx.bytes.subarray(startOf(parsed.ctx, item), endOf(parsed.ctx, item)),
    );
    return text.split("\n").map(normalizeLine).filter((l) => l !== "").sort().join("\n");
  }).sort();
}

/**
 * Whether two route trees hold the same statements (see {@link statementShape}).
 *
 * @param a One tree's source.
 * @param b The other's.
 * @returns True when they differ at most in order and style.
 */
async function sameRouteTree(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([statementShape(a), statementShape(b)]);
  return x !== null && y !== null && x.length === y.length && x.every((s, i) => s === y[i]);
}

/**
 * Put the committed tree back when the generator rewrote it with the same routes.
 *
 * @param path The generated tree's path.
 * @param before Its text before the generator ran (null: there was none).
 * @returns Whether the committed text was restored.
 */
export async function keepCommittedRouteTree(
  path: string,
  before: string | null,
): Promise<boolean> {
  if (before === null) return false;
  let after: string;
  try {
    after = await Deno.readTextFile(path);
  } catch {
    return false;
  }
  if (after === before || !await sameRouteTree(before, after)) return false;
  await Deno.writeTextFile(path, before);
  return true;
}
