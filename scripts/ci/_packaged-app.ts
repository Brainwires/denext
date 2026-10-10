// What the packaged-app CI tests (desktop-relocation-smoke.ts, desktop-sidecar-smoke.ts) share: a
// copy of this checkout for a scratch app's import map, packaging it with the scaffolded script on
// denext's pinned runtime, finding the executable, and reporting.

import { copy } from "@std/fs";
import { join, resolve, toFileUrl } from "@std/path";
import { desktopLaunchExecutable } from "../../src/build/desktop-launch.ts";

/** This checkout. */
export const ROOT = resolve(import.meta.dirname!, "..", "..");

/** The Linux bundle directory's suffix per architecture (`dist/<name>-<label>`). */
const LINUX_LABELS: Record<string, string> = { x86_64: "x64", aarch64: "arm64" };

/** Exit 2 unless this is macOS or Linux. */
export function requireMacOrLinux(script: string): void {
  if (Deno.build.os !== "darwin" && Deno.build.os !== "linux") {
    console.error(`${script}: macOS / Linux only`);
    Deno.exit(2);
  }
}

/** Run a command in `cwd`, streaming its output; throw on a non-zero exit. */
export async function run(cmd: string[], cwd: string): Promise<void> {
  const { code } = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited with ${code}`);
}

/** Copy this checkout's `mod.ts` and `src/` to `dest` (a denext the scratch app maps). */
export async function copyDenext(dest: string): Promise<void> {
  await Deno.mkdir(dest, { recursive: true });
  await copy(join(ROOT, "mod.ts"), join(dest, "mod.ts"));
  await copy(join(ROOT, "src"), join(dest, "src"));
}

/**
 * This checkout's import map with its local targets pointing into `denext` (absolute `file:`
 * URLs), and `denext/desktop` mapped there too; plus the compiler options.
 */
export async function denextDenoJson(denext: string): Promise<{
  compilerOptions: unknown;
  imports: Record<string, string>;
}> {
  const root = JSON.parse(await Deno.readTextFile(join(ROOT, "deno.json")));
  const imports: Record<string, string> = {};
  for (const [key, value] of Object.entries(root.imports as Record<string, string>)) {
    imports[key] = value.startsWith("./") ? toFileUrl(join(denext, value)).href : value;
  }
  imports["denext/desktop"] = toFileUrl(join(denext, "src", "build", "desktop.ts")).href;
  return { compilerOptions: root.compilerOptions, imports };
}

/**
 * Package the app in `app` with the scaffolded script for this OS (regenerated from the current
 * template, no export) and return the executable to launch.
 */
export async function packageApp(app: string, appName: string): Promise<string> {
  const cli = join(ROOT, "cli.ts");
  await run(
    [Deno.execPath(), "run", "-A", cli, "desktop", "package", "--regenerate-scripts", "."],
    app,
  );
  const script = Deno.build.os === "darwin" ? "package-macos.ts" : "package-linux.ts";
  await run([Deno.execPath(), "run", "-A", join("scripts", script), "--no-export"], app);
  // Linux: the bundle directory `dist/<name>-<label>` holds a launcher of the same name.
  const os = Deno.build.os as "darwin" | "linux";
  const bundle = os === "darwin"
    ? join(app, "dist", `${appName}.app`)
    : join(app, "dist", `${appName}-${LINUX_LABELS[Deno.build.arch]}`);
  return await desktopLaunchExecutable(os, bundle);
}

/** Print the problems and exit 1, or print `ok`. */
export function report(name: string, problems: readonly string[], ok: string): void {
  if (problems.length > 0) {
    console.error(`\n✗ ${name}:\n  - ${problems.join("\n  - ")}`);
    Deno.exit(1);
  }
  console.log(`\n✓ ${name}: ${ok}`);
}
