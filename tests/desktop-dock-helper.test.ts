// desktop.app.dock "while-window-open" (macOS): the config, the grants and the helper bundle
// packaging builds (src/build/desktop-dock-helper.ts), and the runtime that copies the helper into
// the data folder and keeps it running exactly while a window shows (src/desktop/dock-helper.ts).
// The visible behaviour (a Dock tile while a window is open, none in the recent apps after) is
// checked on a GitHub-hosted macOS runner by tests/fixtures/desktop-dock-helper/e2e.sh.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import { resolveDesktopAppSettings } from "../src/desktop/window-config.ts";
import { desktopActivationPolicy } from "../src/build/desktop-app-config.ts";
import { DESKTOP_DATA_TOKEN, desktopBuildFlags } from "../src/build/desktop-capabilities.ts";
import {
  addMacosDockHelper,
  dockHelperDisplayName,
  dockHelperFileName,
  dockHelperGrants,
  dockHelperInfoPlist,
  dockHelperSource,
  dockHelperWanted,
} from "../src/build/desktop-dock-helper.ts";
import {
  bundleOfExecutable,
  createDockPresence,
  type DockHelperChild,
  type DockHelperMessage,
  type DockWindow,
  findDockHelperSource,
  focusForDock,
  holdsDockIcon,
  installDockHelper,
  parseDockHelperLine,
  startDockHelper,
  treeFingerprint,
} from "../src/desktop/dock-helper.ts";
import { setUpDesktopWindows } from "../src/desktop/app-windows.ts";
import type { ActivationPolicy, DockLike } from "../src/desktop/caps/app.ts";

const ID = "dev.example.tray";
const config = (app: Record<string, unknown>, desktop: Record<string, unknown> = {}) => ({
  desktop: { app: { identifier: ID, ...app }, ...desktop },
});
const validate = (desktop: Record<string, unknown>) =>
  validateDenextConfig({ desktop } as DenextConfig);

Deno.test('config: desktop.app.dock takes a boolean or "while-window-open"', () => {
  validate({ app: { identifier: ID, dock: "while-window-open" } });
  validate({ app: { dock: false } });
  assertThrows(
    () => validate({ app: { identifier: ID, dock: "sometimes" } }),
    Error,
    "desktop.app.dock",
  );
  assertThrows(
    () => validate({ app: { dock: "while-window-open" } }),
    Error,
    "needs desktop.app.identifier",
  );
  assertThrows(
    () =>
      validate({ app: { identifier: ID, dock: "while-window-open", activationPolicy: "regular" } }),
    Error,
    "desktop.app.activationPolicy",
  );
  assertThrows(
    () => validate({ app: { identifier: ID, dock: "while-window-open" }, permissions: "strict" }),
    Error,
    '"strict" cannot be used with desktop.app.dock',
  );
  assertEquals(resolveDesktopAppSettings({ app: { dock: "while-window-open" } }), {
    dock: "while-window-open",
  });
  assertThrows(() => resolveDesktopAppSettings({ app: { dock: "yes" } }), Error, "app.dock");
  // The app itself starts (and stays) accessory: its helper holds the icon.
  assertEquals(desktopActivationPolicy(config({ dock: "while-window-open" })), "accessory");
  assertEquals(desktopActivationPolicy(config({ dock: true })), undefined);
});

class FakeDock extends EventTarget implements DockLike {
  visible: boolean[] = [];
  policies: string[] = [];
  setBadge() {}
  bounce() {}
  setVisible(visible: boolean) {
    this.visible.push(visible);
  }
  setActivationPolicy(policy: ActivationPolicy) {
    this.policies.push(policy);
    return true;
  }
  getActivationPolicy(): ActivationPolicy {
    return "accessory";
  }
}

class Win extends EventTarget {
  show() {}
  hide() {}
  setSkipTaskbar() {}
}

Deno.test('setup: "while-window-open" starts accessory on macOS; elsewhere windows keep their taskbar entry', () => {
  for (const [os, hidden] of [["darwin", [false]], ["linux", []], ["windows", []]] as const) {
    const dock = new FakeDock();
    setUpDesktopWindows({
      window: new Win(),
      dock,
      os,
      emit: () => {},
      wantsTray: true,
      appSettings: { dock: "while-window-open", keepAlive: true },
    });
    assertEquals(dock.visible, [...hidden], os);
    assertEquals(dock.policies, [], `${os}: never regular`);
  }
});

Deno.test("packaging: the helper's name, files, Info.plist and grants", () => {
  assert(dockHelperWanted(config({ dock: "while-window-open" }), "darwin"));
  assert(!dockHelperWanted(config({ dock: "while-window-open" }), "linux"));
  assert(!dockHelperWanted(config({ dock: true }), "darwin"));
  assert(!dockHelperWanted({ desktop: { app: { dock: "while-window-open" } } }, "darwin"));
  assertEquals(dockHelperDisplayName(config({ name: "Fleet" })), "Fleet");
  assertEquals(
    dockHelperDisplayName(config({}), { desktop: { app: { name: "From deno.json" } } }),
    "From deno.json",
  );
  assertEquals(dockHelperDisplayName(config({})), "tray");
  assertEquals(dockHelperFileName("Fleet"), "Fleet");
  assertEquals(dockHelperFileName("A, B/C"), "A- B-C");
  assertEquals(dockHelperFileName(".hidden"), "hidden");
  assertEquals(dockHelperFileName("✓"), "-");
  assertEquals(dockHelperFileName("  "), "App");
  assertEquals(dockHelperGrants(config({ name: "My App", dock: "while-window-open" }), "darwin"), {
    run: [`${DESKTOP_DATA_TOKEN}/dock-helper/My App.app/Contents/MacOS/My App`],
    write: [`${DESKTOP_DATA_TOKEN}/dock-helper`],
  });
  assertEquals(dockHelperGrants(config({ name: "Fleet", dock: false }), "darwin"), undefined);
  const plist = dockHelperInfoPlist({
    displayName: "Fleet",
    executable: "Fleet",
    owner: ID,
    version: "1.2.3",
    icon: "AppIcon",
  });
  for (
    const part of [
      "<key>CFBundleIdentifier</key>\n\t<string>dev.example.tray.dock</string>",
      "<key>CFBundleName</key>\n\t<string>Fleet</string>",
      "<key>CFBundleIconFile</key>\n\t<string>AppIcon</string>",
      "<key>CFBundleShortVersionString</key>\n\t<string>1.2.3</string>",
      "<key>DenextDockHelperFor</key>\n\t<string>dev.example.tray</string>",
    ]
  ) assertStringIncludes(plist, part);
  // A regular app: no LSUIElement.
  assert(!plist.includes("LSUIElement"));
});

Deno.test("packaging: the helper's grants are baked only for macOS on a runtime that expands the data folder", () => {
  const cfg = config({ name: "Fleet", dock: "while-window-open" });
  const flags = desktopBuildFlags(cfg, "darwin", { dataScope: true, cacheScope: true });
  const run = flags.find((f) => f.startsWith("--allow-run"));
  const write = flags.find((f) => f.startsWith("--allow-write"));
  assertEquals(run, `--allow-run=${DESKTOP_DATA_TOKEN}/dock-helper/Fleet.app/Contents/MacOS/Fleet`);
  assertEquals(write, `--allow-write=${DESKTOP_DATA_TOKEN}/dock-helper`);
  for (const [os, scope] of [["linux", true], ["windows", true], ["darwin", false]] as const) {
    const other = desktopBuildFlags(cfg, os, { dataScope: scope, cacheScope: scope });
    assert(!other.some((f) => f.includes("dock-helper")), `${os} ${scope}`);
  }
});

/** A bundle as `deno desktop` writes one, with an icon. */
async function fakeAppBundle(dir: string, archs = ["arm64"]): Promise<string> {
  const app = join(dir, "Tray.app");
  await Deno.mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await Deno.mkdir(join(app, "Contents", "Resources"), { recursive: true });
  await Deno.writeTextFile(join(app, "Contents", "MacOS", "laufey_webview"), archs.join(" "));
  await Deno.writeTextFile(join(app, "Contents", "Resources", "AppIcon.icns"), "icon");
  await Deno.writeTextFile(
    join(app, "Contents", "Info.plist"),
    dockHelperInfoPlist({ displayName: "Tray", executable: "laufey_webview", owner: ID }).replace(
      `${ID}.dock`,
      ID,
    ).replace("</dict>", "\t<key>CFBundleIconFile</key>\n\t<string>AppIcon</string>\n</dict>"),
  );
  return app;
}

/** Build tools that write marker files instead of running clang / lipo. */
function fakeTools(calls: string[]) {
  return {
    archs: async (file: string) => (await Deno.readTextFile(file)).split(" "),
    compile: async (source: string, arch: string, out: string) => {
      calls.push(`compile:${arch}`);
      assertStringIncludes(source, "DenextDockHelperFor");
      await Deno.writeTextFile(out, `helper-${arch}`);
    },
    lipo: async (inputs: string[], out: string) => {
      calls.push(`lipo:${inputs.length}`);
      await Deno.writeTextFile(out, "universal");
    },
  };
}

Deno.test("packaging: addMacosDockHelper builds Contents/Helpers/<Name>.app for the app's architectures", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const app = await fakeAppBundle(dir, ["x86_64", "arm64"]);
    const calls: string[] = [];
    const cfg = config({ name: "Fleet", dock: "while-window-open" });
    const helper = await addMacosDockHelper(cfg, app, undefined, fakeTools(calls));
    assertEquals(helper, join(app, "Contents", "Helpers", "Fleet.app"));
    assertEquals(calls, ["compile:x86_64", "compile:arm64", "lipo:2"]);
    const exe = join(helper!, "Contents", "MacOS", "Fleet");
    assertEquals(await Deno.readTextFile(exe), "universal");
    assert(((await Deno.stat(exe)).mode! & 0o111) !== 0, "executable");
    assertEquals(
      await Deno.readTextFile(join(helper!, "Contents", "Resources", "AppIcon.icns")),
      "icon",
    );
    assertEquals([...Deno.readDirSync(join(helper!, "Contents", "MacOS"))].map((e) => e.name), [
      "Fleet",
    ]);
    const plist = await Deno.readTextFile(join(helper!, "Contents", "Info.plist"));
    assertStringIncludes(plist, "<string>dev.example.tray.dock</string>");
    assertStringIncludes(plist, "<key>CFBundleIconFile</key>");
    // The runtime finds what packaging built.
    assertEquals(await findDockHelperSource(app), { bundle: helper!, fileName: "Fleet" });
    // Off unless asked for.
    assertEquals(
      await addMacosDockHelper(config({ dock: true }), app, undefined, fakeTools([])),
      undefined,
    );
    // One architecture: no lipo.
    const one: string[] = [];
    const thin = await fakeAppBundle(await Deno.makeTempDir({ dir }));
    await addMacosDockHelper(cfg, thin, undefined, fakeTools(one));
    assertEquals(one, ["compile:arm64"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("packaging: the helper's source is the packed native template", async () => {
  const source = await dockHelperSource();
  for (
    const part of [
      "NSApplicationActivationPolicyRegular",
      "yieldActivationToApplication",
      "DENEXT_DOCK_HELPER",
      "DenextDockHelperFor",
      "'why?'",
    ]
  ) assertStringIncludes(source, part);
});

Deno.test("runtime: the helper's messages and the app bundle of an executable", () => {
  assertEquals(parseDockHelperLine('{"t":"activate"}'), "activate");
  assertEquals(parseDockHelperLine('{"t":"quit"}'), "quit");
  assertEquals(parseDockHelperLine('{"t":"ready"}'), "ready");
  assertEquals(parseDockHelperLine('{"t":"exit"}'), undefined);
  assertEquals(parseDockHelperLine("garbage"), undefined);
  assertEquals(parseDockHelperLine("null"), undefined);
  assertEquals(
    bundleOfExecutable("/Applications/Fleet.app/Contents/MacOS/laufey_webview"),
    "/Applications/Fleet.app",
  );
  assertEquals(bundleOfExecutable("/usr/local/bin/deno"), undefined);
  assertEquals(bundleOfExecutable("/tmp/Contents/MacOS/x"), undefined);
});

Deno.test("runtime: the helper is copied into the data folder once, and again when it changed", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const app = await fakeAppBundle(dir);
    await addMacosDockHelper(
      config({ name: "Fleet", dock: "while-window-open" }),
      app,
      undefined,
      fakeTools([]),
    );
    const source = (await findDockHelperSource(app))!;
    const data = join(dir, "data");
    const exe = await installDockHelper(source, data);
    const copy = join(data, "dock-helper", "Fleet.app");
    assertEquals(exe, join(copy, "Contents", "MacOS", "Fleet"));
    assertEquals(await treeFingerprint(copy), await treeFingerprint(source.bundle));
    assertEquals((await Deno.stat(join(data, "dock-helper"))).mode! & 0o777, 0o700);
    assert(((await Deno.stat(exe)).mode! & 0o111) !== 0);
    // Unchanged: left alone.
    const before = (await Deno.stat(exe)).mtime;
    await installDockHelper(source, data);
    assertEquals((await Deno.stat(exe)).mtime, before);
    // A tampered copy is replaced.
    await Deno.writeTextFile(exe, "tampered");
    await installDockHelper(source, data);
    assertEquals(await Deno.readTextFile(exe), "helper-arm64");
    // A new version in the bundle is copied over the old one.
    await Deno.writeTextFile(join(source.bundle, "Contents", "MacOS", "Fleet"), "helper-v2");
    await installDockHelper(source, data);
    assertEquals(await Deno.readTextFile(exe), "helper-v2");
    // No staging folder is left behind.
    assertEquals([...Deno.readDirSync(join(data, "dock-helper"))].map((e) => e.name), [
      "Fleet.app",
    ]);
    // A link in the tree is refused.
    await Deno.symlink("/etc/hosts", join(source.bundle, "Contents", "link"));
    await assertRejects(() => installDockHelper(source, data), Error, "not a file or a folder");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runtime: no helper in the bundle (a run / dev build) keeps the accessory behaviour", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const app = await fakeAppBundle(dir);
    const warnings: string[] = [];
    const presence = await startDockHelper({
      windows: () => [],
      keyWindow: () => undefined,
      quit: () => {},
      dataDir: join(dir, "data"),
      warn: (m) => warnings.push(m),
      execPath: join(app, "Contents", "MacOS", "laufey_webview"),
    });
    assertEquals(presence, undefined);
    assertStringIncludes(warnings.join("\n"), "this build has no Dock helper");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** A fake helper child: `end()` makes it exit. */
function fakeChild() {
  let end!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (end = resolve));
  const c = {
    exits: 0,
    kills: 0,
    exit() {
      c.exits++;
      end(0);
    },
    kill() {
      c.kills++;
      end(143);
    },
    exited,
    end: (code = 1) => end(code),
  };
  return c satisfies DockHelperChild;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

Deno.test("presence: the helper runs exactly while a window shows", async () => {
  let showing = false;
  const children: ReturnType<typeof fakeChild>[] = [];
  let send: ((m: DockHelperMessage) => void) | undefined;
  const events: string[] = [];
  const presence = createDockPresence({
    wanted: () => showing,
    launch: (onMessage) => {
      send = onMessage;
      const c = fakeChild();
      children.push(c);
      return Promise.resolve(c);
    },
    onActivate: () => events.push("activate"),
    onQuit: () => events.push("quit"),
    warn: (m) => events.push(`warn:${m}`),
    stopDelayMs: 5,
    pollMs: 0,
  });
  presence.sync();
  assertEquals(presence.state(), "idle");
  showing = true;
  presence.sync();
  await tick();
  assertEquals(presence.state(), "running");
  assertEquals(children.length, 1);
  send!("activate");
  send!("quit");
  send!("ready");
  assertEquals(events, ["activate", "quit"]);
  // A window replaced by another within the delay keeps the helper.
  showing = false;
  presence.sync();
  showing = true;
  presence.sync();
  await tick(15);
  assertEquals(children[0].exits, 0);
  // The last window went away: the helper is asked to leave.
  showing = false;
  presence.sync();
  await tick(15);
  assertEquals(children[0].exits, 1);
  await tick();
  assertEquals(presence.state(), "idle");
  // Shown again: a new helper.
  showing = true;
  presence.sync();
  await tick();
  assertEquals(children.length, 2);
  presence.dispose();
  assertEquals(children[1].exits, 1);
  assertEquals(presence.state(), "disposed");
});

Deno.test("presence: a crashed helper is started again, and given up on after three crashes in a minute", async () => {
  const children: ReturnType<typeof fakeChild>[] = [];
  const warnings: string[] = [];
  const presence = createDockPresence({
    wanted: () => true,
    launch: () => {
      const c = fakeChild();
      children.push(c);
      return Promise.resolve(c);
    },
    onActivate: () => {},
    onQuit: () => {},
    warn: (m) => warnings.push(m),
    pollMs: 0,
  });
  presence.sync();
  await tick();
  for (let i = 0; i < 2; i++) {
    children.at(-1)!.end(1);
    await tick();
    assertEquals(presence.state(), "running", `restart ${i}`);
  }
  assertEquals(children.length, 3);
  children.at(-1)!.end(1);
  await tick();
  assertEquals(presence.state(), "failed");
  assertStringIncludes(warnings.join("\n"), "ended by itself 3 times");
  presence.sync();
  await tick();
  assertEquals(children.length, 3, "no more starts");
  presence.dispose();
});

Deno.test("presence: a helper that cannot start leaves the app accessory, with one warning", async () => {
  for (
    const launch of [
      () => Promise.resolve(undefined),
      () => Promise.reject(new Error("NotCapable")),
    ]
  ) {
    const warnings: string[] = [];
    let launches = 0;
    const presence = createDockPresence({
      wanted: () => true,
      launch: () => {
        launches++;
        return launch();
      },
      onActivate: () => {},
      onQuit: () => {},
      warn: (m) => warnings.push(m),
      pollMs: 0,
    });
    presence.sync();
    await tick();
    presence.sync();
    await tick();
    assertEquals(presence.state(), "failed");
    assertEquals(launches, 1);
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0], "without a Dock icon");
    presence.dispose();
  }
});

Deno.test("presence: a launch that finishes after the window went away is asked to leave", async () => {
  let showing = true;
  const c = fakeChild();
  let finish!: () => void;
  const presence = createDockPresence({
    wanted: () => showing,
    launch: () => new Promise((resolve) => (finish = () => resolve(c))),
    onActivate: () => {},
    onQuit: () => {},
    warn: () => {},
    stopDelayMs: 0,
    pollMs: 0,
  });
  presence.sync();
  showing = false;
  finish();
  await tick(5);
  assertEquals(c.exits, 1);
  presence.dispose();
});

/** A registered window for the presence. */
function dockWindow(
  kind: string,
  o: { visible?: boolean; minimized?: boolean; overlay?: boolean } = {},
): DockWindow & { calls: string[] } {
  const calls: string[] = [];
  return {
    kind,
    ...(o.overlay ? { overlay: true } : {}),
    calls,
    window: {
      isVisible: () => o.visible ?? true,
      isMinimized: () => o.minimized ?? false,
      restore: () => calls.push("restore"),
      focus: () => calls.push("focus"),
    },
  };
}

Deno.test("presence: which windows hold the Dock icon, and which one an activation brings up", () => {
  assert(holdsDockIcon(dockWindow("main")));
  assert(holdsDockIcon(dockWindow("window", { minimized: true })));
  assert(!holdsDockIcon(dockWindow("window", { visible: false })));
  assert(!holdsDockIcon(dockWindow("panel")));
  assert(!holdsDockIcon(dockWindow("window", { overlay: true })));
  const hidden = dockWindow("main", { visible: false });
  const a = dockWindow("window");
  const b = dockWindow("window", { minimized: true });
  focusForDock(b, [hidden, a, b]);
  assertEquals(b.calls, ["restore", "focus"]);
  // The key window is hidden: the last window that shows.
  focusForDock(hidden, [hidden, a]);
  assertEquals(a.calls, ["focus"]);
  assertEquals(hidden.calls, []);
});
