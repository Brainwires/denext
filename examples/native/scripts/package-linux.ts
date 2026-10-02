#!/usr/bin/env -S deno run -A
/**
 * Package this `deno desktop` app for Linux distribution. `deno desktop` produces a
 * complete bundle directory (the executable, its `.so`, and a freedesktop `.desktop`
 * launcher); this builds one or both arches and wraps each in its installers.
 *
 *   deno run -A scripts/package-linux.ts [--arch <mode>] [--no-export] [--format <list>]
 *
 * --arch  host | x86_64 | arm64 | both   (default: host)
 *           host    the machine's own architecture (x86_64 when cross-building from macOS Intel)
 *           x86_64  x86_64-unknown-linux-gnu
 *           arm64   aarch64-unknown-linux-gnu
 *           both    x86_64 AND arm64 as two bundles
 * --no-export  skip `deno task export` and reuse the existing out/ (faster iteration)
 * --format     installers per arch, comma-separated: tar.gz, deb, rpm, appimage. Default: the
 *              denext.config.ts `desktop.installers.linux` list, else tar.gz,deb.
 *                tar.gz    the bundle directory
 *                deb       Debian/Ubuntu package (built by denext; no tool needed)
 *                rpm       Fedora/RHEL/openSUSE package (needs `rpmbuild`)
 *                appimage  a single-file AppImage (needs `appimagetool`)
 *              The .deb/.rpm install to /usr/lib/<app>, link /usr/bin/<app>, and register the
 *              launcher, the icon and the deno.json `desktop.app.deepLinks` schemes. A default
 *              format whose tool is missing is skipped with a warning; one you asked for fails.
 * --appimage   add an AppImage to whatever --format / the config asks for
 *
 *   DENEXT_APP_NAME  output base name (default: the deno.json `desktop.app.name`).
 *   deno.json `version` is the package version; denext.config.ts `desktop.installers`
 *   `publisher` / `description` fill the package metadata.
 *
 * Builds on denext's pinned Deno Desktop runtime (custom app origin, per-app storage, deep links,
 * single instance), downloaded once into the Deno cache and SHA-256-verified; it needs the exact
 * Deno version it was built for (`deno upgrade --version 2.9.7`).
 *   DENEXT_DESKTOP_RUNTIME=stock     use the stock runtime instead (none of the above works)
 *   DENEXT_DESKTOP_RUNTIME_DIR=<dir> use a local runtime build (unverified; runtime development)
 *   DENEXT_DESKTOP_RUNTIME_VERIFY=1  re-hash the cached runtime before use
 *   DENEXT_DESKTOP_RUNTIME_ATTEST=1  also check a fresh download's build provenance (needs gh)
 *
 * The end user's Linux desktop needs a WebKitGTK runtime (webkit2gtk) for the window;
 * that is a deploy-environment dependency, not baked into the bundle. Outputs into ./dist/.
 */

import {
  buildDesktopBundle,
  buildDesktopDeb,
  buildDesktopRpm,
  desktopPackageArches,
  type DesktopPackageMeta,
  desktopRequireTool,
  desktopRun as run,
  parseDesktopPackageArgs,
  prepareDesktopPackage,
} from "denext/desktop";

const TARGETS: Record<string, string> = {
  x86_64: "x86_64-unknown-linux-gnu",
  arm64: "aarch64-unknown-linux-gnu",
};
// Underscore-free labels for output paths: `deno desktop` derives a reverse-DNS bundle id
// from the output basename and rejects '_' (so a raw `x86_64` suffix drops the .desktop file).
const LABELS: Record<string, string> = { x86_64: "x64", arm64: "arm64" };
const OS = "linux";

/** Build a Linux bundle directory for `arch` at dist/<name>-<label> (PNG icon). */
async function buildBundle(name: string, arch: "x86_64" | "arm64"): Promise<string> {
  return await buildDesktopBundle(import.meta.url, OS, {
    target: TARGETS[arch],
    out: `dist/${name}-${LABELS[arch]}`,
    icons: ["icons/app.png", "desktop-icon.png"],
  });
}

/** tar.gz a bundle directory for distribution. */
async function tarball(
  name: string,
  arch: "x86_64" | "arm64",
  dir: string,
): Promise<string> {
  const tgz = `dist/${name}-${LABELS[arch]}-linux.tar.gz`;
  await run(["tar", "czf", tgz, "-C", "dist", dir.replace(/^dist\//, "")]);
  return tgz;
}

/** Build an AppImage for a bundle with appimagetool; returns its path. */
async function appImage(
  name: string,
  arch: "x86_64" | "arm64",
  dir: string,
): Promise<string> {
  const appdir = `${dir}.AppDir`;
  await Deno.remove(appdir, { recursive: true }).catch(() => {});
  await Deno.mkdir(appdir, { recursive: true });
  // AppDir layout: the bundle contents + the .desktop at the root + an AppRun → exe.
  await run(["cp", "-r", `${dir}/.`, appdir]);
  const exe = `${name}-${LABELS[arch]}`;
  await Deno.writeTextFile(
    `${appdir}/AppRun`,
    `#!/bin/sh\nHERE=$(dirname "$0")\nexec "$HERE/${exe}" "$@"\n`,
  );
  await Deno.chmod(`${appdir}/AppRun`, 0o755);
  const outFile = `dist/${name}-${LABELS[arch]}.AppImage`;
  await run(["appimagetool", appdir, outFile]);
  return outFile;
}

/** Wrap one finished bundle in each planned installer; returns their paths. */
async function installers(
  name: string,
  arch: "x86_64" | "arm64",
  dir: string,
  plan: { formats: string[]; explicit: boolean },
  meta: DesktopPackageMeta,
): Promise<string[]> {
  const out: string[] = [];
  const base = `dist/${name}-${LABELS[arch]}`;
  const pkg = { meta, bundleDir: dir, exe: `${name}-${LABELS[arch]}`, arch };
  for (const format of plan.formats) {
    if (format === "tar.gz") out.push(await tarball(name, arch, dir));
    if (format === "deb") out.push(await buildDesktopDeb({ ...pkg, out: `${base}.deb` }));
    if (format === "rpm" && await desktopRequireTool("rpmbuild", ".rpm", plan.explicit)) {
      out.push(await buildDesktopRpm({ ...pkg, out: `${base}.rpm` }));
    }
    if (
      format === "appimage" && await desktopRequireTool("appimagetool", "AppImage", plan.explicit)
    ) {
      out.push(await appImage(name, arch, dir));
    }
  }
  return out;
}

async function main(): Promise<void> {
  const opts = parseDesktopPackageArgs(Deno.args, {
    arches: ["host", "x86_64", "arm64", "both"],
    legacy: { "--appimage": "appimage" },
  });
  // --format, else desktop.installers.linux in denext.config.ts, else tar.gz + deb; the
  // .deno-desktop/app.json sync, the package metadata (name, version, deep links), the export.
  const { name, plan, meta } = await prepareDesktopPackage(import.meta.url, OS, opts);

  const artifacts: string[] = [];
  for (const arch of desktopPackageArches(opts.arch)) {
    const dir = await buildBundle(name, arch);
    artifacts.push(dir, ...await installers(name, arch, dir, plan, meta));
  }

  console.log("\n  Built:");
  for (const a of artifacts) console.log("  " + a);
  console.log(
    "\n  (the target Linux desktop needs a WebKitGTK / webkit2gtk runtime installed)",
  );
}

if (import.meta.main) await main();
