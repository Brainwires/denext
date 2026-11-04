// `denext desktop run` / `dev` build the app with `deno desktop` into a scratch directory and launch
// the built executable (src/build/desktop-launch.ts). These cover the command construction: the
// output lands outside the project, the permissions and flags match the packaging scripts', the
// executable launched per OS, and the dev-build mark that lets a `desktop dev` build proxy.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  DESKTOP_DEV_ENTRY_FILE,
  desktopDevEntrySource,
  desktopLaunchBuildArgs,
  desktopLaunchBuildPlan,
  desktopLaunchBundle,
  desktopLaunchExecutable,
  desktopLaunchName,
  desktopLaunchScratchDir,
  isInsideDir,
  withNetHosts,
  writeDesktopDevEntry,
} from "../src/build/desktop-launch.ts";
import { DESKTOP_DEV_BUILD_KEY } from "../src/build/desktop-dev-build.ts";
import { desktopBundleCommand } from "../src/build/desktop-package-script.ts";
import { desktopDevProxyDecision } from "../src/build/desktop.ts";

/** A project whose config enables capabilities that widen the permissions, plus an extension. */
async function project(): Promise<{ dir: string; config: unknown }> {
  const dir = await Deno.makeTempDir({ prefix: "denext_desktop_launch_" });
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  await Deno.writeTextFile(join(dir, "desktop.ts"), "");
  await Deno.mkdir(join(dir, "desktop"));
  await Deno.writeTextFile(join(dir, "desktop", "ext.ts"), "");
  await Deno.writeTextFile(
    join(dir, "denext.config.ts"),
    `export default {
  desktop: {
    app: { name: "My App" },
    capabilities: {
      fs: true,
      secureStore: true,
      shell: { openExternal: ["https:"] },
      extensions: ["./desktop/ext.ts"],
    },
    extraPermissions: { net: ["api.example.com"] },
  },
};
`,
  );
  const config = (await import(toFileUrl(join(dir, "denext.config.ts")).href)).default;
  return { dir, config };
}

/** `args` without the value of each named option (`--output X` → `--output`) and without a pair. */
function normalize(args: string[], drop: string[], blank: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (drop.includes(args[i])) {
      i++;
      continue;
    }
    out.push(args[i]);
    if (blank.includes(args[i])) i++;
  }
  return out;
}

Deno.test("desktop run: the build has the packaging scripts' flags, output outside the project", async () => {
  const { dir, config } = await project();
  const scratch = await desktopLaunchScratchDir(dir);
  try {
    assert(!isInsideDir(scratch, dir), `${scratch} is outside ${dir}`);
    for (const os of ["linux", "windows"] as const) {
      const plan = await desktopLaunchBuildPlan({
        projectDir: dir,
        config,
        os,
        denoFlags: ["--node-modules-dir=none"],
        entry: "desktop.ts",
        dev: false,
        scratch,
      });
      // What `scripts/package-<os>.ts` runs for the same project (its desktop.denoFlags read from
      // the config; this config sets none, so the planned build's are spliced in for the compare).
      const scriptUrl = toFileUrl(join(dir, "scripts", `package-${os}.ts`)).href;
      const pkg = await desktopBundleCommand(scriptUrl, os, {
        target: "x86_64-unknown-linux-gnu",
        out: "dist/x",
        icons: [],
      });
      const pkgArgs = pkg.slice(1);
      const at = pkgArgs.indexOf("--include");
      pkgArgs.splice(at, 0, "--node-modules-dir=none");
      assertEquals(
        normalize(plan.args, [], ["--output"]),
        normalize(pkgArgs, ["--target"], ["--output"]),
        `${os}: the same flags in the same order as the package script`,
      );
      assertEquals(plan.args.at(-1), "desktop.ts");
      const output = plan.args[plan.args.indexOf("--output") + 1];
      assertEquals(output, join(scratch, "My-App"));
      assert(isInsideDir(output, scratch) && !isInsideDir(output, dir));
      assertEquals(plan.bundle, output);
    }
    // The least-privilege flags themselves: loopback + the extra host, write for fs, no -A.
    const darwin = await desktopLaunchBuildPlan({
      projectDir: dir,
      config,
      os: "darwin",
      denoFlags: [],
      entry: "desktop.ts",
      dev: false,
      scratch,
    });
    assertEquals(darwin.bundle, `${join(scratch, "My-App")}.app`);
    assert(darwin.args.includes("--no-prompt"));
    assert(darwin.args.includes("--allow-net=127.0.0.1,api.example.com,localhost"));
    assert(darwin.args.includes("--allow-write"));
    assert(!darwin.args.includes("-A") && !darwin.args.includes("--allow-all"));
    assertStringIncludes(darwin.args.join(" "), "--include out --include ./desktop/ext.ts");
  } finally {
    await Deno.remove(scratch, { recursive: true });
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop dev: no export embedded, the generated entry, a LAN host added to --allow-net", async () => {
  const { dir, config } = await project();
  const scratch = await desktopLaunchScratchDir(dir);
  try {
    const entry = await writeDesktopDevEntry(dir, join(dir, ".denext"), "desktop.ts");
    assertEquals(entry, join(".denext", DESKTOP_DEV_ENTRY_FILE));
    const source = await Deno.readTextFile(join(dir, entry));
    assertStringIncludes(source, `Symbol.for(${JSON.stringify(DESKTOP_DEV_BUILD_KEY)})] = true`);
    assertStringIncludes(source, 'await import("../desktop.ts")');
    const plan = await desktopLaunchBuildPlan({
      projectDir: dir,
      config,
      os: "linux",
      denoFlags: [],
      entry,
      dev: true,
      netHosts: ["192.168.1.5"],
      scratch,
    });
    assert(!plan.args.includes("out"), "dev proxies to the dev server: no export embedded");
    assert(plan.args.includes("--allow-net=127.0.0.1,192.168.1.5,api.example.com,localhost"));
    assertEquals(plan.args.at(-1), entry);
  } finally {
    await Deno.remove(scratch, { recursive: true });
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop dev: a recorded program sidecar names its file relative to the generated entry", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_desktop_launch_sidecar_" });
  const scratch = await desktopLaunchScratchDir(dir);
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    await Deno.writeTextFile(join(dir, "desktop.ts"), "");
    await Deno.mkdir(join(dir, "bin"));
    await Deno.writeTextFile(join(dir, "bin", "server"), "packaged");
    const config = {
      desktop: {
        app: { name: "My App", identifier: "com.example.app" },
        sidecars: [{ name: "server", run: { exec: "./bin/server" } }],
      },
    };
    const entry = await writeDesktopDevEntry(dir, join(dir, ".denext"), "desktop.ts");
    const runGrant = async (entry: string) =>
      (await desktopLaunchBuildPlan({
        projectDir: dir,
        config,
        os: "linux",
        denoFlags: [],
        entry,
        appEntry: "desktop.ts",
        dev: entry !== "desktop.ts",
        scratch,
        sidecarIntegrity: true,
      })).args.find((a) => a.startsWith("--allow-run"));
    // The runtime resolves `#embedded=` from the compiled entry's folder (`.denext/`).
    assertStringIncludes((await runGrant(entry)) ?? "", "#embedded=../bin/server");
    assertStringIncludes((await runGrant("desktop.ts")) ?? "", "#embedded=bin/server");
  } finally {
    await Deno.remove(scratch, { recursive: true });
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop run / dev --entry app/desktop.ts: a program sidecar is the file the app resolves", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_desktop_launch_nested_" });
  const scratch = await desktopLaunchScratchDir(dir);
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    await Deno.mkdir(join(dir, "app", "bin"), { recursive: true });
    await Deno.writeTextFile(join(dir, "app", "desktop.ts"), "");
    await Deno.writeTextFile(join(dir, "app", "bin", "server"), "packaged");
    const config = {
      desktop: {
        app: { name: "My App", identifier: "com.example.app" },
        sidecars: [{ name: "server", run: { exec: "./bin/server" } }],
      },
    };
    // The `--include`s are read from the project's config file, as a packaging script reads them.
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      `export default ${JSON.stringify(config)};\n`,
    );
    const plan = (entry: string, dev: boolean) =>
      desktopLaunchBuildPlan({
        projectDir: dir,
        config,
        os: "linux",
        denoFlags: [],
        entry,
        appEntry: "app/desktop.ts",
        dev,
        scratch,
        sidecarIntegrity: true,
      });
    const included = (args: string[]) =>
      args.flatMap((a, i) => args[i - 1] === "--include" ? [a] : []);
    // `desktop run` compiles the entry itself: the app resolves `./bin/server` from `app/`.
    const run = (await plan("app/desktop.ts", false)).args;
    assert(included(run).includes("app/bin/server"), run.join(" "));
    assertStringIncludes(
      run.find((a) => a.startsWith("--allow-run")) ?? "",
      "#embedded=bin/server",
    );
    // `desktop dev` compiles the generated entry, which imports `app/desktop.ts`.
    const entry = await writeDesktopDevEntry(dir, join(dir, ".denext"), "app/desktop.ts");
    const dev = (await plan(entry, true)).args;
    assert(included(dev).includes("app/bin/server"), dev.join(" "));
    assertStringIncludes(
      dev.find((a) => a.startsWith("--allow-run")) ?? "",
      "#embedded=../app/bin/server",
    );
  } finally {
    await Deno.remove(scratch, { recursive: true });
    await Deno.remove(dir, { recursive: true });
  }
});

/** A project whose app entry is `app/desktop.ts`, with an extension, a module and a Node backend. */
async function nestedProject(): Promise<{ dir: string; config: unknown }> {
  const dir = await Deno.makeTempDir({ prefix: "denext_desktop_launch_nested_inc_" });
  const files: Record<string, string> = {
    "deno.json": "{}",
    "desktop.ts": "",
    "app/desktop.ts": "",
    "app/ext.ts": "",
    "app/worker/main.ts": "",
    "srv/main.mjs": "console.log(1);\n",
  };
  for (const [rel, text] of Object.entries(files)) {
    await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, rel), text);
  }
  await Deno.mkdir(join(dir, "srv", "node_modules"));
  const config = {
    desktop: {
      app: { name: "My App", identifier: "com.example.app" },
      capabilities: { extensions: ["./ext.ts", "jsr:@x/ext"] },
      sidecars: [
        { name: "worker", run: { module: "./worker/main.ts" } },
        { name: "api", run: { module: "srv/main.mjs", nodeModules: "srv/node_modules" } },
      ],
    },
  };
  await Deno.writeTextFile(
    join(dir, "denext.config.ts"),
    `export default ${JSON.stringify(config)};\n`,
  );
  return { dir, config };
}

/** The `--include` values of `args`. */
function includes(args: readonly string[]): string[] {
  return args.flatMap((a, i) => args[i - 1] === "--include" ? [a] : []);
}

Deno.test("desktop run / dev --entry app/desktop.ts: an extension, a module sidecar and a Node backend's bundle are embedded where the app loads them", async () => {
  const { dir, config } = await nestedProject();
  const scratch = await desktopLaunchScratchDir(dir);
  const log = console.log;
  console.log = () => {};
  try {
    const plan = (entry: string, dev: boolean) =>
      desktopLaunchBuildPlan({
        projectDir: dir,
        config,
        os: "linux",
        denoFlags: [],
        entry,
        appEntry: "app/desktop.ts",
        dev,
        scratch,
      });
    // What the app loads, resolved as it resolves them against `app/desktop.ts`'s URL.
    const base = toFileUrl(join(dir, "app", "desktop.ts")).href;
    const fromApp = (spec: string) =>
      new URL(spec, base).href.slice(toFileUrl(dir).href.length + 1);
    const want = [
      fromApp("./ext.ts"),
      "jsr:@x/ext",
      fromApp("./.deno-desktop/sidecars/api"),
      fromApp("./worker/main.ts"),
    ];
    assertEquals(want, [
      "app/ext.ts",
      "jsr:@x/ext",
      "app/.deno-desktop/sidecars/api",
      "app/worker/main.ts",
    ]);
    const check = (got: string[], what: string) => {
      assert(got.includes("app/ext.ts"), `${what}: the extension (${got.join(" ")})`);
      assert(got.includes("app/worker/main.ts"), `${what}: the module sidecar (${got.join(" ")})`);
      assert(
        got.includes("app/.deno-desktop/sidecars/api"),
        `${what}: the Node backend's bundle (${got.join(" ")})`,
      );
    };
    // `desktop run` compiles the entry itself.
    const run = includes((await plan("app/desktop.ts", false)).args);
    check(run, "desktop run");
    assertEquals(run, ["out", ...want]);
    // The bundle is on disk where the app loads it.
    const main = join(dir, "app", ".deno-desktop", "sidecars", "api", "main.mjs");
    assert(await Deno.stat(main).then(() => true, () => false), main);
    // `desktop dev` compiles the generated entry, which imports `app/desktop.ts`.
    const entry = await writeDesktopDevEntry(dir, join(dir, ".denext"), "app/desktop.ts");
    const dev = includes((await plan(entry, true)).args);
    check(dev, "desktop dev");
    assertEquals(dev, want);
  } finally {
    console.log = log;
    await Deno.remove(scratch, { recursive: true });
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop run / dev: an entry at the project root gets the same flags and includes as before", async () => {
  const { dir, config } = await nestedProject();
  const scratch = await desktopLaunchScratchDir(dir);
  const log = console.log;
  console.log = () => {};
  try {
    const plan = (entry: string, dev: boolean, appEntry?: string) =>
      desktopLaunchBuildPlan({
        projectDir: dir,
        config,
        os: "linux",
        denoFlags: [],
        entry,
        ...(appEntry === undefined ? {} : { appEntry }),
        dev,
        scratch,
      });
    const run = (await plan("desktop.ts", false)).args;
    // Every path as written in the config, the bundle in the project's `.deno-desktop/`.
    assertEquals(includes(run), [
      "out",
      "./ext.ts",
      "jsr:@x/ext",
      ".deno-desktop/sidecars/api",
      "./worker/main.ts",
    ]);
    assertEquals((await plan("desktop.ts", false, "desktop.ts")).args, run);
    assertEquals((await plan("desktop.ts", false, "./desktop.ts")).args, run);
    const entry = await writeDesktopDevEntry(dir, join(dir, ".denext"), "desktop.ts");
    const dev = (await plan(entry, true, "desktop.ts")).args;
    assertEquals(includes(dev), includes(run).slice(1));
    assertEquals(
      dev.filter((a) => a.startsWith("--allow-")),
      run.filter((a) => a.startsWith("--allow-")),
    );
  } finally {
    console.log = log;
    await Deno.remove(scratch, { recursive: true });
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('desktop run / dev: a "strict" that cannot be honoured warns loudly and bakes the default (packaging refuses it)', async () => {
  const { dir } = await project();
  const scratch = await desktopLaunchScratchDir(dir);
  try {
    const warnings: string[] = [];
    const plan = await desktopLaunchBuildPlan({
      projectDir: dir,
      // No desktop.app.identifier: strict mode can't name the app's folders.
      config: { desktop: { app: { name: "My App" }, permissions: "strict" } },
      os: "linux",
      denoFlags: [],
      entry: "desktop.ts",
      dev: true,
      scratch,
      warn: (line) => warnings.push(line),
    });
    assertEquals(warnings.length, 1, warnings.join("\n"));
    assertStringIncludes(warnings[0], "WARNING");
    assertStringIncludes(warnings[0], "desktop.app.identifier is not set");
    assertStringIncludes(warnings[0], "`denext desktop package` refuses");
    assert(plan.args.includes("--allow-read") && plan.args.includes("--allow-env"));
    // An honourable or default config warns about nothing.
    const quiet: string[] = [];
    await desktopLaunchBuildPlan({
      projectDir: dir,
      config: { desktop: { app: { name: "My App" } } },
      os: "linux",
      denoFlags: [],
      entry: "desktop.ts",
      dev: true,
      scratch,
      warn: (line) => quiet.push(line),
    });
    assertEquals(quiet, []);
  } finally {
    await Deno.remove(scratch, { recursive: true });
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktopLaunchScratchDir: refuses a temp dir inside the project", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_desktop_launch_" });
  try {
    await assertRejects(
      () =>
        desktopLaunchScratchDir(dir, async () => {
          const inside = join(dir, "tmp-inside");
          await Deno.mkdir(inside);
          return inside;
        }),
      Error,
      "inside the project",
    );
    // …and removed what it was handed.
    assertEquals(await Deno.stat(join(dir, "tmp-inside")).then(() => true, () => false), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("isInsideDir", () => {
  assert(isInsideDir("/a/b/c", "/a/b"));
  assert(isInsideDir("/a/b", "/a/b"));
  assert(!isInsideDir("/a/bc", "/a/b"));
  assert(!isInsideDir("/tmp/x", "/a/b"));
  assert(!isInsideDir("/a", "/a/b"));
});

Deno.test("the launched executable per OS (the .app's CFBundleExecutable on macOS)", async () => {
  const out = join("/s", "My-App");
  assertEquals(desktopLaunchBundle("darwin", out), join("/s", "My-App.app"));
  assertEquals(desktopLaunchBundle("linux", out), out);
  assertEquals(desktopLaunchBundle("windows", out), out);
  const plist = `<?xml version="1.0"?><plist><dict>
  <key>CFBundleName</key><string>My App</string>
  <key>CFBundleExecutable</key>
  <string>laufey_webview</string>
</dict></plist>`;
  let read = "";
  const exe = await desktopLaunchExecutable("darwin", join("/s", "My-App.app"), (p) => {
    read = p;
    return Promise.resolve(plist);
  });
  assertEquals(read, join("/s", "My-App.app", "Contents", "Info.plist"));
  assertEquals(exe, join("/s", "My-App.app", "Contents", "MacOS", "laufey_webview"));
  assertEquals(await desktopLaunchExecutable("linux", out), join(out, "My-App"));
  assertEquals(await desktopLaunchExecutable("windows", out), join(out, "My-App.exe"));
  await assertRejects(
    () => desktopLaunchExecutable("darwin", "/s/X.app", () => Promise.resolve("<plist/>")),
    Error,
    "CFBundleExecutable",
  );
});

Deno.test("desktopLaunchName: a name every OS's deno desktop keeps as is", () => {
  assertEquals(desktopLaunchName("My App"), "My-App");
  assertEquals(desktopLaunchName("denext native"), "denext-native");
  assertEquals(desktopLaunchName("my.app.v2"), "my-app-v2"); // Linux cuts at the last dot
  assertEquals(desktopLaunchName("libfoo"), "app-libfoo"); // Linux drops a leading lib
  assertEquals(desktopLaunchName("  "), "app");
});

Deno.test("withNetHosts / desktopLaunchBuildArgs", () => {
  assertEquals(withNetHosts(["--allow-net=localhost", "--allow-read"], ["10.0.0.2"]), [
    "--allow-net=10.0.0.2,localhost",
    "--allow-read",
  ]);
  assertEquals(withNetHosts(["--allow-net"], ["10.0.0.2"]), ["--allow-net"]);
  assertEquals(withNetHosts(["--allow-read"], ["10.0.0.2"]), [
    "--allow-read",
    "--allow-net=10.0.0.2",
  ]);
  assertEquals(withNetHosts(["--allow-net=localhost"], []), ["--allow-net=localhost"]);
  assertEquals(
    desktopLaunchBuildArgs({
      permissionFlags: ["--allow-net=localhost"],
      denoFlags: ["--no-check"],
      extraArgs: ["--include", "./ext.ts"],
      iconArgs: ["--icon", "icons/app.png"],
      includeOut: true,
      output: "/s/app",
      entry: "desktop.ts",
    }),
    [
      "desktop",
      "--no-prompt",
      "--allow-net=localhost",
      "--no-check",
      "--include",
      "out",
      "--include",
      "./ext.ts",
      "--icon",
      "icons/app.png",
      "--output",
      "/s/app",
      "desktop.ts",
    ],
  );
});

Deno.test("desktopDevEntrySource: a relative specifier with forward slashes", () => {
  assertStringIncludes(desktopDevEntrySource("..\\desktop.ts"), 'await import("../desktop.ts")');
  assertStringIncludes(desktopDevEntrySource("desktop.ts"), 'await import("./desktop.ts")');
});

Deno.test("desktopDevProxyDecision: a dev build proxies; a packaged app still ignores the env", () => {
  const packaged = "/tmp/x/My-App.app/Contents/MacOS/laufey_webview";
  assertEquals(desktopDevProxyDecision("http://localhost:3000", false, packaged).proxy, false);
  assertEquals(desktopDevProxyDecision("http://localhost:3000", false, packaged, true), {
    proxy: true,
    target: "http://localhost:3000",
    allowNonLoopback: false,
    injectToken: true,
  });
  // The mark does not lift the loopback rule.
  assertEquals(
    desktopDevProxyDecision("http://192.168.1.5:3000", false, packaged, true).proxy,
    false,
  );
  assertEquals(
    desktopDevProxyDecision("http://192.168.1.5:3000", true, packaged, true).proxy,
    true,
  );
});
