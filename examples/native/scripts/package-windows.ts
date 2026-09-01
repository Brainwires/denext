#!/usr/bin/env -S deno run -A
/**
 * Package this `deno desktop` app for Windows distribution. `deno desktop` produces a
 * complete bundle directory (the `.exe`, its `.dll`s, and resources); this builds one or
 * both arches and wraps each as a `.zip`, then Authenticode-signs the `.exe` when a code-
 * signing certificate is provided. The `.exe` cross-builds from any OS; signing only runs
 * where `signtool` is available (Windows) and a cert is configured.
 *
 *   deno run -A scripts/package-windows.ts [--arch <mode>] [--no-export] [--no-sign]
 *
 * --arch  host | x86_64 | arm64 | both   (default: host)
 *           host    the machine's own architecture
 *           x86_64  x86_64-pc-windows-msvc
 *           arm64   aarch64-pc-windows-msvc
 *           both    x86_64 AND arm64 as two bundles
 * --no-export  skip `deno task export` and reuse the existing out/ (faster iteration)
 * --no-sign    skip Authenticode signing even when a certificate is configured
 *
 *   DENEXT_APP_NAME                output base name (default: the deno.json `desktop.app.name`).
 *   DENEXT_WINDOWS_CERT            path to a code-signing certificate (.pfx) — signing is
 *                                  skipped when unset (no secrets are ever baked in).
 *   DENEXT_WINDOWS_CERT_PASSWORD   the .pfx password, if any.
 *   DENEXT_SIGN_TIMESTAMP_URL      RFC-3161 timestamp server (default: DigiCert's).
 *
 * The end user's Windows machine needs the Microsoft Edge WebView2 runtime for the window
 * (preinstalled on current Windows 10/11); that is a deploy-environment dependency, not
 * baked into the bundle. Outputs into ./dist/.
 */

const TARGETS: Record<string, string> = {
  x86_64: "x86_64-pc-windows-msvc",
  arm64: "aarch64-pc-windows-msvc",
};
// Underscore-free labels for output paths: `deno desktop` derives a reverse-DNS bundle id
// from the output basename and rejects '_' (so a raw `x86_64` suffix drops resources).
const LABELS: Record<string, string> = { x86_64: "x64", arm64: "arm64" };
const hostArch = Deno.build.arch === "aarch64" ? "arm64" : "x86_64";
const DEFAULT_TIMESTAMP_URL = "http://timestamp.digicert.com";

interface Opts {
  arch: "host" | "x86_64" | "arm64" | "both";
  export: boolean;
  sign: boolean;
}

function parseOpts(argv: string[]): Opts {
  const o: Opts = { arch: "host", export: true, sign: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--arch") o.arch = argv[++i] as Opts["arch"];
    else if (a.startsWith("--arch=")) o.arch = a.slice(7) as Opts["arch"];
    else if (a === "--no-export") o.export = false;
    else if (a === "--no-sign") o.sign = false;
    else if (a === "-h" || a === "--help") {
      console.log(
        new URL(import.meta.url).pathname,
        "\nSee the header comment for usage.",
      );
      Deno.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  const valid = ["host", "x86_64", "arm64", "both"];
  if (!valid.includes(o.arch)) {
    throw new Error(`--arch must be one of ${valid.join(", ")}`);
  }
  return o;
}

async function run(cmd: string[]): Promise<void> {
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await p.output();
  if (code !== 0) throw new Error(`command failed (${code}): ${cmd.join(" ")}`);
}

/** Whether a command exists on PATH. */
async function has(cmd: string): Promise<boolean> {
  const probe = Deno.build.os === "windows"
    ? { args: ["/c", "where", cmd] }
    : { args: ["-c", `command -v ${cmd}`] };
  const bin = Deno.build.os === "windows" ? "cmd" : "sh";
  return await new Deno.Command(bin, { ...probe, stdout: "null", stderr: "null" })
    .output().then((r) => r.code === 0, () => false);
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

/** Build a Windows bundle directory for `arch` at dist/<name>-<label>. */
async function buildBundle(
  name: string,
  arch: "x86_64" | "arm64",
): Promise<string> {
  const out = `dist/${name}-${LABELS[arch]}`;
  await Deno.remove(out, { recursive: true }).catch(() => {});
  const cmd = [
    "deno",
    "desktop",
    "-A",
    "--include",
    "out",
    "--target",
    TARGETS[arch],
  ];
  // Windows uses an .ico icon; deno desktop skips a non-.ico gracefully.
  for (const icon of ["icons/app.ico", "desktop-icon.ico"]) {
    try {
      await Deno.stat(icon);
      cmd.push("--icon", icon);
      break;
    } catch { /* no icon at this path */ }
  }
  cmd.push("--output", out, "desktop.ts");
  await run(cmd);
  return out;
}

/** Authenticode-sign the bundle's .exe when a certificate is configured; else skip. */
async function sign(name: string, arch: "x86_64" | "arm64", dir: string): Promise<void> {
  const cert = Deno.env.get("DENEXT_WINDOWS_CERT");
  if (!cert) {
    console.warn(
      `  no DENEXT_WINDOWS_CERT set — skipping Authenticode signing for ${arch} (zip still built).`,
    );
    return;
  }
  if (!(await has("signtool"))) {
    console.warn(
      `  signtool not found (Windows SDK) — skipping signing for ${arch}; sign on a Windows host/CI.`,
    );
    return;
  }
  const exe = `${dir}/${name}-${LABELS[arch]}.exe`;
  const timestamp = Deno.env.get("DENEXT_SIGN_TIMESTAMP_URL") ?? DEFAULT_TIMESTAMP_URL;
  const args = ["sign", "/f", cert, "/fd", "sha256", "/tr", timestamp, "/td", "sha256"];
  const pass = Deno.env.get("DENEXT_WINDOWS_CERT_PASSWORD");
  if (pass) args.push("/p", pass);
  args.push(exe);
  await run(["signtool", ...args]);
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

/** Filesystem-safe base name (spaces/punctuation → hyphens) for artifact paths. */
function slugify(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "app";
}

async function main(): Promise<void> {
  const opts = parseOpts(Deno.args);
  const name = slugify(await appName());
  await Deno.mkdir("dist", { recursive: true });
  if (opts.export) await run(["deno", "task", "export"]);

  const arches: Array<"x86_64" | "arm64"> = opts.arch === "both"
    ? ["x86_64", "arm64"]
    : [opts.arch === "host" ? hostArch : opts.arch];

  const artifacts: string[] = [];
  for (const arch of arches) {
    const dir = await buildBundle(name, arch);
    if (opts.sign) await sign(name, arch, dir);
    artifacts.push(await zipBundle(name, arch, dir));
  }

  console.log("\n  Built:");
  for (const a of artifacts) console.log("  " + a);
  console.log(
    "\n  (the target Windows machine needs the Microsoft Edge WebView2 runtime installed)",
  );
}

if (import.meta.main) await main();
