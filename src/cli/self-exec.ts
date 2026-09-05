// How the CLI re-runs ITSELF in a child `deno run` (the CSS import-map re-exec and the
// server-side-npm re-exec), for a local checkout, a JSR / https install, or a compiled binary.

import { fromFileUrl } from "@std/path";

/** True only inside a `deno compile`d standalone binary (never for JSR/remote/file runs). */
export function isStandaloneBinary(): boolean {
  return (Deno.build as { standalone?: boolean }).standalone === true;
}

/**
 * The argument that re-runs the CLI module at `moduleUrl` in a child `deno run`: a
 * filesystem path for a local checkout, and the module URL itself for a JSR / https
 * install — Deno runs remote entrypoints directly, so a re-exec works from either.
 */
export function entrypointArg(moduleUrl: string): string {
  return moduleUrl.startsWith("file://") ? fromFileUrl(moduleUrl) : moduleUrl;
}
