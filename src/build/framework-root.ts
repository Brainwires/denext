// Where the running framework lives, in its own scheme. Its own module so the production server
// (and a compiled app) resolves framework files without loading the bundler.

/**
 * The framework root as a URL, in whatever scheme the framework itself runs under:
 * `file://…` from a local checkout, `https://jsr.io/@denext/denext/<ver>/` when a consumer
 * runs the CLI straight from JSR (`deno run -A jsr:@denext/denext/cli …`). Always ends with a
 * slash. This is the scheme-agnostic base — prefer it (+ {@link frameworkFileUrl} /
 * `readFrameworkText` in ./bundle.ts) over `frameworkRoot`, whose filesystem path only exists
 * for a local checkout.
 */
export function frameworkRootUrl(): string {
  return new URL("../../", import.meta.url).href;
}

/** The URL of a file/module under the framework root, in the framework's own scheme. */
export function frameworkFileUrl(relative: string): string {
  return new URL(relative, frameworkRootUrl()).href;
}
