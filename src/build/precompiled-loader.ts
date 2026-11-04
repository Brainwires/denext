// The production server's loader over the server copies the build compiled
// (./use-cache-loader.ts writes them, ./server-copies.ts records them): no walk, no compile, no
// write. Its own module so the production server (and a compiled app) loads it without the
// compiler.

import { resolve, toFileUrl } from "@std/path";
import type { ModuleLoader } from "../server/types.ts";

/** Normalize a file path or `file:` URL to a `file:` URL string. */
export function toUrl(filePath: string): string {
  return filePath.startsWith("file:") ? filePath : toFileUrl(filePath).href;
}

/**
 * A module URL spelled through the project root: a crawl names modules by their real path (a
 * boundary ref under macOS's `/private/var` for a project in `/var`), while redirects and copies
 * are keyed by the root as given.
 */
export function projectSpelling(projectDir: string): (url: string) => string {
  const root = toFileUrl(resolve(projectDir)).href + "/";
  let real: string | null = null;
  try {
    real = toFileUrl(Deno.realPathSync(projectDir)).href + "/";
  } catch { /* no project dir on disk: nothing to respell */ }
  return (url) =>
    real && real !== root && url.startsWith(real) ? root + url.slice(real.length) : url;
}

/**
 * A loader over copies `compileServerCopies` (./use-cache-loader.ts) wrote at build time (`denext start`):
 * each module loads its target's variant, through its copy when it has one, with no walk, no
 * compile and no write.
 *
 * @param base The underlying loader.
 * @param opts The project root, the target's redirects and the copies (file URL → copy URL).
 */
export function createPrecompiledLoader(
  base: ModuleLoader,
  opts: {
    projectDir: string;
    redirects: Readonly<Record<string, string>>;
    copies: Readonly<Record<string, string>>;
  },
): ModuleLoader {
  const canonical = projectSpelling(opts.projectDir);
  return (filePath: string): Promise<unknown> => {
    const url = canonical(toUrl(filePath));
    const target = opts.redirects[url] ?? url;
    return base(opts.copies[target] ?? target);
  };
}
