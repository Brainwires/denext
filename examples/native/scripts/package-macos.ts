#!/usr/bin/env -S deno run -A
/**
 * Package this `deno desktop` app for macOS distribution: build (for one or more
 * architectures), code-sign, and optionally notarize + staple. Run on a macOS host.
 *
 *   deno run -A scripts/package-macos.ts [--arch <mode>] [--no-export] [--dmg]
 *
 * --arch  host | arm64 | x86_64 | both | universal   (default: host)
 *           host      the machine's own architecture
 *           arm64     Apple Silicon (aarch64-apple-darwin)
 *           x86_64    Intel (x86_64-apple-darwin)
 *           both      arm64 AND x86_64 as two separate .app bundles
 *           universal one .app whose binaries are lipo-merged (runs natively on both)
 * --no-export  skip `deno task export` and reuse the existing out/ (faster iteration)
 * --dmg        also wrap each .app in a .dmg
 *
 * Signing / notarization are driven by env vars (nothing secret is hard-coded):
 *   DENEXT_CODESIGN_IDENTITY  "Developer ID Application: Name (TEAMID)". REQUIRED to
 *                             distribute. Omit → an ad-hoc signature (dev/local only;
 *                             Gatekeeper will block it on other Macs).
 *   DENEXT_ENTITLEMENTS       path to an entitlements .plist (optional).
 *   DENEXT_NOTARY_PROFILE     a `xcrun notarytool store-credentials` keychain profile.
 *                             Set (with a real identity) → notarize + staple each app.
 *   DENEXT_APP_NAME           output base name (default: the deno.json `desktop.app.name`).
 *
 * Outputs into ./dist/.
 *
 * See the "Distributing a macOS desktop app" doc for the full setup (creating a
 * Developer ID Application certificate, storing notarytool credentials, Gatekeeper).
 */

const TARGETS: Record<string, string> = {
  arm64: "aarch64-apple-darwin",
  x86_64: "x86_64-apple-darwin",
};
const hostArch = Deno.build.arch === "aarch64" ? "arm64" : "x86_64";

interface Opts {
  arch: "host" | "arm64" | "x86_64" | "both" | "universal";
  export: boolean;
  dmg: boolean;
}

function parseOpts(argv: string[]): Opts {
  const o: Opts = { arch: "host", export: true, dmg: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--arch") o.arch = argv[++i] as Opts["arch"];
    else if (a.startsWith("--arch=")) o.arch = a.slice(7) as Opts["arch"];
    else if (a === "--no-export") o.export = false;
    else if (a === "--dmg") o.dmg = true;
    else if (a === "-h" || a === "--help") {
      console.log(
        new URL(import.meta.url).pathname,
        "\nSee the header comment for usage.",
      );
      Deno.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  const valid = ["host", "arm64", "x86_64", "both", "universal"];
  if (!valid.includes(o.arch)) {
    throw new Error(`--arch must be one of ${valid.join(", ")}`);
  }
  return o;
}

async function run(
  cmd: string[],
  opts: { env?: Record<string, string> } = {},
): Promise<void> {
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    env: opts.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await p.output();
  if (code !== 0) throw new Error(`command failed (${code}): ${cmd.join(" ")}`);
}

/** Read the desktop app name from deno.json (falls back to "app"). */
async function appName(): Promise<string> {
  const env = Deno.env.get("DENEXT_APP_NAME");
  if (env) return env;
  try {
    const cfg = JSON.parse(await Deno.readTextFile("deno.json"));
    const n = cfg?.desktop?.app?.name;
    if (typeof n === "string" && n.trim()) return n.trim();
  } catch { /* no/invalid deno.json */ }
  return "app";
}

/** Build a single .app for `target` (undefined = host arch). deno desktop signs it
 * ad-hoc; the caller re-signs with the real identity afterwards. */
async function buildApp(out: string, target?: string): Promise<void> {
  await Deno.remove(out, { recursive: true }).catch(() => {});
  const cmd = ["deno", "desktop", "-A", "--include", "out"];
  if (target) cmd.push("--target", target);
  cmd.push("--output", out, "desktop.ts");
  await run(cmd);
}

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

async function makeDmg(app: string): Promise<void> {
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
}

async function main(): Promise<void> {
  if (Deno.build.os !== "darwin") {
    console.error(
      "package-macos.ts must run on macOS (it shells out to codesign/notarytool).",
    );
    Deno.exit(1);
  }
  const opts = parseOpts(Deno.args);
  const identity = Deno.env.get("DENEXT_CODESIGN_IDENTITY") || undefined;
  const entitlements = Deno.env.get("DENEXT_ENTITLEMENTS") || undefined;
  const notaryProfile = Deno.env.get("DENEXT_NOTARY_PROFILE") || undefined;
  const name = await appName();

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

  if (opts.export) await run(["deno", "task", "export"]);
  await Deno.mkdir("dist", { recursive: true });

  const artifacts: string[] = [];
  if (opts.arch === "universal") {
    const arm = "dist/.tmp-arm64.app";
    const x86 = "dist/.tmp-x86_64.app";
    try {
      await buildApp(arm, TARGETS.arm64);
      await buildApp(x86, TARGETS.x86_64);
      const uni = `dist/${name}.app`;
      await mergeUniversal(arm, x86, uni);
      artifacts.push(uni);
    } finally {
      // Always clear the per-arch temp bundles (hundreds of MB each) — even if a
      // build/merge threw partway, so a failed run doesn't litter dist/.
      await Deno.remove(arm, { recursive: true }).catch(() => {});
      await Deno.remove(x86, { recursive: true }).catch(() => {});
    }
  } else if (opts.arch === "both") {
    for (const a of ["arm64", "x86_64"] as const) {
      const app = `dist/${name}-${a}.app`;
      await buildApp(app, TARGETS[a]);
      artifacts.push(app);
    }
  } else {
    const a = opts.arch === "host" ? hostArch : opts.arch;
    const app = `dist/${name}.app`;
    await buildApp(app, opts.arch === "host" ? undefined : TARGETS[a]);
    artifacts.push(app);
  }

  for (const app of artifacts) {
    // A lipo-merged (universal) bundle always needs re-signing; for others we re-sign
    // only when a real identity is provided (deno desktop already applied ad-hoc).
    if (identity || opts.arch === "universal") {
      await sign(app, identity, entitlements);
    }
    if (notaryProfile && identity) await notarize(app, notaryProfile);
    if (opts.dmg) await makeDmg(app);
  }

  console.log("\n✓ Packaged:");
  for (const a of artifacts) console.log("  " + a);
  if (!identity) {
    console.log(
      "  (ad-hoc — not distributable; see the macOS distribution doc)",
    );
  } else if (!notaryProfile) {
    console.log(
      "  (signed, NOT notarized — set DENEXT_NOTARY_PROFILE to notarize)",
    );
  } else console.log("  (signed + notarized + stapled — ready to distribute)");
}

if (import.meta.main) await main();
