#!/usr/bin/env -S deno run -A
/**
 * Package this `deno desktop` app for macOS distribution: build (for one or more
 * architectures), code-sign, optionally notarize + staple, and wrap each .app in its installers.
 * Run on a macOS host.
 *
 *   deno run -A scripts/package-macos.ts [--arch <mode>] [--no-export] [--format <list>]
 *
 * --arch  host | arm64 | x86_64 | both | universal   (default: host)
 *           host      the machine's own architecture
 *           arm64     Apple Silicon (aarch64-apple-darwin)
 *           x86_64    Intel (x86_64-apple-darwin)
 *           both      arm64 AND x86_64 as two separate .app bundles
 *           universal one .app whose binaries are lipo-merged (runs natively on both)
 * --no-export  skip `deno task export` and reuse the existing out/ (faster iteration)
 * --format     installers to build beside each .app, comma-separated: dmg, pkg. Default: the
 *              denext.config.ts `desktop.installers.macos` list, else dmg.
 *                dmg  a drag-to-Applications disk image (hdiutil)
 *                pkg  an installer package for MDM / `installer -pkg` (productbuild)
 * --dmg        add a .dmg to whatever --format / the config asks for
 *
 * Signing / notarization are driven by env vars (nothing secret is hard-coded):
 *   DENEXT_CODESIGN_IDENTITY  "Developer ID Application: Name (TEAMID)". REQUIRED to
 *                             distribute. Omit → an ad-hoc signature (dev/local only;
 *                             Gatekeeper will block it on other Macs).
 *   DENEXT_ENTITLEMENTS       path to an entitlements .plist (optional).
 *   DENEXT_NOTARY_PROFILE     a `xcrun notarytool store-credentials` keychain profile.
 *                             Set (with a real identity) → notarize + staple each app (and
 *                             each signed .pkg).
 *   DENEXT_INSTALLER_IDENTITY "Developer ID Installer: Name (TEAMID)" — signs the .pkg.
 *                             Omit → an unsigned .pkg (MDM tools and Gatekeeper reject it).
 *   DENEXT_APP_NAME           output base name (default: `desktop.app.name` in denext.config.ts,
 *                             else deno.json's).
 *
 * The bundle's name and identifier are `desktop.app.name` / `identifier` in denext.config.ts
 * (written into deno.json's `desktop.app`, which `deno desktop` reads), and its icon
 * `desktop.app.icons.macos` (.icns or .png), else deno.json's, else icons/app.icns.
 *
 * Builds on denext's pinned Deno Desktop runtime (custom app origin, per-app storage, deep links,
 * single instance), downloaded once into the Deno cache and SHA-256-verified; it needs the exact
 * Deno version it was built for (`deno upgrade --version 2.9.7`).
 *   DENEXT_DESKTOP_RUNTIME=stock     use the stock runtime instead (none of the above works)
 *   DENEXT_DESKTOP_RUNTIME_DIR=<dir> use a local runtime build (unverified; runtime development)
 *   DENEXT_DESKTOP_RUNTIME_VERIFY=1  re-hash the cached runtime before use
 *   DENEXT_DESKTOP_RUNTIME_ATTEST=1  also check a fresh download's build provenance (needs gh)
 *
 * Outputs into ./dist/.
 *
 * See the "Distributing a macOS desktop app" doc for the full setup (creating a
 * Developer ID Application certificate, storing notarytool credentials, Gatekeeper).
 */

import {
  desktopAppName as appName,
  desktopDenoFlagArgs,
  desktopIconArgs,
  desktopIncludeArgs,
  desktopInstallerPlan,
  type DesktopPackageArgs,
  desktopPackageFlags,
  desktopRun as run,
  desktopRuntimeEnv,
  parseDesktopPackageArgs,
  syncDesktopAppConfig,
  writeLaufeyLaunchConfig,
} from "denext/desktop";

const TARGETS: Record<string, string> = {
  arm64: "aarch64-apple-darwin",
  x86_64: "x86_64-apple-darwin",
};

type Opts = DesktopPackageArgs;

/** Build a single .app for `target` (undefined = host arch). deno desktop signs it
 * ad-hoc; the caller re-signs with the real identity afterwards. */
async function buildApp(out: string, target?: string): Promise<void> {
  await Deno.remove(out, { recursive: true }).catch(() => {});
  const cmd = [
    "deno",
    "desktop",
    // Baked least-privilege flags mean an unbaked permission should fail fast, not block on a
    // prompt the packaged GUI has no TTY to answer.
    "--no-prompt",
    ...await desktopPackageFlags(import.meta.url, "darwin"),
    // desktop.denoFlags in denext.config.ts (e.g. --node-modules-dir=none for a pnpm workspace).
    ...await desktopDenoFlagArgs(import.meta.url),
    "--include",
    "out",
    ...await desktopIncludeArgs(import.meta.url),
  ];
  if (target) cmd.push("--target", target);
  // The app icon: desktop.app.icons.macos in denext.config.ts, else deno.json's, else
  // icons/app.icns, icons/app.png or desktop-icon.png.
  cmd.push(...await desktopIconArgs(import.meta.url, "darwin"));
  // deno desktop appends ".app" to --output on macOS, so pass the base name (strip a trailing
  // ".app") to land exactly at `out` — else it writes `out.app` and sign/lipo/dmg miss it.
  cmd.push("--output", out.replace(/\.app$/, ""), "desktop.ts");
  // DENORT_DESKTOP_BIN + LAUFEY_DEV_DIR: denext's pinned runtime for this target (verified, cached).
  await run(cmd, await desktopRuntimeEnv(import.meta.url, target));
  // The webview backend's launch settings (app id, the origin's custom scheme, single instance),
  // read from Contents/Resources at launch. Writing into the bundle breaks deno desktop's ad-hoc
  // seal, so a bundle that got one is always re-signed.
  if (await writeLaufeyLaunchConfig(import.meta.url, "darwin", out)) {
    resealNeeded = true;
  }
}

/** Set when a bundle was modified after `deno desktop` signed it (see buildApp). */
let resealNeeded = false;

/** List the Mach-O files inside a .app bundle (executables + dylibs). */
async function machOFiles(app: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of walk(`${app}/Contents`)) {
    if (!e.isFile) continue;
    const probe = await new Deno.Command("lipo", {
      args: ["-archs", e.path],
      stdout: "null",
      stderr: "null",
    }).output();
    if (probe.code === 0) out.push(e.path);
  }
  return out;
}

async function* walk(
  dir: string,
): AsyncGenerator<{ path: string; isFile: boolean }> {
  for await (const e of Deno.readDir(dir)) {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory) yield* walk(path);
    else yield { path, isFile: e.isFile };
  }
}

/** Merge two same-layout .apps into one universal .app at `dest` (lipo per Mach-O). */
async function mergeUniversal(
  armApp: string,
  x86App: string,
  dest: string,
): Promise<void> {
  await Deno.remove(dest, { recursive: true }).catch(() => {});
  await run(["cp", "-R", armApp, dest]);
  for (const file of await machOFiles(dest)) {
    const rel = file.slice(dest.length);
    await run([
      "lipo",
      "-create",
      `${armApp}${rel}`,
      `${x86App}${rel}`,
      "-output",
      file,
    ]);
  }
}

/** The bundle's main executable path (from Info.plist CFBundleExecutable). */
async function mainExecutable(app: string): Promise<string> {
  const p = await new Deno.Command("plutil", {
    args: [
      "-extract",
      "CFBundleExecutable",
      "raw",
      "-o",
      "-",
      `${app}/Contents/Info.plist`,
    ],
    stdout: "piped",
    stderr: "null",
  }).output();
  const name = new TextDecoder().decode(p.stdout).trim();
  // Fail loudly rather than returning an empty basename: an empty name would never
  // match in the sign loop's `file === mainExe` guard, so the main executable would be
  // signed twice (the second time without entitlements) — a silent invariant break.
  if (!p.success || !name) {
    throw new Error(
      `could not read CFBundleExecutable from ${app}/Contents/Info.plist`,
    );
  }
  return `${app}/Contents/MacOS/${name}`;
}

/** Code-sign a .app inside-out. With an identity: Hardened Runtime + secure timestamp
 * (required for notarization). Without one: an ad-hoc signature (dev/local only). */
async function sign(
  app: string,
  identity: string | undefined,
  entitlements?: string,
): Promise<void> {
  const id = identity ?? "-";
  const ts = identity ? "--timestamp" : "--timestamp=none";
  const mainExe = await mainExecutable(app);
  // Nested Mach-O (dylibs/helpers) first; then the bundle, which signs the main
  // executable and applies the entitlements.
  for (const file of await machOFiles(app)) {
    if (file === mainExe) continue;
    await run([
      "codesign",
      "--force",
      ts,
      "--options",
      "runtime",
      "-s",
      id,
      file,
    ]);
  }
  const ent = identity && entitlements ? ["--entitlements", entitlements] : [];
  await run([
    "codesign",
    "--force",
    ts,
    "--options",
    "runtime",
    ...ent,
    "-s",
    id,
    app,
  ]);
  await run(["codesign", "--verify", "--deep", "--strict", app]);
}

/** Notarize + staple a .app (requires a real identity + a notarytool keychain profile). */
async function notarize(app: string, profile: string): Promise<void> {
  const zip = `${app}.zip`;
  try {
    await run(["ditto", "-c", "-k", "--keepParent", app, zip]);
    await run([
      "xcrun",
      "notarytool",
      "submit",
      zip,
      "--keychain-profile",
      profile,
      "--wait",
    ]);
    await run(["xcrun", "stapler", "staple", app]);
  } finally {
    // Remove the submission zip even if notarytool/staple failed.
    await Deno.remove(zip).catch(() => {});
  }
}

async function makeDmg(app: string): Promise<string> {
  const dmg = app.replace(/\.app$/, ".dmg");
  await Deno.remove(dmg).catch(() => {});
  await run([
    "hdiutil",
    "create",
    "-volname",
    app.split("/").pop()!.replace(/\.app$/, ""),
    "-srcfolder",
    app,
    "-ov",
    "-format",
    "UDZO",
    dmg,
  ]);
  return dmg;
}

/** Wrap a .app in an installer package (productbuild) that installs it into /Applications;
 * signed with the Developer ID Installer identity, and notarized + stapled with a notary profile. */
async function makePkg(app: string, s: Signing): Promise<string> {
  const pkg = app.replace(/\.app$/, ".pkg");
  await Deno.remove(pkg).catch(() => {});
  const sign = s.installerIdentity ? ["--sign", s.installerIdentity] : [];
  await run([
    "productbuild",
    ...sign,
    "--component",
    app,
    "/Applications",
    pkg,
  ]);
  if (s.installerIdentity && s.notaryProfile) {
    await run([
      "xcrun",
      "notarytool",
      "submit",
      pkg,
      "--keychain-profile",
      s.notaryProfile,
      "--wait",
    ]);
    await run(["xcrun", "stapler", "staple", pkg]);
  } else if (!s.installerIdentity) {
    console.warn(
      `  ${pkg}: unsigned (set DENEXT_INSTALLER_IDENTITY to a "Developer ID Installer" identity).`,
    );
  }
  return pkg;
}

/** The signing setup, from env (nothing secret is hard-coded). */
interface Signing {
  identity: string | undefined;
  entitlements: string | undefined;
  notaryProfile: string | undefined;
  /** "Developer ID Installer: …" for the .pkg. */
  installerIdentity: string | undefined;
}

function signingFromEnv(): Signing {
  const identity = Deno.env.get("DENEXT_CODESIGN_IDENTITY") || undefined;
  const notaryProfile = Deno.env.get("DENEXT_NOTARY_PROFILE") || undefined;
  if (!identity) {
    console.warn(
      "⚠  DENEXT_CODESIGN_IDENTITY is unset → ad-hoc signature only. The app runs\n" +
        "   locally but Gatekeeper will block it on other Macs. Set a\n" +
        '   "Developer ID Application: … (TEAMID)" identity to distribute.',
    );
  }
  if (notaryProfile && !identity) {
    throw new Error(
      "notarization needs DENEXT_CODESIGN_IDENTITY (a real Developer ID identity).",
    );
  }
  return {
    identity,
    entitlements: Deno.env.get("DENEXT_ENTITLEMENTS") || undefined,
    notaryProfile,
    installerIdentity: Deno.env.get("DENEXT_INSTALLER_IDENTITY") || undefined,
  };
}

/** One .app whose binaries are lipo-merged from an arm64 and an x86_64 build. */
async function buildUniversal(name: string): Promise<string> {
  const arm = "dist/.tmp-arm64.app";
  const x86 = "dist/.tmp-x86_64.app";
  try {
    await buildApp(arm, TARGETS.arm64);
    await buildApp(x86, TARGETS.x86_64);
    const uni = `dist/${name}.app`;
    await mergeUniversal(arm, x86, uni);
    return uni;
  } finally {
    // Always clear the per-arch temp bundles (hundreds of MB each) — even if a
    // build/merge threw partway, so a failed run doesn't litter dist/.
    await Deno.remove(arm, { recursive: true }).catch(() => {});
    await Deno.remove(x86, { recursive: true }).catch(() => {});
  }
}

/** Build the .app bundle(s) for the requested arch mode; returns their paths. */
async function buildArtifacts(opts: Opts, name: string): Promise<string[]> {
  if (opts.arch === "universal") return [await buildUniversal(name)];
  if (opts.arch === "both") {
    const artifacts: string[] = [];
    for (const a of ["arm64", "x86_64"] as const) {
      const app = `dist/${name}-${a}.app`;
      await buildApp(app, TARGETS[a]);
      artifacts.push(app);
    }
    return artifacts;
  }
  const app = `dist/${name}.app`;
  await buildApp(app, opts.arch === "host" ? undefined : TARGETS[opts.arch]);
  return [app];
}

/**
 * Sign, notarize and wrap each bundle in its installers; returns the installer paths. A
 * lipo-merged (universal) bundle always needs re-signing; for others we re-sign only when a real
 * identity is provided (deno desktop already applied ad-hoc).
 */
async function finishArtifacts(
  artifacts: string[],
  opts: Opts,
  formats: string[],
  s: Signing,
): Promise<string[]> {
  const installers: string[] = [];
  for (const app of artifacts) {
    if (s.identity || opts.arch === "universal" || resealNeeded) {
      await sign(app, s.identity, s.entitlements);
    }
    if (s.notaryProfile && s.identity) await notarize(app, s.notaryProfile);
    if (formats.includes("dmg")) installers.push(await makeDmg(app));
    if (formats.includes("pkg")) installers.push(await makePkg(app, s));
  }
  return installers;
}

function distributionNote(s: Signing): string {
  if (!s.identity) {
    return "  (ad-hoc — not distributable; see the macOS distribution doc)";
  }
  if (!s.notaryProfile) {
    return "  (signed, NOT notarized — set DENEXT_NOTARY_PROFILE to notarize)";
  }
  return "  (signed + notarized + stapled — ready to distribute)";
}

async function main(): Promise<void> {
  if (Deno.build.os !== "darwin") {
    console.error(
      "package-macos.ts must run on macOS (it shells out to codesign/notarytool).",
    );
    Deno.exit(1);
  }
  const opts = parseDesktopPackageArgs(Deno.args, {
    arches: ["host", "arm64", "x86_64", "both", "universal"],
    legacy: { "--dmg": "dmg" },
  });
  const signing = signingFromEnv();
  // DENEXT_APP_NAME, else desktop.app.name in denext.config.ts, else deno.json's.
  const name = await appName(import.meta.url);
  // --format, else desktop.installers.macos in denext.config.ts, else a .dmg.
  const plan = await desktopInstallerPlan(
    import.meta.url,
    "darwin",
    opts.formats,
    opts.add,
  );
  // .deno-desktop/app.json (the app origin + identifier) and its deno.json compile.include.
  await syncDesktopAppConfig(import.meta.url);
  if (opts.export) await run(["deno", "task", "export"]);
  await Deno.mkdir("dist", { recursive: true });
  const artifacts = await buildArtifacts(opts, name);
  const installers = await finishArtifacts(
    artifacts,
    opts,
    plan.formats,
    signing,
  );
  console.log("\n✓ Packaged:");
  for (const a of [...artifacts, ...installers]) console.log("  " + a);
  console.log(distributionNote(signing));
}

if (import.meta.main) await main();
