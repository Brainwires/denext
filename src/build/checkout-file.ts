// Whether a framework module runs from a denext checkout, which carries the same commit's
// `packages/` beside `src/`, or from a copy of the published package, which does not.

/** A copy of a published package on disk: a vendored JSR module, or JSR's npm compatibility. */
const PACKAGE_COPY = /\/vendor\/jsr\.io\/|\/node_modules\//;

/**
 * Whether `url` exists on disk: `undefined` when that cannot be told without asking (no read
 * permission granted, which a stat would prompt for), or for an error other than "not found".
 */
function existsOnDisk(url: URL): boolean | undefined {
  try {
    if (Deno.permissions.querySync({ name: "read", path: url }).state !== "granted") {
      return undefined;
    }
    Deno.statSync(url);
    return true;
  } catch (err) {
    return err instanceof Deno.errors.NotFound ? false : undefined;
  }
}

/**
 * The checkout's file `relative` to `base` (a module's `import.meta.url`), as a URL to import, or
 * `undefined` when `base` is not a checkout's module: a published module (`https:`), a vendored
 * one (`"vendor": true` puts `@denext/denext` under `vendor/jsr.io/`, which is `file:` too but has
 * no `packages/`), JSR's npm compatibility layer (`node_modules/`), or any `file:` module whose
 * `relative` file is not there. Where read permission is not granted, the location alone decides.
 *
 * @param relative The file, relative to `base` (`"../../packages/docs-corpus/mod.ts"`).
 * @param base The URL of the module asking.
 * @returns The file's URL, or `undefined` to import the published package instead.
 */
export function checkoutFile(relative: string, base: string): string | undefined {
  if (!base.startsWith("file:")) return undefined;
  if (PACKAGE_COPY.test(new URL(base).pathname)) return undefined;
  const url = new URL(relative, base);
  return existsOnDisk(url) === false ? undefined : url.href;
}
