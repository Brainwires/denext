// The AppImage a Linux package script builds from a finished bundle: the AppDir (the bundle, its
// `.desktop` entry and icon at the root and under `usr/share/`, the AppStream metainfo, an
// `AppRun` that launches with the app id) wrapped by `appimagetool` around the pinned type2
// runtime.
//
// `appimagetool` downloads the AppImage runtime it prepends from type2-runtime's moving
// `continuous` release unless it is given one, so the same project built twice could ship two
// different runtimes, neither checked. denext pins a tagged release by SHA-256
// (`appimage-runtime-pin.json`), downloads it once into the toolchain cache beside the managed
// Deno (`<DENO_DIR>/denext-deno/appimage-runtime/<version>/linux-<arch>/runtime`, verified like the
// toolchain itself: a digest mismatch fails the build) and passes it as `--runtime-file`.
//
// An AppImage carries no GTK or WebKitGTK: the webview backend needs WebKitGTK 4.1 and GTK 3 on
// the host, a CEF build only the usual system libraries. The metainfo lists them
// ({@linkcode appImageRequires}).

import { join } from "@std/path";
import type {
  CacheSlot,
  DenoToolchainArtifact,
  EnsureDenoToolchainOptions,
} from "./deno-toolchain.ts";
import {
  type BuildLinuxPackageOptions,
  type DesktopPackageMeta,
  linuxBuildTime,
  linuxHostLibraries,
} from "./desktop-installers.ts";
import { appStreamDate, bundleDesktopEntryName, linuxMetainfo } from "./desktop-linux-entry.ts";
import pinJson from "./appimage-runtime-pin.json" with { type: "json" };

/** The pinned AppImage type2 runtime (`appimage-runtime-pin.json`). */
export interface AppImageRuntimePin {
  readonly schema: 1;
  /** The type2-runtime release tag (`20251108`; never `continuous`). */
  readonly version: string;
  readonly tag?: string;
  readonly repository?: string;
  /** When the release was published. */
  readonly published?: string;
  /** Per target (`linux-x86_64`, `linux-aarch64`): the bare runtime file. */
  readonly targets: Readonly<Record<string, DenoToolchainArtifact>>;
}

/** The AppImage runtime denext pins. */
export const APPIMAGE_RUNTIME_PIN: AppImageRuntimePin = pinJson as AppImageRuntimePin;

/** Options for {@linkcode ensureAppImageRuntime}. */
export interface AppImageRuntimeOptions
  extends Pick<EnsureDenoToolchainOptions, "cacheRoot" | "fetch" | "log"> {
  /** Defaults to {@linkcode APPIMAGE_RUNTIME_PIN}. */
  readonly pin?: AppImageRuntimePin;
}

/** The pin key of a bundle arch. */
function runtimeTarget(arch: "x86_64" | "arm64"): string {
  return arch === "arm64" ? "linux-aarch64" : "linux-x86_64";
}

/**
 * The pinned AppImage runtime for `arch`, downloaded on first use into the toolchain cache and
 * SHA-256-verified (a cached copy is re-checked against its stamp). Fails closed: a download
 * whose digest differs from the pin throws `DenoToolchainHashError` and nothing is cached.
 *
 * @param arch The bundle's CPU architecture.
 * @param options Seams (cache root, `fetch`, log, pin).
 * @returns The runtime file's path, for `appimagetool --runtime-file`.
 * @throws {DenoToolchainUnavailableError} When the pin has no runtime for `arch`.
 */
export async function ensureAppImageRuntime(
  arch: "x86_64" | "arm64",
  options: AppImageRuntimeOptions = {},
): Promise<string> {
  // Loaded on use: only a package run building an AppImage needs the toolchain cache.
  const { denoToolchainCacheRoot, DenoToolchainUnavailableError, ensureCached } = await import(
    "./deno-toolchain.ts"
  );
  const pin = options.pin ?? APPIMAGE_RUNTIME_PIN;
  const target = runtimeTarget(arch);
  const artifact = pin.targets[target];
  if (!artifact) {
    throw new DenoToolchainUnavailableError(
      `denext: the pinned AppImage runtime ${pin.version} has no build for ${target}`,
    );
  }
  const root = options.cacheRoot ?? denoToolchainCacheRoot();
  const slot: CacheSlot = {
    root,
    dir: join(root, "appimage-runtime", pin.version, target),
    exe: "runtime",
    os: "linux",
    version: pin.version,
    target,
    artifact,
    what: "AppImage runtime",
    offlineHint: "Build the AppImage once while online: the runtime is cached after that.",
  };
  await ensureCached(slot, options);
  return join(slot.dir, slot.exe);
}

/**
 * The shared libraries an AppImage of the app needs on the host: its backend's (WebKitGTK 4.1 and
 * GTK 3 for the webview backend; CEF's system libraries), libsecret with the secure store, then
 * `desktop.linux.appImage.requires`.
 *
 * @param meta The package metadata.
 * @returns The sonames, deduplicated.
 */
export function appImageRequires(meta: DesktopPackageMeta): string[] {
  return [...new Set([...linuxHostLibraries(meta), ...(meta.appImageRequires ?? [])])];
}

/** Runs a tool; throws on a non-zero exit. */
export type AppImageToolRunner = (
  cmd: string,
  args: string[],
  env: Record<string, string>,
) => Promise<void>;

/** What {@linkcode buildDesktopAppImage} builds. */
export interface BuildDesktopAppImageOptions extends BuildLinuxPackageOptions {
  /** The runtime to prepend (default: the pinned one, {@linkcode ensureAppImageRuntime}). */
  readonly runtimeFile?: string;
  /** The `appimagetool` to run (default `appimagetool` on PATH). */
  readonly appimagetool?: string;
  /** The metainfo's release date (default: `SOURCE_DATE_EPOCH`'s, else today's). */
  readonly date?: string;
  /** Runs `appimagetool` (test seam; default `Deno.Command` with inherited stdio). */
  readonly run?: AppImageToolRunner;
}

/** {@linkcode AppImageToolRunner} on `Deno.Command`. */
const runTool: AppImageToolRunner = async (cmd, args, env) => {
  const { code } = await new Deno.Command(cmd, { args, env, stdout: "inherit", stderr: "inherit" })
    .output();
  if (code !== 0) throw new Error(`command failed (${code}): ${cmd} ${args.join(" ")}`);
};

/** Copy `src` into `dest` (a fresh directory), keeping modes and links. */
async function copyDir(src: string, dest: string): Promise<void> {
  await Deno.mkdir(dest, { recursive: true });
  for await (const e of Deno.readDir(src)) {
    const from = join(src, e.name);
    const to = join(dest, e.name);
    if (e.isSymlink) await Deno.symlink(await Deno.readLink(from), to);
    else if (e.isDirectory) await copyDir(from, to);
    else {
      await Deno.copyFile(from, to);
      const mode = (await Deno.stat(from)).mode;
      if (mode !== null && Deno.build.os !== "windows") await Deno.chmod(to, mode & 0o777);
    }
  }
}

/** The AppDir's `AppRun`: the launcher, with the app id the `.desktop` entry's window class matches. */
function appRun(exe: string, id: string, singleInstance: boolean): string {
  return [
    "#!/bin/sh",
    'HERE=$(dirname "$(readlink -f "$0")")',
    `export LAUFEY_APP_ID="\${LAUFEY_APP_ID:-${id}}"`,
    ...(singleInstance ? ['export LAUFEY_SINGLE_INSTANCE="${LAUFEY_SINGLE_INSTANCE:-1}"'] : []),
    `exec "$HERE/${exe}" "$@"`,
    "",
  ].join("\n");
}

/**
 * Build an AppImage from a finished Linux bundle (its `.desktop` entry already rewritten by
 * `buildDesktopBundle`): the AppDir holds the bundle, the entry at the root and as
 * `usr/share/applications/<id>.desktop`, the icon as `<id>.png` / `.svg` and `.DirIcon`, the
 * AppStream metainfo `usr/share/metainfo/<id>.metainfo.xml` (with the host libraries,
 * {@linkcode appImageRequires}) and an `AppRun` that execs the launcher with `LAUFEY_APP_ID`;
 * `appimagetool --runtime-file` wraps it around the pinned runtime ({@linkcode ensureAppImageRuntime}),
 * with `ARCH` set for the target.
 *
 * @param o The bundle, metadata and output.
 * @returns The AppImage's path.
 * @throws {Error} When the bundle has no `.desktop` entry (appimagetool needs one).
 */
export async function buildDesktopAppImage(o: BuildDesktopAppImageOptions): Promise<string> {
  const entry = await bundleDesktopEntryName(o.bundleDir);
  if (entry === null) {
    throw new Error(
      `cannot build the AppImage: ${o.bundleDir} has no .desktop entry (set desktop.app.identifier)`,
    );
  }
  const id = entry.slice(0, -".desktop".length);
  const runtime = o.runtimeFile ?? await ensureAppImageRuntime(o.arch);
  const appDir = `${o.out.replace(/\.AppImage$/i, "")}.AppDir`;
  await Deno.remove(appDir, { recursive: true }).catch(() => {});
  try {
    await copyDir(o.bundleDir, appDir);
    const apps = join(appDir, "usr", "share", "applications");
    await Deno.mkdir(apps, { recursive: true });
    await Deno.copyFile(join(appDir, entry), join(apps, entry));
    for (const ext of ["png", "svg"]) {
      const icon = join(appDir, `${id}.${ext}`);
      if (!(await Deno.stat(icon).catch(() => null))?.isFile) continue;
      await Deno.remove(join(appDir, ".DirIcon")).catch(() => {});
      await Deno.copyFile(icon, join(appDir, ".DirIcon"));
      break;
    }
    const metainfo = join(appDir, "usr", "share", "metainfo");
    await Deno.mkdir(metainfo, { recursive: true });
    await Deno.writeTextFile(
      join(metainfo, `${id}.metainfo.xml`),
      linuxMetainfo(o.meta, {
        id,
        desktopId: entry,
        date: o.date ?? appStreamDate(linuxBuildTime()),
        requires: appImageRequires(o.meta),
      }),
    );
    await Deno.writeTextFile(join(appDir, "AppRun"), appRun(o.exe, id, o.meta.singleInstance));
    if (Deno.build.os !== "windows") await Deno.chmod(join(appDir, "AppRun"), 0o755);
    await Deno.remove(o.out).catch(() => {});
    await (o.run ?? runTool)(
      o.appimagetool ?? "appimagetool",
      ["--runtime-file", runtime, appDir, o.out],
      { ARCH: o.arch === "arm64" ? "aarch64" : "x86_64" },
    );
  } finally {
    await Deno.remove(appDir, { recursive: true }).catch(() => {});
  }
  return o.out;
}
