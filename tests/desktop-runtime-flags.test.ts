// A `deno desktop` build on denext's pinned runtime passes `--unstable-no-legacy-abort`, which the
// runtime keeps from the app's metadata (2.9.7-denext.21): the app's server prints no Deno.serve
// legacy-abort notice on its first request, as `build --compile` binaries. `desktop run` / `dev`,
// the Linux / Windows bundle command and the scaffolded macOS script all pass it; a stock-runtime
// build (an empty runtime env) does not.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { desktopRuntimeDenoFlags } from "../src/build/desktop-runtime.ts";
import { desktopRuntimeDenoFlags as reexported } from "../src/build/desktop.ts";
import { desktopBundleCommand } from "../src/build/desktop-package-script.ts";
import { desktopLaunchBuildPlan, desktopLaunchScratchDir } from "../src/build/desktop-launch.ts";
import { scaffoldFiles } from "../src/build/scaffold.ts";

const FLAG = "--unstable-no-legacy-abort";
const PINNED = { DENORT_DESKTOP_BIN: "/cache/libdenort.so", LAUFEY_DEV_DIR: "/cache/laufey" };

Deno.test("desktopRuntimeDenoFlags: the pinned runtime gets --unstable-no-legacy-abort, stock none", () => {
  assertEquals(desktopRuntimeDenoFlags(PINNED), [FLAG]);
  assertEquals(desktopRuntimeDenoFlags({}), []);
  // Already in desktop.denoFlags: not repeated.
  assertEquals(desktopRuntimeDenoFlags(PINNED, ["--no-check", FLAG]), []);
  assertEquals(reexported, desktopRuntimeDenoFlags, "denext/desktop exports it for the scripts");
});

/** A temp project with a desktop entry and `scripts/`. */
async function project(config = "export default {};\n"): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_desktop_rtflags_" });
  await Deno.mkdir(join(dir, "scripts"));
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  await Deno.writeTextFile(join(dir, "desktop.ts"), "");
  await Deno.writeTextFile(join(dir, "denext.config.ts"), config);
  return dir;
}

Deno.test("package scripts: the Linux / Windows bundle command passes the flag on the pinned runtime", async () => {
  const dir = await project();
  try {
    for (const os of ["linux", "windows"] as const) {
      const entry = toFileUrl(join(dir, "scripts", `package-${os}.ts`)).href;
      const o = { target: "x86_64-unknown-linux-gnu", out: "dist/a-x64", icons: [] };
      const pinned = await desktopBundleCommand(entry, os, o, PINNED);
      const at = pinned.indexOf(FLAG);
      assert(at > 2 && at < pinned.indexOf("desktop.ts"), pinned.join(" "));
      assert(at < pinned.indexOf("--include"), "a runtime flag, before the embedded files");
      assert(!(await desktopBundleCommand(entry, os, o, {})).includes(FLAG), `${os}: stock`);
      assert(!(await desktopBundleCommand(entry, os, o)).includes(FLAG), `${os}: no env`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("package scripts: a flag already in desktop.denoFlags is passed once", async () => {
  const dir = await project(
    `export default { desktop: { denoFlags: [${JSON.stringify(FLAG)}] } };\n`,
  );
  try {
    const entry = toFileUrl(join(dir, "scripts", "package-linux.ts")).href;
    const cmd = await desktopBundleCommand(entry, "linux", {
      target: "x86_64-unknown-linux-gnu",
      out: "dist/a-x64",
      icons: [],
    }, PINNED);
    assertEquals(cmd.filter((a) => a === FLAG).length, 1, cmd.join(" "));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop run / dev: the build passes the flag on the pinned runtime, as the scripts do", async () => {
  const dir = await project();
  const scratch = await desktopLaunchScratchDir(dir);
  try {
    const plan = (runtimeEnv?: Record<string, string>, dev = false) =>
      desktopLaunchBuildPlan({
        projectDir: dir,
        config: {},
        os: "linux",
        denoFlags: [],
        runtimeEnv,
        entry: "desktop.ts",
        dev,
        scratch,
      });
    for (const dev of [false, true]) {
      const { args } = await plan(PINNED, dev);
      const at = args.indexOf(FLAG);
      assert(at > 0 && at < args.indexOf("--output"), args.join(" "));
      assert(!(await plan({}, dev)).args.includes(FLAG), "stock runtime: none");
      assert(!(await plan(undefined, dev)).args.includes(FLAG), "no runtime env: none");
    }
    // Same position as the package script's.
    const entry = toFileUrl(join(dir, "scripts", "package-linux.ts")).href;
    const pkg = await desktopBundleCommand(entry, "linux", {
      target: "x86_64-unknown-linux-gnu",
      out: "dist/a-x64",
      icons: [],
    }, PINNED);
    const { args } = await plan(PINNED);
    assertEquals(args[args.indexOf(FLAG) - 1], pkg[pkg.indexOf(FLAG) - 1]);
    assertEquals(args[args.indexOf(FLAG) + 1], pkg[pkg.indexOf(FLAG) + 1]);
  } finally {
    await Deno.remove(scratch, { recursive: true });
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scaffold: the macOS script passes the pinned runtime's flags (regenerate-scripts picks it up)", () => {
  const mac =
    scaffoldFiles({ dir: ".", desktop: true }).find((f) => f.path === "scripts/package-macos.ts")!
      .content;
  assertStringIncludes(mac, "  desktopRuntimeDenoFlags,\n");
  assertStringIncludes(mac, "...desktopRuntimeDenoFlags(env, denoFlags),");
  // The env is resolved before the command is assembled, and once.
  const env = mac.indexOf("const env = await desktopRuntimeEnv(import.meta.url, target);");
  assert(env > 0 && env < mac.indexOf("...desktopRuntimeDenoFlags(env, denoFlags),"));
  assertEquals(mac.split("await desktopRuntimeEnv(").length, 2);
});
