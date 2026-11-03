// `desktop.backend` per OS: one config, a CEF Linux build and a system-WebView macOS / Windows
// build. Before it every reader took deno.json's single `desktop.backend` for every target, so the
// Linux package, its runtime download and both doctors could not differ from macOS.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  desktopBackendOsOfTarget,
  desktopBackendProblem,
  resolveDesktopBackend,
} from "../src/desktop/engine-backend.ts";
import {
  DESKTOP_RUNTIME_PIN,
  desktopRuntimeStatus,
  projectDesktopBackend,
} from "../src/build/desktop-runtime.ts";
import { packageMetaFrom } from "../src/build/desktop-installers.ts";
import { desktopBackendArgs, desktopBundleCommand } from "../src/build/desktop-package-script.ts";
import { MACOS_PACKAGE_SCRIPT } from "../src/build/desktop-package-scripts.ts";
import { desktopLaunchBuildPlan } from "../src/build/desktop-launch.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import { runDesktopDoctor } from "../src/build/desktop-doctor.ts";
import { desktopLaunchPolicyCheck, desktopRuntimeCheck } from "../src/cli/commands/doctor.ts";
import { projectLaunchPolicy } from "../src/cli/commands/desktop-doctor.ts";
import { staleBackendMismatch } from "../src/cli/commands/desktop.ts";

const LINUX_CEF = { desktop: { backend: { linux: "cef" } } } as const;
const LINUX = "x86_64-unknown-linux-gnu";
const MAC = "aarch64-apple-darwin";
const WINDOWS = "x86_64-pc-windows-msvc";

/** A desktop project with `scripts/`, the given config source and deno.json. */
async function project(
  config: string | null,
  deno: unknown = {},
): Promise<{ dir: string; entry: (os: string) => string }> {
  const dir = await Deno.makeTempDir({ prefix: "denext_backend_per_os_" });
  await Deno.mkdir(join(dir, "scripts"));
  await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify(deno));
  await Deno.writeTextFile(join(dir, "desktop.ts"), "export {};\n");
  if (config !== null) await Deno.writeTextFile(join(dir, "denext.config.ts"), config);
  return {
    dir,
    entry: (os) => toFileUrl(join(dir, "scripts", `package-${os}.ts`)).href,
  };
}

const CONFIG_SOURCE = 'export default { desktop: { backend: { linux: "cef" } } };\n';

Deno.test("resolveDesktopBackend: one engine, per OS, default, unset", () => {
  assertEquals(resolveDesktopBackend(undefined, "linux"), undefined);
  assertEquals(resolveDesktopBackend("cef", "darwin"), "cef");
  assertEquals(resolveDesktopBackend({ linux: "cef" }, "linux"), "cef");
  assertEquals(resolveDesktopBackend({ linux: "cef" }, "darwin"), "webview");
  assertEquals(resolveDesktopBackend({ linux: "cef" }, "windows"), "webview");
  assertEquals(resolveDesktopBackend({ default: "cef", macos: "webview" }, "windows"), "cef");
  assertEquals(resolveDesktopBackend({ default: "cef", macos: "webview" }, "darwin"), "webview");
  assertEquals(resolveDesktopBackend({}, "linux"), "webview");
  assertThrows(
    () => resolveDesktopBackend({ linux: "gtk4" }, "linux"),
    Error,
    "desktop.backend.linux",
  );
  assertThrows(() => resolveDesktopBackend("electron", "linux"), Error, "per-OS object");
});

Deno.test("desktopBackendProblem names the key; desktopBackendOsOfTarget reads a triple", () => {
  assertEquals(desktopBackendProblem(undefined), null);
  assertEquals(desktopBackendProblem({ windows: "cef", default: "webview" }), null);
  assertEquals(desktopBackendProblem({ linux: "chromium" }), {
    field: "desktop.backend.linux",
    message: 'must be "webview" or "cef"',
  });
  assertStringIncludes(desktopBackendProblem({ ios: "cef" })!.message, 'unknown key "ios"');
  assertEquals(desktopBackendProblem(["cef"])!.field, "desktop.backend");
  assertEquals(desktopBackendProblem(3)!.field, "desktop.backend");
  assertEquals(desktopBackendOsOfTarget(MAC), "darwin");
  assertEquals(desktopBackendOsOfTarget(LINUX), "linux");
  assertEquals(desktopBackendOsOfTarget("aarch64-unknown-linux-gnu"), "linux");
  assertEquals(desktopBackendOsOfTarget(WINDOWS), "windows");
  assertEquals(desktopBackendOsOfTarget("wasm32-unknown-unknown"), null);
});

Deno.test("projectDesktopBackend: the config's per-OS value first, deno.json's string after", async () => {
  const { dir } = await project(CONFIG_SOURCE, { desktop: { backend: "webview" } });
  try {
    // The loaded config.
    assertEquals(await projectDesktopBackend(dir, { target: LINUX, config: LINUX_CEF }), "cef");
    assertEquals(await projectDesktopBackend(dir, { target: MAC, config: LINUX_CEF }), "webview");
    assertEquals(await projectDesktopBackend(dir, { target: "linux", config: LINUX_CEF }), "cef");
    // Read as data (the doctors): the same answer, nothing run.
    assertEquals(await projectDesktopBackend(dir, { target: LINUX }), "cef");
    assertEquals(await projectDesktopBackend(dir, { target: WINDOWS }), "webview");
    // No config value: deno.json's engine for every target.
    await Deno.writeTextFile(join(dir, "deno.json"), '{ "desktop": { "backend": "cef" } }');
    assertEquals(await projectDesktopBackend(dir, { target: MAC, config: undefined }), "cef");
    await assertRejects(
      () => projectDesktopBackend(dir, { target: "wasm32-unknown-unknown", config: undefined }),
      Error,
      "no Deno Desktop target OS",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("projectDesktopBackend: a per-OS object in deno.json says where it goes", async () => {
  const { dir } = await project(null, { desktop: { backend: { linux: "cef" } } });
  try {
    await assertRejects(
      () => projectDesktopBackend(dir, { target: LINUX }),
      Error,
      "Put a per-OS value in denext.config.ts desktop.backend",
    );
    // A config whose `desktop` is computed is not read as data: deno.json's value then.
    await Deno.writeTextFile(join(dir, "deno.json"), '{ "desktop": { "backend": "cef" } }');
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      'const d = { backend: "webview" };\nexport default { desktop: d };\n',
    );
    assertEquals(await projectDesktopBackend(dir, { target: LINUX }), "cef");
    // An invalid config value is refused, not taken for unset.
    await assertRejects(
      () => projectDesktopBackend(dir, { target: LINUX, config: { desktop: { backend: 1 } } }),
      Error,
      "desktop.backend must be",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("package metadata: a Linux target gets CEF, macOS and Windows the webview, from one config", () => {
  const deno = { desktop: { backend: "webview" } };
  assertEquals(packageMetaFrom(deno, LINUX_CEF, "App", undefined, "linux").backend, "cef");
  assertEquals(packageMetaFrom(deno, LINUX_CEF, "App", undefined, "darwin").backend, "webview");
  assertEquals(packageMetaFrom(deno, LINUX_CEF, "App", undefined, "windows").backend, "webview");
  // Nothing in the config: deno.json's single engine, as before.
  assertEquals(
    packageMetaFrom({ desktop: { backend: "cef" } }, {}, "App", undefined, "darwin").backend,
    "cef",
  );
  assertEquals(packageMetaFrom({}, {}, "App", undefined, "linux").backend, "webview");
});

Deno.test("package scripts: deno desktop gets the target OS's --backend", async () => {
  const { dir, entry } = await project(CONFIG_SOURCE, { desktop: { backend: "webview" } });
  try {
    const backendOf = (cmd: string[]) => cmd[cmd.indexOf("--backend") + 1];
    const linux = await desktopBundleCommand(entry("linux"), "linux", {
      target: LINUX,
      out: "dist/a-x64",
      icons: [],
    });
    const windows = await desktopBundleCommand(entry("windows"), "windows", {
      target: WINDOWS,
      out: "dist/a-x64",
      icons: [],
    });
    assertEquals(backendOf(linux), "cef");
    assertEquals(backendOf(windows), "webview");
    assertEquals(await desktopBackendArgs(entry("macos"), "darwin"), ["--backend", "webview"]);
    assertEquals(await desktopBackendArgs(entry("linux"), "linux"), ["--backend", "cef"]);
    // The macOS script passes its engine too.
    assertStringIncludes(
      MACOS_PACKAGE_SCRIPT,
      'cmd.push(...await desktopBackendArgs(import.meta.url, "darwin"));',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop run / dev: the host OS's --backend", async () => {
  const { dir } = await project(CONFIG_SOURCE);
  const scratch = await Deno.makeTempDir({ prefix: "denext_backend_scratch_" });
  try {
    const plan = (os: "linux" | "darwin") =>
      desktopLaunchBuildPlan({
        projectDir: dir,
        config: LINUX_CEF,
        os,
        denoFlags: [],
        entry: "desktop.ts",
        dev: false,
        scratch,
      });
    const linux = (await plan("linux")).args;
    const mac = (await plan("darwin")).args;
    assertEquals(linux[linux.indexOf("--backend") + 1], "cef");
    assertEquals(mac[mac.indexOf("--backend") + 1], "webview");
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(scratch, { recursive: true });
  }
});

/** `desktopRuntimeStatus` for `target`, with the pin's Deno and an empty cache. */
async function statusFor(dir: string, target: string, config?: unknown) {
  const cacheRoot = await Deno.makeTempDir({ prefix: "denext_backend_cache_" });
  try {
    return await desktopRuntimeStatus({
      projectDir: dir,
      target,
      ...(config === undefined ? {} : { config }),
      env: () => undefined,
      cacheRoot,
      denoVersion: () => Promise.resolve(DESKTOP_RUNTIME_PIN.deno),
    });
  } finally {
    await Deno.remove(cacheRoot, { recursive: true });
  }
}

Deno.test("runtime: each target's flavour comes from its own backend", async () => {
  const { dir } = await project(CONFIG_SOURCE);
  try {
    const linux = await statusFor(dir, LINUX, LINUX_CEF);
    const mac = await statusFor(dir, MAC, LINUX_CEF);
    assertEquals([linux.backend, mac.backend], ["cef", "webview"]);
    assertStringIncludes(linux.detail, `${LINUX}/cef`);
    assertStringIncludes(mac.detail, `${MAC}/webview`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop doctor and denext doctor: the backend of the OS they check", async () => {
  const { dir } = await project(CONFIG_SOURCE);
  try {
    // desktop doctor reads the config as data: CEF on Linux, so its CEF checks run there.
    const linux = await statusFor(dir, LINUX);
    assertEquals(linux.backend, "cef");
    const windows = await statusFor(dir, WINDOWS);
    assertEquals(windows.backend, "webview");
    const report = await runDesktopDoctor({
      runtimeStatus: () => Promise.resolve(windows),
      os: "windows",
      env: () => undefined,
    });
    assert(!report.checks.includes("cef-signing"), report.checks.join());
    const cefWindows = await statusFor(dir, WINDOWS, { desktop: { backend: { default: "cef" } } });
    const cefReport = await runDesktopDoctor({
      runtimeStatus: () => Promise.resolve(cefWindows),
      os: "windows",
      env: () => undefined,
    });
    assert(cefReport.checks.includes("cef-signing"), cefReport.checks.join());
    // denext doctor passes the loaded config.
    const check = await desktopRuntimeCheck(dir, {
      target: LINUX,
      config: LINUX_CEF,
      env: () => undefined,
      cacheRoot: join(dir, ".cache"),
      denoVersion: () => Promise.resolve(DESKTOP_RUNTIME_PIN.deno),
    });
    assertStringIncludes(check!.detail, `${LINUX}/cef`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("config validation: desktop.backend takes an engine or a per-OS object", () => {
  const validate = (backend: unknown) =>
    validateDenextConfig({ desktop: { backend } } as unknown as DenextConfig);
  validate("cef");
  validate({ linux: "cef", default: "webview" });
  assertThrows(() => validate({ linux: "chromium" }), Error, "`desktop.backend.linux` must be");
  assertThrows(() => validate({ android: "cef" }), Error, 'unknown key "android"');
  assertThrows(() => validate("gtk"), Error, "`desktop.backend` must be");
});

/** The macOS template with its desktopBackendArgs call taken out (a script from before it). */
const STALE_MACOS_SCRIPT = MACOS_PACKAGE_SCRIPT
  .replace(/^.*desktop\.backend.*\n.*desktopBackendArgs.*\n/m, "")
  .replace(/^.*The macOS engine.*\n.*desktopBackendArgs.*\n/m, "");

Deno.test("both doctors flag a macOS package script that never passes desktop.backend", async () => {
  assert(!STALE_MACOS_SCRIPT.includes("desktopBackendArgs"), "template shape moved");
  const { dir } = await project(CONFIG_SOURCE, { desktop: { backend: "webview" } });
  try {
    const script = join(dir, "scripts", "package-macos.ts");
    await Deno.writeTextFile(script, MACOS_PACKAGE_SCRIPT);
    assertEquals(await projectLaunchPolicy(dir), []);
    assertEquals((await desktopLaunchPolicyCheck(dir, LINUX_CEF))!.ok, true);
    await Deno.writeTextFile(script, STALE_MACOS_SCRIPT);
    const [problem] = (await projectLaunchPolicy(dir))!;
    assertStringIncludes(problem.message, "scripts/package-macos.ts never passes desktop.backend");
    assertEquals(problem.fix, "denext desktop package --regenerate-scripts");
    const check = (await desktopLaunchPolicyCheck(dir, LINUX_CEF))!;
    assertEquals(check.ok, false);
    assertStringIncludes(check.detail, "never passes desktop.backend");
    assertStringIncludes(check.detail, "--regenerate-scripts");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("staleBackendMismatch: refused only while macOS's engine differs from deno.json's", async () => {
  const { dir } = await project(null, { desktop: { backend: "webview" } });
  try {
    // macOS keeps the system WebView either way: the stale script builds the right engine.
    assertEquals(await staleBackendMismatch(dir, LINUX_CEF, "package-macos.ts"), null);
    assertEquals(await staleBackendMismatch(dir, undefined, "package-macos.ts"), null);
    const refused = await staleBackendMismatch(
      dir,
      { desktop: { backend: { macos: "cef" } } },
      "package-macos.ts",
    );
    assertStringIncludes(refused!, "scripts/package-macos.ts does not pass desktop.backend");
    assertStringIncludes(refused!, 'build deno.json\'s "webview" engine on the "cef" runtime');
    assertStringIncludes(refused!, "--regenerate-scripts");
    // One engine for every OS that matches deno.json's: nothing to refuse.
    await Deno.writeTextFile(join(dir, "deno.json"), '{ "desktop": { "backend": "cef" } }');
    assertEquals(
      await staleBackendMismatch(dir, { desktop: { backend: "cef" } }, "package-macos.ts"),
      null,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
