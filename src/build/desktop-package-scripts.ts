// The packaging scripts `denext create --desktop` / `migrate --desktop` scaffold into a project
// (`scripts/package-{macos,linux,windows}.ts`), moved out of ./scaffold.ts. Not published:
// `deno task gen:native-templates` (scripts/gen-native-templates.ts) packs them, through
// ./native-templates/desktop-package-scripts.ts, into the docs-corpus pack (out of the 20 MiB
// @denext/denext package), which ./scaffold.ts reads. Edit them here, then regenerate.

/** The scaffolded macOS packaging script (scripts/package-macos.ts). Builds one or
 * more arch .apps, code-signs, and (with a Developer ID identity + notarytool profile)
 * notarizes + staples. See the macOS distribution docs. */
export const MACOS_PACKAGE_SCRIPT = `#!/usr/bin/env -S deno run -A
/**
 * Package this \`deno desktop\` app for macOS distribution: build (for one or more
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
 * --no-export  skip \`deno task export\` and reuse the existing out/ (faster iteration)
 * --format     installers to build beside each .app, comma-separated: dmg, pkg. Default: the
 *              denext.config.ts \`desktop.installers.macos\` list, else dmg.
 *                dmg  a drag-to-Applications disk image (hdiutil)
 *                pkg  an installer package for MDM / \`installer -pkg\` (productbuild)
 * --dmg        add a .dmg to whatever --format / the config asks for
 *
 * Signing / notarization are driven by env vars (nothing secret is hard-coded):
 *   DENEXT_CODESIGN_IDENTITY  "Developer ID Application: Name (TEAMID)". REQUIRED to
 *                             distribute. Omit → an ad-hoc signature (dev/local only;
 *                             Gatekeeper will block it on other Macs).
 *   DENEXT_ENTITLEMENTS       path to an entitlements .plist (optional). With an identity
 *                             the main executable, which hosts V8, also gets allow-jit,
 *                             allow-unsigned-executable-memory and disable-library-validation
 *                             unless the plist sets them (to false, too), and the CEF Renderer /
 *                             GPU / Plugin helpers get Chromium's own entitlements.
 *   DENEXT_PROVISIONING_PROFILE  a .provisionprofile to embed (overrides
 *                             \`desktop.macos.provisioningProfile\` in denext.config.ts).
 *   DENEXT_NOTARY_PROFILE     a \`xcrun notarytool store-credentials\` keychain profile.
 *                             Set (with a real identity) → notarize + staple each app (and
 *                             each signed .pkg).
 *   DENEXT_INSTALLER_IDENTITY "Developer ID Installer: Name (TEAMID)" — signs the .pkg.
 *                             Omit → an unsigned .pkg (MDM tools and Gatekeeper reject it).
 *   DENEXT_APP_NAME           output base name (default: \`desktop.app.name\` in denext.config.ts,
 *                             else deno.json's).
 *
 * The bundle's name and identifier are \`desktop.app.name\` / \`identifier\` in denext.config.ts
 * (written into deno.json's \`desktop.app\`, which \`deno desktop\` reads), and its icon
 * \`desktop.app.icons.macos\` (.icns or .png), else deno.json's, else icons/app.icns.
 *
 * \`desktop.macos\` in denext.config.ts adds a provisioning profile (embedded as
 * Contents/embedded.provisionprofile) and entitlements (merged over DENEXT_ENTITLEMENTS's) — what a
 * restricted entitlement such as associated domains (native passkeys) needs. The profile is checked
 * against the app (App ID, team, expiry, the entitlements it grants) before anything is built.
 *
 * Builds on denext's pinned Deno Desktop runtime (custom app origin, per-app storage, deep links,
 * single instance), downloaded once into the Deno cache and SHA-256-verified; it needs the exact
 * Deno version it was built for (\`deno upgrade --version 2.9.8\`).
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

import type { DesktopPackageArgs } from "denext/desktop";

// Load denext/desktop with --node-modules-dir=none, so its own build dependencies (esbuild, ws)
// come from Deno's cache whatever this project's node_modules mode is: in a pnpm workspace
// (nodeModulesDir "manual") Deno would look for them in node_modules, fail, and rewrite the root
// package.json from pnpm-workspace.yaml. The script re-runs itself once under that flag.
if (Deno.env.get("DENEXT_DESKTOP_NPM") !== "none") {
  const age = Deno.env.get("DENEXT_MIN_DEP_AGE");
  const { code } = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--node-modules-dir=none",
      ...(age ? ["--min-dep-age=" + age] : []),
      import.meta.url,
      ...Deno.args,
    ],
    env: { DENEXT_DESKTOP_NPM: "none" },
  }).spawn().status;
  Deno.exit(code);
}

const {
  cefHelperEntitlements,
  desktopAppName: appName,
  desktopDenoFlagArgs,
  desktopExportEnv,
  desktopIconArgs,
  desktopIncludeArgs,
  desktopInstallerPlan,
  desktopMacosSigning,
  desktopNpmArgs,
  desktopPackageFlags,
  desktopRun: run,
  desktopRuntimeDenoFlags,
  desktopRuntimeEnv,
  desktopWithAppVersion,
  macosCodesignArgs,
  macosSigningEntitlements,
  notarytoolSubmitArgs,
  parseDesktopPackageArgs,
  syncDesktopAppConfig,
  V8_ENTITLEMENTS,
  writeLaufeyLaunchConfig,
} = await import("denext/desktop");

const TARGETS: Record<string, string> = {
  arm64: "aarch64-apple-darwin",
  x86_64: "x86_64-apple-darwin",
};

type Opts = DesktopPackageArgs;

/** Build a single .app for \`target\` (undefined = host arch). deno desktop signs it
 * ad-hoc; the caller re-signs with the real identity afterwards. */
async function buildApp(out: string, target?: string): Promise<void> {
  await Deno.remove(out, { recursive: true }).catch(() => {});
  // DENORT_DESKTOP_BIN + LAUFEY_DEV_DIR: denext's pinned runtime for this target (verified, cached).
  const env = await desktopRuntimeEnv(import.meta.url, target);
  // desktop.denoFlags in denext.config.ts (e.g. --node-modules-dir=none for a pnpm workspace).
  const denoFlags = await desktopDenoFlagArgs(import.meta.url);
  const cmd = [
    "deno",
    "desktop",
    // Baked least-privilege flags mean an unbaked permission should fail fast, not block on a
    // prompt the packaged GUI has no TTY to answer.
    "--no-prompt",
    ...await desktopPackageFlags(import.meta.url, "darwin"),
    ...denoFlags,
    // The pinned runtime's own flags (--unstable-no-legacy-abort before 3.0.0-rc.5; none after).
    ...desktopRuntimeDenoFlags(env, denoFlags),
    "--include",
    "out",
    ...await desktopIncludeArgs(import.meta.url),
    // A project with node_modules: embed only the npm packages the entry reaches.
    ...await desktopNpmArgs(import.meta.url),
  ];
  if (target) cmd.push("--target", target);
  // The app icon: desktop.app.icons.macos in denext.config.ts, else deno.json's, else
  // icons/app.icns, icons/app.png or desktop-icon.png.
  cmd.push(...await desktopIconArgs(import.meta.url, "darwin"));
  // deno desktop appends ".app" to --output on macOS, so pass the base name (strip a trailing
  // ".app") to land exactly at \`out\` — else it writes \`out.app\` and sign/lipo/dmg miss it.
  cmd.push("--output", out.replace(/\\.app$/, ""), "desktop.ts");
  // deno.json's version, else package.json's (stamped into deno.json for the build, then put back),
  // compiled into the bundle: what the installers and publish-update go by.
  await desktopWithAppVersion(import.meta.url, () => run(cmd, env));
  // The webview backend's launch settings (app id, the origin's custom scheme, single instance),
  // read from Contents/Resources at launch. Writing into the bundle breaks deno desktop's ad-hoc
  // seal, so a bundle that got one is always re-signed.
  if (await writeLaufeyLaunchConfig(import.meta.url, "darwin", out)) {
    resealNeeded = true;
  }
}

/** Set when a bundle was modified after \`deno desktop\` signed it (see buildApp). */
let resealNeeded = false;

/** List the Mach-O files inside a .app bundle (executables + dylibs). */
async function machOFiles(app: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of walk(\`\${app}/Contents\`)) {
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
    const path = \`\${dir}/\${e.name}\`;
    if (e.isDirectory) yield* walk(path);
    else yield { path, isFile: e.isFile };
  }
}

/** Merge two same-layout .apps into one universal .app at \`dest\` (lipo per Mach-O). */
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
      \`\${armApp}\${rel}\`,
      \`\${x86App}\${rel}\`,
      "-output",
      file,
    ]);
  }
}

/** A string value of the bundle's Info.plist; throws when it is missing or empty. */
async function infoPlistString(app: string, key: string): Promise<string> {
  const p = await new Deno.Command("plutil", {
    args: ["-extract", key, "raw", "-o", "-", \`\${app}/Contents/Info.plist\`],
    stdout: "piped",
    stderr: "null",
  }).output();
  const value = new TextDecoder().decode(p.stdout).trim();
  if (!p.success || !value) {
    throw new Error(\`could not read \${key} from \${app}/Contents/Info.plist\`);
  }
  return value;
}

/** The bundle's main executable path (from Info.plist CFBundleExecutable). */
async function mainExecutable(app: string): Promise<string> {
  // Fail loudly rather than returning an empty basename: an empty name would never
  // match in the sign loop's \`file === mainExe\` guard, so the main executable would be
  // signed twice (the second time without entitlements) — a silent invariant break.
  const name = await infoPlistString(app, "CFBundleExecutable");
  return \`\${app}/Contents/MacOS/\${name}\`;
}

/** Code-sign a .app inside-out. With an identity: Hardened Runtime + secure timestamp
 * (required for notarization). Without one: an ad-hoc signature (dev/local only) with neither,
 * as deno desktop's own ad-hoc pass signs: the Hardened Runtime would deny V8 and the CEF
 * helpers JIT memory, and only notarization (which needs an identity) requires it. It keeps what
 * deno desktop's own ad-hoc pass set up: each Mach-O beside the main executable signs as the
 * bundle's CFBundleIdentifier, and nested code (the CEF helper apps) keeps its entitlements.
 * With an identity, the Hardened Runtime needs entitlements for JIT code: the main executable
 * (V8) gets V8_ENTITLEMENTS merged into the explicit entitlements (or, without them, into the
 * ad-hoc pass's), and each CEF Renderer / GPU / Plugin helper Chromium's set for it. */
async function sign(
  app: string,
  identity: string | undefined,
  entitlements?: string,
  provisioningProfile?: string,
  profileIdentifier?: string,
): Promise<void> {
  // macosCodesignArgs: a secure timestamp + the Hardened Runtime with an identity; ad-hoc without.
  const mainExe = await mainExecutable(app);
  const bundleId = await infoPlistString(app, "CFBundleIdentifier");
  // desktop.macos.provisioningProfile: sealed into the bundle by its signature below.
  if (identity && provisioningProfile) {
    // The profile was checked against this identifier: a bundle built with another one would
    // carry a profile (and App ID entitlement) for a different app, which AMFI refuses at launch.
    if (bundleId !== profileIdentifier) {
      throw new Error(
        \`\${app} has the bundle identifier \${bundleId}, but the provisioning profile was \` +
          \`checked against \${profileIdentifier} (desktop.app.identifier)\`,
      );
    }
    await Deno.copyFile(
      provisioningProfile,
      \`\${app}/Contents/embedded.provisionprofile\`,
    );
  }
  // Nested Mach-O (dylibs/helpers) first; then the bundle, which signs the main
  // executable and applies the entitlements.
  const macosDir = \`\${app}/Contents/MacOS/\`;
  const written: string[] = [];
  // With an identity: \`defaults\` merged over the code's current (or the explicit) entitlements.
  const entitlementArgs = async (
    defaults: Record<string, boolean> | undefined,
    current: string,
    explicit?: string,
  ): Promise<string[]> => {
    if (!identity || !defaults) return ["--preserve-metadata=entitlements"];
    const file = await macosSigningEntitlements(defaults, {
      explicit,
      current,
    });
    written.push(file);
    return ["--entitlements", file];
  };
  try {
    for (const file of await machOFiles(app)) {
      if (file === mainExe) continue;
      // deno desktop signs every Mach-O in Contents/MacOS (the runtime dylib) with the bundle id
      // as its identifier, as it does the main executable; codesign would otherwise name it after
      // the file. A helper app's executable signs its bundle, whose entitlements must survive.
      const besideMain = file.startsWith(macosDir) &&
        !file.slice(macosDir.length).includes("/");
      await run(macosCodesignArgs(file, {
        identity,
        entitlementArgs: await entitlementArgs(
          cefHelperEntitlements(file),
          file,
        ),
        identifier: besideMain ? bundleId : undefined,
      }));
    }
    // Explicit entitlements replace the ad-hoc pass's; either way, with an identity, the main
    // executable (V8) gets the JIT keys they do not set.
    await run(macosCodesignArgs(app, {
      identity,
      entitlementArgs: await entitlementArgs(
        V8_ENTITLEMENTS,
        app,
        entitlements,
      ),
    }));
  } finally {
    for (const file of written) await Deno.remove(file).catch(() => {});
  }
  await run(["codesign", "--verify", "--deep", "--strict", app]);
}

/** Notarize + staple a .app (requires a real identity + a notarytool keychain profile). */
async function notarize(app: string, profile: string): Promise<void> {
  const zip = \`\${app}.zip\`;
  try {
    await run(["ditto", "-c", "-k", "--keepParent", app, zip]);
    await run(
      notarytoolSubmitArgs(zip, { kind: "keychain-profile", profile }),
    );
    await run(["xcrun", "stapler", "staple", app]);
  } finally {
    // Remove the submission zip even if notarytool/staple failed.
    await Deno.remove(zip).catch(() => {});
  }
}

/** Image size in MiB for a .dmg of \`bytes\` of content: 25% headroom plus 64 MiB. hdiutil's own
 * estimate for \`-srcfolder\` runs short on some macOS images ("No space left on device"); with
 * UDZO the final image is still compressed, so the headroom only sizes the temporary image. */
function dmgSizeMb(bytes: number): number {
  return Math.ceil((bytes * 1.25) / (1024 * 1024)) + 64;
}

/** Total bytes under \`path\`; a symlink counts as the link itself, never its target. */
async function treeBytes(path: string): Promise<number> {
  const info = await Deno.lstat(path);
  if (!info.isDirectory) return info.size;
  let total = 0;
  for await (const e of Deno.readDir(path)) {
    total += await treeBytes(\`\${path}/\${e.name}\`);
  }
  return total;
}

async function makeDmg(app: string): Promise<string> {
  const dmg = app.replace(/\\.app$/, ".dmg");
  await Deno.remove(dmg).catch(() => {});
  await run([
    "hdiutil",
    "create",
    "-volname",
    app.split("/").pop()!.replace(/\\.app$/, ""),
    "-srcfolder",
    app,
    "-size",
    \`\${dmgSizeMb(await treeBytes(app))}m\`,
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
  const pkg = app.replace(/\\.app$/, ".pkg");
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
    await run(
      notarytoolSubmitArgs(pkg, {
        kind: "keychain-profile",
        profile: s.notaryProfile,
      }),
    );
    await run(["xcrun", "stapler", "staple", pkg]);
  } else if (!s.installerIdentity) {
    console.warn(
      \`  \${pkg}: unsigned (set DENEXT_INSTALLER_IDENTITY to a "Developer ID Installer" identity).\`,
    );
  }
  return pkg;
}

/** The signing setup, from env (nothing secret is hard-coded). */
interface Signing {
  identity: string | undefined;
  entitlements: string | undefined;
  /** desktop.macos.provisioningProfile (or DENEXT_PROVISIONING_PROFILE), checked. */
  provisioningProfile: string | undefined;
  /** The bundle identifier the profile was checked against (the built .app must carry it). */
  profileIdentifier: string | undefined;
  notaryProfile: string | undefined;
  /** "Developer ID Installer: …" for the .pkg. */
  installerIdentity: string | undefined;
}

async function signingFromEnv(): Promise<Signing> {
  const identity = Deno.env.get("DENEXT_CODESIGN_IDENTITY") || undefined;
  const notaryProfile = Deno.env.get("DENEXT_NOTARY_PROFILE") || undefined;
  if (!identity) {
    console.warn(
      "⚠  DENEXT_CODESIGN_IDENTITY is unset → ad-hoc signature only. The app runs\\n" +
        "   locally but Gatekeeper will block it on other Macs. Set a\\n" +
        '   "Developer ID Application: … (TEAMID)" identity to distribute.',
    );
  }
  if (notaryProfile && !identity) {
    throw new Error(
      "notarization needs DENEXT_CODESIGN_IDENTITY (a real Developer ID identity).",
    );
  }
  // desktop.macos: the profile (checked against the app now, before the build) and the
  // entitlements merged over DENEXT_ENTITLEMENTS's.
  const mac = await desktopMacosSigning(import.meta.url, {
    identity,
    entitlements: Deno.env.get("DENEXT_ENTITLEMENTS") || undefined,
    provisioningProfile: Deno.env.get("DENEXT_PROVISIONING_PROFILE") ||
      undefined,
  });
  return {
    identity,
    entitlements: mac.entitlements,
    provisioningProfile: mac.provisioningProfile,
    profileIdentifier: mac.identifier,
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
    const uni = \`dist/\${name}.app\`;
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
      const app = \`dist/\${name}-\${a}.app\`;
      await buildApp(app, TARGETS[a]);
      artifacts.push(app);
    }
    return artifacts;
  }
  const app = \`dist/\${name}.app\`;
  await buildApp(app, opts.arch === "host" ? undefined : TARGETS[opts.arch]);
  return [app];
}

/**
 * The signing plan, printed before the build: \`deno desktop\` always seals the bundle it compiles,
 * ad-hoc on a Mac when deno.json names no identity, so its own log says
 * 'Codesigning bundle with identity "-"' even when DENEXT_CODESIGN_IDENTITY is set. That pass has no
 * switch (the runtime needs a sealed bundle; the launch config written after it, and a lipo merge,
 * break the seal anyway), so with an identity it is an ad-hoc pre-sign that sign() replaces.
 */
function signingPlanNote(identity: string | undefined): string | undefined {
  if (!identity) return undefined;
  return "Signing: deno desktop seals each bundle ad-hoc as it builds it (its " +
    "'Codesigning bundle with identity \\"-\\"' line), an ad-hoc pre-sign; re-signing with " +
    identity + " afterwards.";
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
      console.log(\`Re-signing \${app} with identity "\${s.identity ?? "-"}"\`);
      await sign(
        app,
        s.identity,
        s.entitlements,
        s.provisioningProfile,
        s.profileIdentifier,
      );
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
  const signing = await signingFromEnv();
  // DENEXT_APP_NAME, else desktop.app.name in denext.config.ts, else deno.json's.
  const name = await appName(import.meta.url);
  // --format, else desktop.installers.macos in denext.config.ts, else a .dmg.
  const plan = await desktopInstallerPlan(
    import.meta.url,
    "darwin",
    opts.formats,
    opts.add,
  );
  // The export resolves the macOS target's platform files (\`.macos\`, \`.desktop\`).
  if (opts.export) {
    await run(["deno", "task", "export"], desktopExportEnv("darwin"));
  }
  // .deno-desktop/app.json (the app origin + identifier), its deno.json compile.include, and the
  // config's desktop.app name / identifier mirrored into deno.json, where deno desktop reads them.
  // After the export: \`denext desktop package\` keeps a backup of deno.json while this script runs,
  // and the export's CLI restores it when it starts, which would undo a sync done before it.
  await syncDesktopAppConfig(import.meta.url);
  await Deno.mkdir("dist", { recursive: true });
  const signingPlan = signingPlanNote(signing.identity);
  if (signingPlan) console.log(signingPlan);
  const artifacts = await buildArtifacts(opts, name);
  const installers = await finishArtifacts(
    artifacts,
    opts,
    plan.formats,
    signing,
  );
  console.log("\\n✓ Packaged:");
  for (const a of [...artifacts, ...installers]) console.log("  " + a);
  console.log(distributionNote(signing));
}

if (import.meta.main) await main();
`;

/** The scaffolded Linux packaging script (scripts/package-linux.ts). `deno desktop`
 * emits a complete Linux app bundle directory (executable + `.so` + `.desktop`), so
 * this builds one or both arches and wraps each in its installers: `.tar.gz` + `.deb` by
 * default, `.rpm` (rpmbuild) and an AppImage (appimagetool) on request. */
export const LINUX_PACKAGE_SCRIPT = `#!/usr/bin/env -S deno run -A
/**
 * Package this \`deno desktop\` app for Linux distribution. \`deno desktop\` produces a
 * complete bundle directory (the executable, its \`.so\`, and a freedesktop \`.desktop\`
 * launcher); this builds one or both arches and wraps each in its installers.
 *
 *   deno run -A scripts/package-linux.ts [--arch <mode>] [--no-export] [--format <list>]
 *
 * --arch  host | x86_64 | arm64 | both   (default: host)
 *           host    the machine's own architecture (x86_64 when cross-building from macOS Intel)
 *           x86_64  x86_64-unknown-linux-gnu
 *           arm64   aarch64-unknown-linux-gnu
 *           both    x86_64 AND arm64 as two bundles
 * --no-export  skip \`deno task export\` and reuse the existing out/ (faster iteration)
 * --format     installers per arch, comma-separated: tar.gz, deb, rpm, appimage. Default: the
 *              denext.config.ts \`desktop.installers.linux\` list, else tar.gz,deb.
 *                tar.gz    the bundle directory
 *                deb       Debian/Ubuntu package (built by denext; no tool needed)
 *                rpm       Fedora/RHEL/openSUSE package (needs \`rpmbuild\`)
 *                appimage  a single-file AppImage (needs \`appimagetool\`)
 *              The .deb/.rpm install to /usr/lib/<app>, link /usr/bin/<app>, and register the
 *              launcher, the icon and the deno.json \`desktop.app.deepLinks\` schemes. A default
 *              format whose tool is missing is skipped with a warning; one you asked for fails.
 * --appimage   add an AppImage to whatever --format / the config asks for
 *
 *   DENEXT_APP_NAME  output base name (default: \`desktop.app.name\` in denext.config.ts, else
 *                    deno.json's). The bundle's name, identifier and icon come from
 *                    denext.config.ts \`desktop.app\` (\`icons.linux\`, a PNG), else deno.json.
 *   deno.json \`version\` is the package version; denext.config.ts \`desktop.installers\`
 *   \`publisher\` / \`description\` fill the package metadata.
 *
 * Builds on denext's pinned Deno Desktop runtime (custom app origin, per-app storage, deep links,
 * single instance), downloaded once into the Deno cache and SHA-256-verified; it needs the exact
 * Deno version it was built for (\`deno upgrade --version 2.9.8\`).
 *   DENEXT_DESKTOP_RUNTIME=stock     use the stock runtime instead (none of the above works)
 *   DENEXT_DESKTOP_RUNTIME_DIR=<dir> use a local runtime build (unverified; runtime development)
 *   DENEXT_DESKTOP_RUNTIME_VERIFY=1  re-hash the cached runtime before use
 *   DENEXT_DESKTOP_RUNTIME_ATTEST=1  also check a fresh download's build provenance (needs gh)
 *
 * The end user's Linux desktop needs a WebKitGTK runtime (webkit2gtk) for the window;
 * that is a deploy-environment dependency, not baked into the bundle. Outputs into ./dist/.
 */

import type { DesktopPackageMeta } from "denext/desktop";

// Load denext/desktop with --node-modules-dir=none, so its own build dependencies (esbuild, ws)
// come from Deno's cache whatever this project's node_modules mode is: in a pnpm workspace
// (nodeModulesDir "manual") Deno would look for them in node_modules, fail, and rewrite the root
// package.json from pnpm-workspace.yaml. The script re-runs itself once under that flag.
if (Deno.env.get("DENEXT_DESKTOP_NPM") !== "none") {
  const age = Deno.env.get("DENEXT_MIN_DEP_AGE");
  const { code } = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--node-modules-dir=none",
      ...(age ? ["--min-dep-age=" + age] : []),
      import.meta.url,
      ...Deno.args,
    ],
    env: { DENEXT_DESKTOP_NPM: "none" },
  }).spawn().status;
  Deno.exit(code);
}

const {
  buildDesktopBundle,
  buildDesktopDeb,
  buildDesktopRpm,
  buildDesktopTarball,
  desktopPackageArches,
  desktopRequireTool,
  desktopRun: run,
  desktopToolGate,
  desktopVersionProblem,
  parseDesktopPackageArgs,
  prepareDesktopPackage,
} = await import("denext/desktop");

const TARGETS: Record<string, string> = {
  x86_64: "x86_64-unknown-linux-gnu",
  arm64: "aarch64-unknown-linux-gnu",
};
// Underscore-free labels for output paths: \`deno desktop\` derives a reverse-DNS bundle id
// from the output basename and rejects '_' (so a raw \`x86_64\` suffix drops the .desktop file).
const LABELS: Record<string, string> = { x86_64: "x64", arm64: "arm64" };
const OS = "linux";

/** Build a Linux bundle directory for \`arch\` at dist/<name>-<label> (PNG icon). */
async function buildBundle(
  name: string,
  arch: "x86_64" | "arm64",
): Promise<string> {
  return await buildDesktopBundle(import.meta.url, OS, {
    target: TARGETS[arch],
    out: \`dist/\${name}-\${LABELS[arch]}\`,
    icons: ["icons/app.png", "desktop-icon.png"],
  });
}

/** tar.gz a bundle directory for distribution (written by denext: modes kept on any host). */
async function tarball(
  name: string,
  arch: "x86_64" | "arm64",
  dir: string,
): Promise<string> {
  const tgz = \`dist/\${name}-\${LABELS[arch]}-linux.tar.gz\`;
  return await buildDesktopTarball({ bundleDir: dir, out: tgz });
}

/** Build an AppImage for a bundle with appimagetool; returns its path. */
async function appImage(
  name: string,
  arch: "x86_64" | "arm64",
  dir: string,
): Promise<string> {
  const appdir = \`\${dir}.AppDir\`;
  await Deno.remove(appdir, { recursive: true }).catch(() => {});
  await Deno.mkdir(appdir, { recursive: true });
  // AppDir layout: the bundle contents + the .desktop at the root + an AppRun → exe.
  await run(["cp", "-r", \`\${dir}/.\`, appdir]);
  const exe = \`\${name}-\${LABELS[arch]}\`;
  await Deno.writeTextFile(
    \`\${appdir}/AppRun\`,
    \`#!/bin/sh\\nHERE=$(dirname "$0")\\nexec "$HERE/\${exe}" "$@"\\n\`,
  );
  await Deno.chmod(\`\${appdir}/AppRun\`, 0o755);
  const outFile = \`dist/\${name}-\${LABELS[arch]}.AppImage\`;
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
  const base = \`dist/\${name}-\${LABELS[arch]}\`;
  const pkg = { meta, bundleDir: dir, exe: \`\${name}-\${LABELS[arch]}\`, arch };
  // A version Debian / RPM can't express skips a default .deb with a warning (an asked-for one fails).
  const versionOk = (format: "deb" | "rpm") =>
    desktopToolGate(
      desktopVersionProblem(format, meta.version),
      \`.\${format}\`,
      plan.explicit,
    );
  for (const format of plan.formats) {
    if (format === "tar.gz") out.push(await tarball(name, arch, dir));
    if (format === "deb" && versionOk("deb")) {
      out.push(await buildDesktopDeb({ ...pkg, out: \`\${base}.deb\` }));
    }
    if (
      format === "rpm" && versionOk("rpm") &&
      await desktopRequireTool("rpmbuild", ".rpm", plan.explicit)
    ) {
      out.push(await buildDesktopRpm({ ...pkg, out: \`\${base}.rpm\` }));
    }
    if (
      format === "appimage" &&
      await desktopRequireTool("appimagetool", "AppImage", plan.explicit)
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
  const { name, plan, meta } = await prepareDesktopPackage(
    import.meta.url,
    OS,
    opts,
  );

  const artifacts: string[] = [];
  for (const arch of desktopPackageArches(opts.arch)) {
    const dir = await buildBundle(name, arch);
    artifacts.push(dir, ...await installers(name, arch, dir, plan, meta));
  }

  console.log("\\n  Built:");
  for (const a of artifacts) console.log("  " + a);
  console.log(
    "\\n  (the target Linux desktop needs a WebKitGTK / webkit2gtk runtime installed)",
  );
}

if (import.meta.main) await main();
`;

/** Windows packaging script — kept byte-identical to
 * examples/native/scripts/package-windows.ts (asserted by scaffold.test.ts). Builds the
 * `.exe` via `deno desktop --target`, Authenticode-signs it when a cert is set, and wraps the
 * bundle in an `.msi` (WiX) and/or a `.zip`. */
export const WINDOWS_PACKAGE_SCRIPT = `#!/usr/bin/env -S deno run -A
/**
 * Package this \`deno desktop\` app for Windows distribution. \`deno desktop\` produces a
 * complete bundle directory (the \`.exe\`, its \`.dll\`s, and resources); this builds one or
 * both arches, Authenticode-signs every PE file in the bundle (the \`.exe\`, its \`.dll\`s, any
 * \`.node\`) when a code-signing certificate is provided, and
 * wraps each bundle in its installers (an \`.msi\` by default). Signing needs \`signtool\`
 * (Windows SDK): with a certificate configured and no signtool the run fails rather than ship an
 * unsigned app (\`--no-sign\` builds unsigned on purpose).
 *
 *   deno run -A scripts/package-windows.ts [--arch <mode>] [--no-export] [--no-sign] [--format <list>]
 *
 * --arch  host | x86_64 | arm64 | both   (default: host)
 *           host    the machine's own architecture
 *           x86_64  x86_64-pc-windows-msvc
 *           arm64   aarch64-pc-windows-msvc
 *           both    x86_64 AND arm64 as two bundles
 * --no-export  skip \`deno task export\` and reuse the existing out/ (faster iteration)
 * --no-sign    skip Authenticode signing even when a certificate is configured
 * --format     installers per arch, comma-separated: msi, zip. Default: the denext.config.ts
 *              \`desktop.installers.windows\` list, else msi.
 *                msi  a Windows Installer package (WiX 5: \`dotnet tool install --global wix
 *                     --version 5.0.2\`; builds on Windows). Installs per-user into
 *                     %LOCALAPPDATA%\\Programs\\<App> with no admin rights, or per-machine into
 *                     Program Files with \`msiexec /i <app>.msi ALLUSERS=1\`; adds a Start-menu
 *                     shortcut and the deno.json \`desktop.app.deepLinks\` schemes; a newer
 *                     version upgrades in place (the UpgradeCode follows \`desktop.app.identifier\`).
 *                     Signed like the .exe. Without WiX a default .msi falls back to the .zip.
 *                zip  the bundle directory
 *
 *   DENEXT_APP_NAME                output base name (default: \`desktop.app.name\` in
 *                                  denext.config.ts, else deno.json's). The bundle's name,
 *                                  identifier and icon come from denext.config.ts \`desktop.app\`
 *                                  (\`icons.windows\`, an .ico), else deno.json.
 *   DENEXT_WINDOWS_CERT            path to a code-signing certificate (.pfx) — signing is
 *                                  skipped when unset (no secrets are ever baked in).
 *   DENEXT_WINDOWS_CERT_PASSWORD   the .pfx password, if any.
 *   DENEXT_WINDOWS_CERT_THUMBPRINT a certificate in the Windows store instead of a .pfx.
 *   DENEXT_SIGN_TIMESTAMP_URL      RFC-3161 timestamp server (default: DigiCert's).
 *   deno.json \`version\` is the MSI ProductVersion (numeric major.minor.build); denext.config.ts
 *   \`desktop.installers.publisher\` its Manufacturer.
 *
 * Builds on denext's pinned Deno Desktop runtime (custom app origin, per-app storage, deep links,
 * single instance), downloaded once into the Deno cache and SHA-256-verified; it needs the exact
 * Deno version it was built for (\`deno upgrade --version 2.9.8\`).
 *   DENEXT_DESKTOP_RUNTIME=stock     use the stock runtime instead (none of the above works)
 *   DENEXT_DESKTOP_RUNTIME_DIR=<dir> use a local runtime build (unverified; runtime development)
 *   DENEXT_DESKTOP_RUNTIME_VERIFY=1  re-hash the cached runtime before use
 *   DENEXT_DESKTOP_RUNTIME_ATTEST=1  also check a fresh download's build provenance (needs gh)
 *
 * A webview build (the default \`desktop.backend\`) needs the Microsoft Edge WebView2 runtime on
 * the end user's machine (preinstalled on current Windows 10/11); that is a deploy-environment
 * dependency, not baked into the bundle. A CEF build ships Chromium in the bundle instead. A
 * signed CEF build must be signed with a certificate the target trusts: CEF's bootstrap verifies
 * the executable's Authenticode chain and exits at launch otherwise (the run warns when this
 * machine does not trust it; \`--no-sign\` builds an unsigned app that starts). Outputs into
 * ./dist/.
 */

import type { DesktopPackageMeta } from "denext/desktop";

// Load denext/desktop with --node-modules-dir=none, so its own build dependencies (esbuild, ws)
// come from Deno's cache whatever this project's node_modules mode is: in a pnpm workspace
// (nodeModulesDir "manual") Deno would look for them in node_modules, fail, and rewrite the root
// package.json from pnpm-workspace.yaml. The script re-runs itself once under that flag.
if (Deno.env.get("DENEXT_DESKTOP_NPM") !== "none") {
  const age = Deno.env.get("DENEXT_MIN_DEP_AGE");
  const { code } = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--node-modules-dir=none",
      ...(age ? ["--min-dep-age=" + age] : []),
      import.meta.url,
      ...Deno.args,
    ],
    env: { DENEXT_DESKTOP_NPM: "none" },
  }).spawn().status;
  Deno.exit(code);
}

const {
  buildDesktopBundle,
  buildDesktopMsi,
  bundleDesktopVcRuntime,
  desktopCheckCefSignature,
  desktopHasTool: has,
  desktopMsiProblem,
  desktopOptionalInstaller,
  desktopPackageArches,
  desktopPeFiles,
  desktopRun: run,
  desktopSignWindows,
  desktopToolGate,
  desktopWindowsTargetNote,
  parseDesktopPackageArgs,
  prepareDesktopPackage,
} = await import("denext/desktop");

const TARGETS: Record<string, string> = {
  x86_64: "x86_64-pc-windows-msvc",
  arm64: "aarch64-pc-windows-msvc",
};
// Underscore-free labels for output paths: \`deno desktop\` derives a reverse-DNS bundle id
// from the output basename and rejects '_' (so a raw \`x86_64\` suffix drops resources).
const LABELS: Record<string, string> = { x86_64: "x64", arm64: "arm64" };
const OS = "windows";

/** Build a Windows bundle directory for \`arch\` at dist/<name>-<label> (.ico icon). */
async function buildBundle(
  name: string,
  arch: "x86_64" | "arm64",
): Promise<string> {
  return await buildDesktopBundle(import.meta.url, OS, {
    target: TARGETS[arch],
    out: \`dist/\${name}-\${LABELS[arch]}\`,
    icons: ["icons/app.ico", "desktop-icon.ico"],
  });
}

/** Authenticode-sign \`files\` with DENEXT_WINDOWS_CERT through \`signtool\`, batched; without a
 * certificate, skip with a warning; with one but no signtool, fail (see desktopSignWindows).
 * Whether they were signed. */
async function sign(files: string[]): Promise<boolean> {
  return await desktopSignWindows(files);
}

/** Sign EVERY PE file in the bundle (the .exe, <App>.dll, WebView2Loader.dll, the VC++ runtime,
 * CEF's DLLs, any .node), found by its header: the runtime refuses an update of a signed app
 * unless each one carries the running app's signature. A signed CEF app must be trusted here:
 * CEF's bootstrap verifies the executable's signature at launch and dies when it is not. */
async function signBundle(
  dir: string,
  exe: string,
  backend: string,
): Promise<void> {
  if (await sign(await desktopPeFiles(dir)) && backend === "cef") {
    await desktopCheckCefSignature(\`\${dir}/\${exe}\`);
  }
}

/** Build the .msi for a finished bundle with WiX 5; null when it can't be built here (off
 * Windows, no WiX 5, a version MSI can't express, a failed \`wix build\`) and the .msi was only a
 * default — an asked-for .msi fails the run instead. */
async function msi(
  name: string,
  arch: "x86_64" | "arm64",
  dir: string,
  meta: DesktopPackageMeta,
  explicit: boolean,
): Promise<string | null> {
  const what = \`.msi for \${arch} (the .zip is built instead)\`;
  if (!desktopToolGate(await desktopMsiProblem(meta.version), what, explicit)) {
    return null;
  }
  const out = \`dist/\${name}-\${LABELS[arch]}.msi\`;
  const exe = \`\${name}-\${LABELS[arch]}.exe\`;
  return await desktopOptionalInstaller(what, explicit, async () => {
    await buildDesktopMsi({ meta, bundleDir: dir, exe, arch, out });
    return out;
  });
}

/** Zip a bundle directory for distribution (prefers \`zip\`, falls back to bsdtar). */
async function zipBundle(
  name: string,
  arch: "x86_64" | "arm64",
  dir: string,
): Promise<string> {
  const zip = \`dist/\${name}-\${LABELS[arch]}-windows.zip\`;
  await Deno.remove(zip).catch(() => {});
  const rel = dir.replace(/^dist\\//, "");
  if (await has("zip")) {
    await run(["sh", "-c", \`cd dist && zip -r "\${rel}-windows.zip" "\${rel}"\`]);
  } else {
    // bsdtar (default on Windows 10+/macOS) writes zip from the .zip suffix via -a.
    await run(["tar", "-a", "-c", "-f", zip, "-C", "dist", rel]);
  }
  return zip;
}

/** Build, sign and wrap one arch's bundle; returns what it wrote and whether the VC++ runtime
 * went in app-local. */
async function packageArch(
  name: string,
  arch: "x86_64" | "arm64",
  signing: boolean,
  { plan, meta }: Awaited<ReturnType<typeof prepareDesktopPackage>>,
): Promise<{ out: string[]; vcBundled: boolean }> {
  const dir = await buildBundle(name, arch);
  // The VC++ runtime app-local (only the DLLs this arch imports, each checked to be its machine
  // type), so the target needs no redistributable; a warning names the one it needs otherwise.
  const vcBundled = await bundleDesktopVcRuntime(dir, arch);
  if (signing) {
    await signBundle(dir, \`\${name}-\${LABELS[arch]}.exe\`, meta.backend);
  }
  const out = [dir];
  const built = plan.formats.includes("msi")
    ? await msi(name, arch, dir, meta, plan.explicit)
    : null;
  if (built && signing) await sign([built]);
  if (built) out.push(built);
  // A default .msi that could not be built falls back to the .zip.
  const msiSkipped = plan.formats.includes("msi") && !built;
  if (plan.formats.includes("zip") || msiSkipped) {
    out.push(await zipBundle(name, arch, dir));
  }
  return { out, vcBundled };
}

async function main(): Promise<void> {
  const opts = parseDesktopPackageArgs(Deno.args, {
    arches: ["host", "x86_64", "arm64", "both"],
  });
  // --format, else desktop.installers.windows in denext.config.ts, else an .msi; the
  // .deno-desktop/app.json sync, the package metadata (name, version, deep links), the export.
  const prepared = await prepareDesktopPackage(import.meta.url, OS, opts);
  const name = prepared.name;

  const artifacts: string[] = [];
  const noVcRuntime: string[] = [];
  for (const arch of desktopPackageArches(opts.arch)) {
    const { out, vcBundled } = await packageArch(
      name,
      arch,
      opts.sign,
      prepared,
    );
    artifacts.push(...out);
    if (!vcBundled) noVcRuntime.push(arch);
  }

  console.log("\\n  Built:");
  for (const a of artifacts) console.log("  " + a);
  // What the target needs: WebView2 for a webview build (a CEF build ships Chromium), and the
  // VC++ redistributable for an arch whose runtime could not be bundled.
  console.log(
    "\\n  " + desktopWindowsTargetNote(prepared.meta.backend, noVcRuntime),
  );
}

if (import.meta.main) await main();
`;
