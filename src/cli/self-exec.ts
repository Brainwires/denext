// How the CLI re-runs ITSELF in a child `deno run` (the CSS import-map re-exec and the
// server-side-npm re-exec), for a local checkout, a JSR / https install, or a compiled binary.

import { fromFileUrl, join } from "@std/path";

/** The config file names a Deno project may use, in resolution order. */
const CONFIG_NAMES = ["deno.json", "deno.jsonc"] as const;

/** A `jsr:@denext/denext@<version>` specifier, however the import map spells it. */
const DENEXT_SPEC = /^jsr:@denext\/denext@([^/]+)/;

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

/**
 * The denext version the project at `dir` pins in its import map, as a runnable CLI specifier.
 *
 * A compiled binary carries one framework version; a project pins its own. When they differ the
 * binary must not build the app with its own copy — the project's pin decides, so the module
 * verbs re-exec that version's CLI. Outside a project (no config, or no `denext` import) there
 * is nothing to defer to and the binary's own framework is correct.
 *
 * Reading the config synchronously is deliberate: every caller is on the verge of spawning a
 * `deno` process, so a few microseconds of file I/O is noise against it, and it keeps
 * {@link ../ui/proc.ts | `cliInvocation`} — which assembles argv on the UI's request path — an
 * ordinary synchronous function rather than forcing four call sites to become async.
 *
 * @param dir The project directory.
 * @returns `jsr:@denext/denext@<version>/cli`, or null when the directory pins no denext. The
 * version is passed through verbatim, range operator included, so the child resolves exactly
 * what the project asked for; {@linkcode samePin} compares it to a concrete version.
 */
export function pinnedDenextCli(dir: string): string | null {
  for (const name of CONFIG_NAMES) {
    let source: string;
    try {
      source = Deno.readTextFileSync(join(dir, name));
    } catch {
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(source);
    } catch {
      return null; // a malformed config pins nothing we can trust
    }
    const imports = (data as { imports?: Record<string, unknown> } | null)?.imports;
    const spec = typeof imports?.denext === "string" ? imports.denext : null;
    const version = spec === null ? null : DENEXT_SPEC.exec(spec)?.[1];
    return version ? `jsr:@denext/denext@${version}/cli` : null;
  }
  return null;
}

/**
 * Whether a pinned CLI specifier names `version`, ignoring the range operator a project writes
 * (`^2.5.0` and `2.5.0` are the same pin here). A scaffolded project pins `^<version>`, so
 * comparing the raw specifiers would make a binary re-exec itself for its own version.
 *
 * @param cli A specifier from {@linkcode pinnedDenextCli}.
 * @param version The concrete version to compare against.
 * @returns Whether they name the same version.
 */
export function samePin(cli: string, version: string): boolean {
  const pinned = DENEXT_SPEC.exec(cli)?.[1];
  return pinned !== undefined && pinned.replace(/^[\^~=<>]+/, "") === version;
}
