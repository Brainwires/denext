// Directory-segment tests on local paths that hold on every OS. A Windows path separates with
// `\` (a watcher event, `fromFileUrl`, an esbuild `args.path`), so a check for `/node_modules/`
// alone never matches there and treats every dependency as app source.

/**
 * Whether `path` has the directory segment `name` (`node_modules`, `.denext`, `.git`, …),
 * whichever separator the path uses.
 *
 * @param path A local filesystem path.
 * @param name The segment, without separators.
 * @returns `true` when `…/name/…` (or `…\name\…`) appears in the path.
 */
export function hasPathSegment(path: string, name: string): boolean {
  return path.replaceAll("\\", "/").includes(`/${name}/`);
}

/**
 * Whether `path` lies inside a `node_modules` directory.
 *
 * @param path A local filesystem path.
 * @returns `true` for a dependency's file.
 */
export function inNodeModules(path: string): boolean {
  return hasPathSegment(path, "node_modules");
}
