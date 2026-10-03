#!/usr/bin/env -S deno run -A
/**
 * Package this `deno desktop` app for Windows distribution. `deno desktop` produces a
 * complete bundle directory (the `.exe`, its `.dll`s, and resources); this builds one or
 * both arches, Authenticode-signs the `.exe` when a code-signing certificate is provided, and
 * wraps each bundle in its installers (an `.msi` by default). Signing only runs where
 * `signtool` is available (Windows) and a cert is configured.
 *
 *   deno run -A scripts/package-windows.ts [--arch <mode>] [--no-export] [--no-sign] [--format <list>]
 *
 * --arch  host | x86_64 | arm64 | both   (default: host)
 *           host    the machine's own architecture
 *           x86_64  x86_64-pc-windows-msvc
 *           arm64   aarch64-pc-windows-msvc
 *           both    x86_64 AND arm64 as two bundles
 * --no-export  skip `deno task export` and reuse the existing out/ (faster iteration)
 * --no-sign    skip Authenticode signing even when a certificate is configured
 * --format     installers per arch, comma-separated: msi, zip. Default: the denext.config.ts
 *              `desktop.installers.windows` list, else msi.
 *                msi  a Windows Installer package (WiX 5: `dotnet tool install --global wix
 *                     --version 5.0.2`; builds on Windows). Installs per-user into
 *                     %LOCALAPPDATA%\Programs\<App> with no admin rights, or per-machine into
 *                     Program Files with `msiexec /i <app>.msi ALLUSERS=1`; adds a Start-menu
 *                     shortcut and the deno.json `desktop.app.deepLinks` schemes; a newer
 *                     version upgrades in place (the UpgradeCode follows `desktop.app.identifier`).
 *                     Signed like the .exe. Without WiX a default .msi falls back to the .zip.
 *                zip  the bundle directory
 *
 *   DENEXT_APP_NAME                output base name (default: `desktop.app.name` in
 *                                  denext.config.ts, else deno.json's). The bundle's name,
 *                                  identifier and icon come from denext.config.ts `desktop.app`
 *                                  (`icons.windows`, an .ico), else deno.json.
 *   DENEXT_WINDOWS_CERT            path to a code-signing certificate (.pfx) — signing is
 *                                  skipped when unset (no secrets are ever baked in).
 *   DENEXT_WINDOWS_CERT_PASSWORD   the .pfx password, if any.
 *   DENEXT_SIGN_TIMESTAMP_URL      RFC-3161 timestamp server (default: DigiCert's).
 *   deno.json `version` is the MSI ProductVersion (numeric major.minor.build); denext.config.ts
 *   `desktop.installers.publisher` its Manufacturer.
 *
 * Builds on denext's pinned Deno Desktop runtime (custom app origin, per-app storage, deep links,
 * single instance), downloaded once into the Deno cache and SHA-256-verified; it needs the exact
 * Deno version it was built for (`deno upgrade --version 2.9.7`).
 *   DENEXT_DESKTOP_RUNTIME=stock     use the stock runtime instead (none of the above works)
 *   DENEXT_DESKTOP_RUNTIME_DIR=<dir> use a local runtime build (unverified; runtime development)
 *   DENEXT_DESKTOP_RUNTIME_VERIFY=1  re-hash the cached runtime before use
 *   DENEXT_DESKTOP_RUNTIME_ATTEST=1  also check a fresh download's build provenance (needs gh)
 *
 * The end user's Windows machine needs the Microsoft Edge WebView2 runtime for the window
 * (preinstalled on current Windows 10/11); that is a deploy-environment dependency, not
 * baked into the bundle. Outputs into ./dist/.
 */

import {
  buildDesktopBundle,
  buildDesktopMsi,
  desktopHasTool as has,
  desktopMsiProblem,
  desktopOptionalInstaller,
  desktopPackageArches,
  type DesktopPackageMeta,
  desktopRun as run,
  desktopToolGate,
  parseDesktopPackageArgs,
  prepareDesktopPackage,
} from "denext/desktop";

const TARGETS: Record<string, string> = {
  x86_64: "x86_64-pc-windows-msvc",
  arm64: "aarch64-pc-windows-msvc",
};
// Underscore-free labels for output paths: `deno desktop` derives a reverse-DNS bundle id
// from the output basename and rejects '_' (so a raw `x86_64` suffix drops resources).
const LABELS: Record<string, string> = { x86_64: "x64", arm64: "arm64" };
const hostArch = Deno.build.arch === "aarch64" ? "arm64" : "x86_64";
const DEFAULT_TIMESTAMP_URL = "http://timestamp.digicert.com";
const OS = "windows";

/** Build a Windows bundle directory for `arch` at dist/<name>-<label> (.ico icon). */
async function buildBundle(name: string, arch: "x86_64" | "arm64"): Promise<string> {
  return await buildDesktopBundle(import.meta.url, OS, {
    target: TARGETS[arch],
    out: `dist/${name}-${LABELS[arch]}`,
    icons: ["icons/app.ico", "desktop-icon.ico"],
  });
}

/** Authenticode-sign `file` (the bundle's .exe, or an .msi) when a certificate is configured;
 * else skip with a warning. */
async function sign(file: string): Promise<void> {
  const cert = Deno.env.get("DENEXT_WINDOWS_CERT");
  if (!cert) {
    console.warn(
      `  no DENEXT_WINDOWS_CERT set — ${file} is not Authenticode-signed.`,
    );
    return;
  }
  if (!(await has("signtool"))) {
    console.warn(
      `  signtool not found (Windows SDK) — ${file} is not signed; sign on a Windows host/CI.`,
    );
    return;
  }
  const timestamp = Deno.env.get("DENEXT_SIGN_TIMESTAMP_URL") ??
    DEFAULT_TIMESTAMP_URL;
  const args = [
    "sign",
    "/f",
    cert,
    "/fd",
    "sha256",
    "/tr",
    timestamp,
    "/td",
    "sha256",
  ];
  // signtool takes a .pfx password only as `/p` (no environment or file form), so it is
  // redacted from the failure message; keep it out of logs by setting it as a CI secret.
  const pass = Deno.env.get("DENEXT_WINDOWS_CERT_PASSWORD");
  if (pass) args.push("/p", pass);
  args.push(file);
  await run(["signtool", ...args], undefined, { secrets: pass ? [pass] : [] });
}

/** Build the .msi for a finished bundle with WiX 5; null when it can't be built here (off
 * Windows, no WiX 5, a version MSI can't express, a failed `wix build`) and the .msi was only a
 * default — an asked-for .msi fails the run instead. */
async function msi(
  name: string,
  arch: "x86_64" | "arm64",
  dir: string,
  meta: DesktopPackageMeta,
  explicit: boolean,
): Promise<string | null> {
  const what = `.msi for ${arch} (the .zip is built instead)`;
  if (!desktopToolGate(await desktopMsiProblem(meta.version), what, explicit)) return null;
  const out = `dist/${name}-${LABELS[arch]}.msi`;
  const exe = `${name}-${LABELS[arch]}.exe`;
  return await desktopOptionalInstaller(what, explicit, async () => {
    await buildDesktopMsi({ meta, bundleDir: dir, exe, arch, out });
    return out;
  });
}

/** Zip a bundle directory for distribution (prefers `zip`, falls back to bsdtar). */
async function zipBundle(
  name: string,
  arch: "x86_64" | "arm64",
  dir: string,
): Promise<string> {
  const zip = `dist/${name}-${LABELS[arch]}-windows.zip`;
  await Deno.remove(zip).catch(() => {});
  const rel = dir.replace(/^dist\//, "");
  if (await has("zip")) {
    await run(["sh", "-c", `cd dist && zip -r "${rel}-windows.zip" "${rel}"`]);
  } else {
    // bsdtar (default on Windows 10+/macOS) writes zip from the .zip suffix via -a.
    await run(["tar", "-a", "-c", "-f", zip, "-C", "dist", rel]);
  }
  return zip;
}

/** Ship the VC++ 2015-2022 runtime DLLs the deno desktop binary imports (VCRUNTIME140,
 * VCRUNTIME140_1, MSVCP140) next to the .exe, so the packaged app runs with NO redistributable
 * installed on the target (otherwise it dies at launch with a silent 0xC0000135 DLL-not-found).
 * Microsoft permits this app-local deployment. Sourced from System32 (the installed redist) when
 * packaging on Windows; a DLL that can't be found (e.g. packaging off Windows) is skipped with a
 * warning, and the target then needs the VC++ redist. System32 holds the HOST's architecture, so
 * a bundle for the other architecture gets none (its target needs the redist). */
async function bundleVcRuntime(dir: string, arch: string): Promise<boolean> {
  if (Deno.build.os !== "windows" || arch !== hostArch) {
    console.warn(
      "  not bundling the VC++ runtime (" + arch + " packaged on " +
        Deno.build.os + "/" +
        hostArch +
        ") — the target must install the VC++ 2015-2022 redistributable: " +
        "https://aka.ms/vs/17/release/vc_redist." +
        (arch === "arm64" ? "arm64" : "x64") + ".exe",
    );
    return false;
  }
  const sys = `${Deno.env.get("SystemRoot") ?? "C:/Windows"}/System32`;
  const dlls = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"];
  const missing: string[] = [];
  for (const dll of dlls) {
    try {
      await Deno.copyFile(`${sys}/${dll}`, `${dir}/${dll}`);
    } catch {
      missing.push(dll);
    }
  }
  if (missing.length === 0) {
    console.log(
      "  bundled the VC++ runtime app-local (the target needs no VC++ redistributable)",
    );
  } else {
    console.warn(
      "  could not bundle the VC++ runtime (" + missing.join(", ") +
        ") — package on Windows with the VC++ 2015-2022 redistributable installed, or the target " +
        "must install it: https://aka.ms/vs/17/release/vc_redist.x64.exe",
    );
  }
  return missing.length === 0;
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
  const vcBundled = await bundleVcRuntime(dir, arch);
  if (signing) await sign(`${dir}/${name}-${LABELS[arch]}.exe`);
  const out = [dir];
  const built = plan.formats.includes("msi")
    ? await msi(name, arch, dir, meta, plan.explicit)
    : null;
  if (built && signing) await sign(built);
  if (built) out.push(built);
  // A default .msi that could not be built falls back to the .zip.
  const msiSkipped = plan.formats.includes("msi") && !built;
  if (plan.formats.includes("zip") || msiSkipped) out.push(await zipBundle(name, arch, dir));
  return { out, vcBundled };
}

async function main(): Promise<void> {
  const opts = parseDesktopPackageArgs(Deno.args, { arches: ["host", "x86_64", "arm64", "both"] });
  // --format, else desktop.installers.windows in denext.config.ts, else an .msi; the
  // .deno-desktop/app.json sync, the package metadata (name, version, deep links), the export.
  const prepared = await prepareDesktopPackage(import.meta.url, OS, opts);
  const name = prepared.name;

  const artifacts: string[] = [];
  const noVcRuntime: string[] = [];
  for (const arch of desktopPackageArches(opts.arch)) {
    const { out, vcBundled } = await packageArch(name, arch, opts.sign, prepared);
    artifacts.push(...out);
    if (!vcBundled) noVcRuntime.push(arch);
  }

  console.log("\n  Built:");
  for (const a of artifacts) console.log("  " + a);
  console.log(
    noVcRuntime.length === 0
      ? "\n  (the target needs the Microsoft Edge WebView2 runtime; the VC++ runtime is bundled" +
        " app-local, so no VC++ redistributable is required)"
      : "\n  (the target needs the Microsoft Edge WebView2 runtime and, for " +
        noVcRuntime.join(", ") +
        ", the VC++ 2015-2022 redistributable: the VC++ runtime was not bundled; see above)",
  );
}

if (import.meta.main) await main();
