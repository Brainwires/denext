#!/usr/bin/env -S deno run -A
/**
 * Package this `deno desktop` app for Linux distribution. `deno desktop` produces a
 * complete bundle directory (the executable, its `.so`, and a freedesktop `.desktop`
 * launcher); this builds one or both arches and wraps each as a `.tar.gz` (and an
 * AppImage when `appimagetool` is available). Cross-builds from any OS.
 *
 *   deno run -A scripts/package-linux.ts [--arch <mode>] [--no-export] [--appimage]
 *
 * --arch  host | x86_64 | arm64 | both   (default: host)
 *           host    the machine's own architecture (x86_64 when cross-building from macOS Intel)
 *           x86_64  x86_64-unknown-linux-gnu
 *           arm64   aarch64-unknown-linux-gnu
 *           both    x86_64 AND arm64 as two bundles
 * --no-export  skip `deno task export` and reuse the existing out/ (faster iteration)
 * --appimage   also build an AppImage per arch (needs `appimagetool` on PATH)
 *
 *   DENEXT_APP_NAME  output base name (default: the deno.json `desktop.app.name`).
 *
 * The end user's Linux desktop needs a WebKitGTK runtime (webkit2gtk) for the window;
 * that is a deploy-environment dependency, not baked into the bundle. Outputs into ./dist/.
 */

const TARGETS: Record<string, string> = {
  x86_64: "x86_64-unknown-linux-gnu",
  arm64: "aarch64-unknown-linux-gnu",
};
// Underscore-free labels for output paths: `deno desktop` derives a reverse-DNS bundle id
// from the output basename and rejects '_' (so a raw `x86_64` suffix drops the .desktop file).
const LABELS: Record<string, string> = { x86_64: "x64", arm64: "arm64" };
const hostArch = Deno.build.arch === "aarch64" ? "arm64" : "x86_64";

interface Opts {
  arch: "host" | "x86_64" | "arm64" | "both";
  export: boolean;
  appimage: boolean;
}

function parseOpts(argv: string[]): Opts {
  const o: Opts = { arch: "host", export: true, appimage: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--arch") o.arch = argv[++i] as Opts["arch"];
    else if (a.startsWith("--arch=")) o.arch = a.slice(7) as Opts["arch"];
    else if (a === "--no-export") o.export = false;
    else if (a === "--appimage") o.appimage = true;
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

/** Build a Linux bundle directory for `arch` at dist/<name>-<label>. */
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
  // Linux uses a PNG icon; deno desktop skips a non-PNG gracefully.
  for (const icon of ["icons/app.png", "desktop-icon.png"]) {
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

/** Build an AppImage for a bundle if appimagetool is available; returns its path or null. */
async function appImage(
  name: string,
  arch: "x86_64" | "arm64",
  dir: string,
): Promise<string | null> {
  const tool = await new Deno.Command("sh", {
    args: ["-c", "command -v appimagetool"],
    stdout: "null",
    stderr: "null",
  }).output().then((r) => r.code === 0, () => false);
  if (!tool) {
    console.warn(
      `  appimagetool not found — skipping AppImage for ${arch} (tar.gz still built).`,
    );
    return null;
  }
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
    artifacts.push(await tarball(name, arch, dir));
    if (opts.appimage) {
      const img = await appImage(name, arch, dir);
      if (img) artifacts.push(img);
    }
  }

  console.log("\n  Built:");
  for (const a of artifacts) console.log("  " + a);
  console.log(
    "\n  (the target Linux desktop needs a WebKitGTK / webkit2gtk runtime installed)",
  );
}

if (import.meta.main) await main();
