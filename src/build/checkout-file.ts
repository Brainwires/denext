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
 * Whether the module at `url` runs from a denext checkout, by its location alone: a `file:` URL
 * outside a copy of the published package (`vendor/jsr.io/…` reached by path, or JSR's npm
 * compatibility layer under `node_modules/`). A copy carries only the published files — no
 * repository `deno.json` to merge with, no `packages/`, no config of its own a child discovers —
 * so code that treats `file:` as "a checkout" asks this instead.
 *
 * @param url A module URL (`import.meta.url`, the CLI's entry, the framework root).
 * @returns `true` for a checkout's module, `false` for a published, vendored or npm-compat copy.
 */
export function runsFromCheckout(url: string): boolean {
  return url.startsWith("file:") && !PACKAGE_COPY.test(new URL(url).pathname);
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
  if (!runsFromCheckout(base)) return undefined;
  const url = new URL(relative, base);
  return existsOnDisk(url) === false ? undefined : url.href;
}
