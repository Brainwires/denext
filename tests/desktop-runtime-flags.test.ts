// `--unstable-no-legacy-abort` for a `deno desktop` build: runtimes before 3.0.0-rc.5 needed it
// (so the app's server printed no Deno.serve legacy-abort notice), and from 3.0.0-rc.5 it is the
// runtime's default. denext 5.0 builds only on 3.0.0-rc.5 or later, so `desktop run` / `dev`, the
// Linux / Windows bundle command and the scaffolded macOS script pass no runtime flags at all;
// `desktopRuntimeDenoFlags` stays exported (always `[]`) for packaging scripts written before 5.0.

import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { desktopRuntimeDenoFlags } from "../src/build/desktop-runtime.ts";
import { desktopRuntimeDenoFlags as reexported } from "../src/build/desktop.ts";
import { desktopBundleCommand } from "../src/build/desktop-package-script.ts";
import { desktopLaunchBuildPlan, desktopLaunchScratchDir } from "../src/build/desktop-launch.ts";
import { scaffoldFiles } from "../src/build/scaffold.ts";

const FLAG = "--unstable-no-legacy-abort";
const PINNED = { DENORT_DESKTOP_BIN: "/cache/libdenort.so", LAUFEY_DEV_DIR: "/cache/laufey" };

Deno.test("desktopRuntimeDenoFlags: kept for pre-5.0 packaging scripts, and always empty", () => {
  assertEquals(desktopRuntimeDenoFlags(PINNED, []), []);
  assertEquals(desktopRuntimeDenoFlags({}), []);
  assertEquals(desktopRuntimeDenoFlags(), []);
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

Deno.test("package scripts: the Linux / Windows bundle command passes no runtime flag", async () => {
  const dir = await project();
  try {
    for (const os of ["linux", "windows"] as const) {
      const entry = toFileUrl(join(dir, "scripts", `package-${os}.ts`)).href;
      const o = { target: "x86_64-unknown-linux-gnu", out: "dist/a-x64", icons: [] };
      const cmd = await desktopBundleCommand(entry, os, o);
      assert(cmd.includes("desktop.ts") && !cmd.includes(FLAG), cmd.join(" "));
      // The split network grant: every runtime denext builds on has it.
      assert(cmd.some((a) => a.startsWith("--allow-net-listen")), cmd.join(" "));
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("package scripts: a flag in desktop.denoFlags is passed once, as the project wrote it", async () => {
  const dir = await project(
    `export default { desktop: { denoFlags: [${JSON.stringify(FLAG)}] } };\n`,
  );
  try {
    const entry = toFileUrl(join(dir, "scripts", "package-linux.ts")).href;
    const cmd = await desktopBundleCommand(entry, "linux", {
      target: "x86_64-unknown-linux-gnu",
      out: "dist/a-x64",
      icons: [],
    });
    assertEquals(cmd.filter((a) => a === FLAG).length, 1, cmd.join(" "));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop run / dev: the build passes no runtime flag, as the scripts do", async () => {
  const dir = await project();
  const scratch = await desktopLaunchScratchDir(dir);
  try {
    for (const dev of [false, true]) {
      const { args } = await desktopLaunchBuildPlan({
        projectDir: dir,
        config: {},
        os: "linux",
        denoFlags: [],
        entry: "desktop.ts",
        dev,
        scratch,
      });
      assert(args.includes("--output") && !args.includes(FLAG), args.join(" "));
      assert(args.some((a) => a.startsWith("--allow-net-listen")), args.join(" "));
    }
  } finally {
    await Deno.remove(scratch, { recursive: true });
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scaffold: the macOS script no longer asks for runtime flags", () => {
  const mac =
    scaffoldFiles({ dir: ".", desktop: true }).find((f) => f.path === "scripts/package-macos.ts")!
      .content;
  assert(!mac.includes("desktopRuntimeDenoFlags"), "a 5.0 script needs no runtime flags");
  assert(!mac.includes("DENEXT_DESKTOP_RUNTIME=stock"), "no stock-runtime opt-out documented");
  // The env is resolved once, before the command is assembled.
  assertEquals(mac.split("await desktopRuntimeEnv(").length, 2);
});
