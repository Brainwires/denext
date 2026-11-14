// desktop.app.dock "while-window-open": the edges of the packaging half
// (src/build/desktop-dock-helper.ts) and the runtime half (src/desktop/dock-helper.ts) that
// tests/desktop-dock-helper.test.ts leaves out — name fallbacks, malformed bundles, the default
// build tools failing, a helper folder with strays in it, the hello handshake's refusals and the
// presence's timers. Everything runs on fakes and loopback sockets: no clang, lipo success, open
// or GUI.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { renderPlist } from "../src/build/plist-value.ts";
import type { PlistNode } from "../src/build/plist-value.ts";
import {
  addMacosDockHelper,
  type DockHelperBuildSeams,
  dockHelperDisplayName,
  dockHelperGrants,
  dockHelperInfoPlist,
  dockHelperWanted,
} from "../src/build/desktop-dock-helper.ts";
import {
  closeForDock,
  createDockPresence,
  type DockHelperChild,
  type DockHelperMessage,
  type DockWindow,
  findDockHelperSource,
  focusForDock,
  holdsDockIcon,
  installDockHelper,
  launchDockHelper,
  startDockHelper,
} from "../src/desktop/dock-helper.ts";

const ID = "dev.example.tray";
const wanted = (app: Record<string, unknown> = {}) => ({
  desktop: { app: { identifier: ID, dock: "while-window-open", ...app } },
});

/** A temp folder for `fn`, removed after. */
async function inTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext-dock-cov-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** An app bundle whose Info.plist holds exactly `keys` (plus the executable `laufey_webview`). */
async function appBundle(
  dir: string,
  keys: Record<string, string>,
  o: { archs?: string[]; icon?: string } = {},
): Promise<string> {
  const app = join(dir, "Tray.app");
  await Deno.mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await Deno.mkdir(join(app, "Contents", "Resources"), { recursive: true });
  await Deno.writeTextFile(
    join(app, "Contents", "MacOS", "laufey_webview"),
    (o.archs ?? ["arm64"]).join(" "),
  );
  if (o.icon) await Deno.writeTextFile(join(app, "Contents", "Resources", o.icon), "icon");
  const entries: Array<[string, PlistNode]> = Object.entries(keys).map((
    [k, text],
  ) => [k, { kind: "string", text }]);
  await Deno.writeTextFile(
    join(app, "Contents", "Info.plist"),
    renderPlist({ kind: "dict", entries }),
  );
  return app;
}

/** Build tools that write marker files; `skipParts` leaves the per-arch files unwritten. */
function fakeTools(calls: string[], skipParts = false): Required<DockHelperBuildSeams> {
  return {
    archs: async (file) => (await Deno.readTextFile(file)).split(" "),
    compile: async (_source, arch, out) => {
      calls.push(`compile:${arch}`);
      if (!skipParts || !out.endsWith(`.${arch}`)) await Deno.writeTextFile(out, `helper-${arch}`);
    },
    lipo: async (inputs, out) => {
      calls.push(`lipo:${inputs.length}`);
      await Deno.writeTextFile(out, "universal");
    },
  };
}

Deno.test("packaging: the helper's name falls back to deno.json's identifier, and to none", () => {
  const noId = { desktop: { app: { dock: "while-window-open" } } };
  assertEquals(
    dockHelperDisplayName(noId, { desktop: { app: { identifier: "a.b.Clock" } } }),
    "Clock",
  );
  assertEquals(dockHelperDisplayName(noId), undefined);
  assertEquals(dockHelperDisplayName(null), undefined);
  assertEquals(dockHelperDisplayName({ desktop: { app: "nope" } }), undefined);
  assertEquals(
    dockHelperDisplayName({ desktop: { app: { name: 7, identifier: "..." } } }),
    undefined,
  );
  assertEquals(dockHelperDisplayName({ desktop: { app: { name: "  Spaced  " } } }), "Spaced");
  assert(!dockHelperWanted(undefined, "darwin"));
  assert(!dockHelperWanted(wanted({ identifier: "   " }), "darwin"));
  assertEquals(dockHelperGrants(wanted(), "linux"), undefined);
});

Deno.test("packaging: the Info.plist without an icon, with a build number apart from the version", () => {
  const bare = dockHelperInfoPlist({ displayName: "Fleet", executable: "Fleet", owner: ID });
  assert(!bare.includes("CFBundleIconFile"));
  assertStringIncludes(bare, "<key>CFBundleShortVersionString</key>\n\t<string>1.0</string>");
  assertStringIncludes(bare, "<key>CFBundleVersion</key>\n\t<string>1</string>");
  const built = dockHelperInfoPlist({
    displayName: "Fleet",
    executable: "Fleet",
    owner: ID,
    version: "2.0",
    build: "42",
  });
  assertStringIncludes(built, "<key>CFBundleVersion</key>\n\t<string>42</string>");
  const versionOnly = dockHelperInfoPlist({
    displayName: "Fleet",
    executable: "Fleet",
    owner: ID,
    version: "2.0",
  });
  assertStringIncludes(versionOnly, "<key>CFBundleVersion</key>\n\t<string>2.0</string>");
});

Deno.test("packaging: the helper takes the app's version, build, identifier and an .icns icon", async () => {
  await inTemp(async (dir) => {
    const app = await appBundle(dir, {
      CFBundleExecutable: "laufey_webview",
      CFBundleIdentifier: "dev.example.bundle",
      CFBundleName: "Bundled",
      CFBundleShortVersionString: "3.1.4",
      CFBundleVersion: "314",
      CFBundleIconFile: "Tray.icns",
    }, { icon: "Tray.icns" });
    // An old helper in the bundle is replaced.
    await Deno.mkdir(join(app, "Contents", "Helpers", "Fleet.app", "stale"), { recursive: true });
    const helper = await addMacosDockHelper(
      wanted({ name: "Fleet" }),
      app,
      undefined,
      fakeTools([]),
    );
    assertEquals(helper, join(app, "Contents", "Helpers", "Fleet.app"));
    await assertRejects(() => Deno.stat(join(helper!, "stale")), Deno.errors.NotFound);
    const plist = await Deno.readTextFile(join(helper!, "Contents", "Info.plist"));
    for (
      const part of [
        "<string>dev.example.bundle.dock</string>",
        "<key>DenextDockHelperFor</key>\n\t<string>dev.example.bundle</string>",
        "<key>CFBundleShortVersionString</key>\n\t<string>3.1.4</string>",
        "<key>CFBundleVersion</key>\n\t<string>314</string>",
        "<key>CFBundleIconFile</key>\n\t<string>Tray.icns</string>",
      ]
    ) assertStringIncludes(plist, part);
    assertEquals(
      await Deno.readTextFile(join(helper!, "Contents", "Resources", "Tray.icns")),
      "icon",
    );
    assertEquals(await Deno.readTextFile(join(helper!, "Contents", "PkgInfo")), "APPL????");
  });
});

Deno.test("packaging: a name-less identifier takes the bundle's name, else App; a missing icon file is left out", async () => {
  await inTemp(async (dir) => {
    const named = await appBundle(await Deno.makeTempDir({ dir }), {
      CFBundleExecutable: "laufey_webview",
      CFBundleName: "Bundled",
      CFBundleIconFile: "Gone",
    });
    // "..." has no last part: the bundle's own name, and the config's identifier as the owner.
    const helper = await addMacosDockHelper(
      wanted({ identifier: "..." }),
      named,
      undefined,
      fakeTools([]),
    );
    assertEquals(helper, join(named, "Contents", "Helpers", "Bundled.app"));
    const plist = await Deno.readTextFile(join(helper!, "Contents", "Info.plist"));
    assert(!plist.includes("CFBundleIconFile"), "no icon copied, none named");
    assertStringIncludes(plist, "<key>DenextDockHelperFor</key>\n\t<string>...</string>");
    const anon = await appBundle(await Deno.makeTempDir({ dir }), {
      CFBundleExecutable: "laufey_webview",
    });
    assertEquals(
      await addMacosDockHelper(wanted({ identifier: "..." }), anon, undefined, fakeTools([])),
      join(anon, "Contents", "Helpers", "App.app"),
    );
  });
});

Deno.test("packaging: a bundle whose Info.plist is not a dict, or names no executable, is refused", async () => {
  await inTemp(async (dir) => {
    const app = await appBundle(dir, { CFBundleName: "Tray" });
    await assertRejects(
      () => addMacosDockHelper(wanted(), app, undefined, fakeTools([])),
      Error,
      "has no CFBundleExecutable",
    );
    await Deno.writeTextFile(
      join(app, "Contents", "Info.plist"),
      renderPlist({ kind: "string", text: "x" }),
    );
    await assertRejects(
      () => addMacosDockHelper(wanted(), app, undefined, fakeTools([])),
      Error,
      "Info.plist is not a dict",
    );
  });
});

Deno.test("packaging: per-architecture parts that are already gone do not fail the merge", async () => {
  await inTemp(async (dir) => {
    const app = await appBundle(dir, { CFBundleExecutable: "laufey_webview" }, {
      archs: ["x86_64", "arm64"],
    });
    const calls: string[] = [];
    const helper = await addMacosDockHelper(wanted(), app, undefined, fakeTools(calls, true));
    assertEquals(calls, ["compile:x86_64", "compile:arm64", "lipo:2"]);
    assertEquals(
      await Deno.readTextFile(join(helper!, "Contents", "MacOS", "tray")),
      "universal",
    );
  });
});

Deno.test("packaging: the default build tools fail with the step's message on a bundle they cannot build", async () => {
  await inTemp(async (dir) => {
    // The executable is a text file: `lipo -archs` cannot read it (or lipo is not installed).
    const app = await appBundle(dir, { CFBundleExecutable: "laufey_webview" });
    const tools = fakeTools([]);
    await assertRejects(
      () =>
        addMacosDockHelper(wanted(), app, undefined, { compile: tools.compile, lipo: tools.lipo }),
      Error,
      "denext: the Dock helper: lipo",
    );
    // clang refuses an architecture that does not exist (or xcrun is not installed).
    await assertRejects(
      () =>
        addMacosDockHelper(wanted(), app, undefined, {
          archs: () => Promise.resolve(["no-such-arch"]),
          lipo: tools.lipo,
        }),
      Error,
      "needs clang",
    );
    // lipo cannot merge parts that are not Mach-O files.
    await assertRejects(
      () =>
        addMacosDockHelper(wanted(), app, undefined, {
          archs: () => Promise.resolve(["x86_64", "arm64"]),
          compile: tools.compile,
        }),
      Error,
      "denext: the Dock helper: lipo",
    );
  });
});

/** Write a helper candidate under `<app>/Contents/Helpers/<name>`. */
async function candidate(
  app: string,
  name: string,
  o: { plist?: string; exe?: "file" | "dir" | "none" },
): Promise<void> {
  const bundle = join(app, "Contents", "Helpers", name);
  await Deno.mkdir(join(bundle, "Contents", "MacOS"), { recursive: true });
  if (o.plist !== undefined) {
    await Deno.writeTextFile(join(bundle, "Contents", "Info.plist"), o.plist);
  }
  const exe = join(bundle, "Contents", "MacOS", name.replace(/\.app$/, ""));
  if (o.exe === "file") await Deno.writeTextFile(exe, "helper");
  if (o.exe === "dir") await Deno.mkdir(exe);
}

Deno.test("runtime: the helper search skips strays, foreign apps, a missing Info.plist and a folder for an executable", async () => {
  await inTemp(async (dir) => {
    const app = join(dir, "Tray.app");
    const owned = "<key>DenextDockHelperFor</key>";
    await Deno.mkdir(join(app, "Contents", "Helpers"), { recursive: true });
    await Deno.writeTextFile(join(app, "Contents", "Helpers", "A.app"), "a file");
    await Deno.mkdir(join(app, "Contents", "Helpers", "B.bundle"));
    await candidate(app, "C.app", { plist: "<key>Other</key>", exe: "file" });
    await candidate(app, "D.app", { exe: "file" });
    await candidate(app, "E.app", { plist: owned, exe: "dir" });
    assertEquals(await findDockHelperSource(app), undefined);
    await candidate(app, "F.app", { plist: owned, exe: "file" });
    assertEquals(await findDockHelperSource(app), {
      bundle: join(app, "Contents", "Helpers", "F.app"),
      fileName: "F",
    });
  });
});

Deno.test("runtime: the copy's folder must be a real folder, never a link", async () => {
  await inTemp(async (dir) => {
    const source = join(dir, "Fleet.app");
    await Deno.mkdir(join(source, "Contents", "MacOS"), { recursive: true });
    await Deno.writeTextFile(join(source, "Contents", "MacOS", "Fleet"), "helper");
    const data = join(dir, "data");
    await Deno.mkdir(join(dir, "elsewhere"));
    await Deno.mkdir(data);
    await Deno.symlink(join(dir, "elsewhere"), join(data, "dock-helper"));
    await assertRejects(
      () => installDockHelper({ bundle: source, fileName: "Fleet" }, data),
      Error,
      "is not a folder",
    );
  });
});

/** Connect to the session's port beside `bundle`. */
async function connectToSession(bundle: string): Promise<{ conn: Deno.Conn; token: string }> {
  const session = JSON.parse(await Deno.readTextFile(join(bundle, "..", "session")));
  const conn = await Deno.connect({ hostname: "127.0.0.1", port: session.port });
  return { conn, token: session.token };
}

const send = (conn: Deno.Conn, text: string) => conn.write(new TextEncoder().encode(text));

/** Read until the peer closes (a reset counts as closed). */
async function drain(conn: Deno.Conn): Promise<string> {
  const chunks: string[] = [];
  const buf = new Uint8Array(4096);
  try {
    for (let n = await conn.read(buf); n !== null; n = await conn.read(buf)) {
      chunks.push(new TextDecoder().decode(buf.subarray(0, n)));
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.ConnectionReset)) throw err;
  }
  return chunks.join("");
}

Deno.test("runtime: connections that close early, send garbage, overrun a line or say nothing are dropped", async () => {
  await inTemp(async (dir) => {
    const bundle = join(dir, "Fleet.app");
    await Deno.mkdir(bundle);
    const others: Deno.Conn[] = [];
    let helper: Deno.Conn | undefined;
    const messages: DockHelperMessage[] = [];
    const child = await launchDockHelper(bundle, (m) => messages.push(m), {
      open: async () => {
        // Closes before a newline.
        const early = await connectToSession(bundle);
        await send(early.conn, '{"t":"hel');
        early.conn.close();
        // Not JSON.
        const garbage = await connectToSession(bundle);
        await send(garbage.conn, "garbage\n");
        others.push(garbage.conn);
        // A first line longer than the limit.
        const long = await connectToSession(bundle);
        await send(long.conn, "x".repeat(1100));
        others.push(long.conn);
        // Says nothing at all: still pending when the helper is taken, then closed.
        const silent = await connectToSession(bundle);
        others.push(silent.conn);
        await new Promise((r) => setTimeout(r, 20));
        const real = await connectToSession(bundle);
        // The hello and a first message in one write: the rest after the hello is kept.
        await send(
          real.conn,
          `${JSON.stringify({ t: "hello", token: real.token })}\n{"t":"activate"}\n`,
        );
        helper = real.conn;
      },
    });
    for (const conn of others) {
      assertEquals(await drain(conn), "");
      conn.close();
    }
    for (let i = 0; i < 100 && messages.length < 1; i++) await new Promise((r) => setTimeout(r, 5));
    assertEquals(messages, ["activate"]);
    const tail = drain(helper!);
    child.exit();
    child.exit(); // A second ask sends nothing more.
    assertEquals(await tail, '{"t":"exit"}\n');
    helper!.close();
    assertEquals(await child.exited, 0);
    child.kill(); // Closed already: nothing to do.
  });
});

Deno.test("runtime: a connection still silent when the wait times out is closed", async () => {
  await inTemp(async (dir) => {
    const bundle = join(dir, "Fleet.app");
    await Deno.mkdir(bundle);
    let silent: Deno.Conn | undefined;
    await assertRejects(
      () =>
        launchDockHelper(bundle, () => {}, {
          open: async () => {
            silent = (await connectToSession(bundle)).conn;
          },
          connectTimeoutMs: 30,
        }),
      Error,
      "did not connect",
    );
    assertEquals(await drain(silent!), "");
    silent!.close();
  });
});

Deno.test("runtime: a session folder that cannot be written fails the launch before anything opens", async () => {
  await inTemp(async (dir) => {
    let opened = 0;
    await assertRejects(
      () =>
        launchDockHelper(join(dir, "missing", "Fleet.app"), () => {}, {
          open: () => {
            opened++;
            return Promise.resolve();
          },
        }),
      Deno.errors.NotFound,
    );
    assertEquals(opened, 0);
  });
});

/** A fake helper child: `end()` makes it exit; `stubborn` ignores `exit()`. */
function fakeChild(stubborn = false) {
  let end!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (end = resolve));
  const c = {
    exits: 0,
    kills: 0,
    exit() {
      c.exits++;
      if (!stubborn) end(0);
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

Deno.test("presence: a failing handler is a warning; messages after dispose are dropped", async () => {
  let deliver: ((m: DockHelperMessage) => void) | undefined;
  const warnings: string[] = [];
  let activations = 0;
  const presence = createDockPresence({
    wanted: () => true,
    launch: (onMessage) => {
      deliver = onMessage;
      return Promise.resolve(fakeChild());
    },
    onActivate: () => {
      activations++;
      throw new Error("no window");
    },
    onQuit: () => {
      throw "plain";
    },
    warn: (m) => warnings.push(m),
    pollMs: 0,
  });
  presence.sync();
  await tick();
  deliver!("activate");
  deliver!("quit");
  assertEquals(warnings, [
    "the Dock helper's activate failed: no window",
    "the Dock helper's quit failed: plain",
  ]);
  presence.dispose();
  deliver!("activate");
  assertEquals(activations, 1);
});

Deno.test("presence: a launch that settles after dispose is asked to leave, or ignored", async () => {
  for (const outcome of ["child", "none", "error"] as const) {
    const c = fakeChild();
    const warnings: string[] = [];
    let settle!: () => void;
    const presence = createDockPresence({
      wanted: () => true,
      launch: () =>
        new Promise((resolve, reject) =>
          settle = () =>
            outcome === "child"
              ? resolve(c)
              : outcome === "none"
              ? resolve(undefined)
              : reject(new Error("late"))
        ),
      onActivate: () => {},
      onQuit: () => {},
      warn: (m) => warnings.push(m),
      pollMs: 0,
    });
    presence.sync();
    assertEquals(presence.state(), "starting");
    presence.dispose();
    settle();
    await tick();
    assertEquals(c.exits, outcome === "child" ? 1 : 0, outcome);
    assertEquals(warnings, [], outcome);
    assertEquals(presence.state(), "disposed");
  }
});

Deno.test("presence: a launch rejecting with a non-Error is reported as it is", async () => {
  const warnings: string[] = [];
  const presence = createDockPresence({
    wanted: () => true,
    launch: () => Promise.reject("denied"),
    onActivate: () => {},
    onQuit: () => {},
    warn: (m) => warnings.push(m),
    pollMs: 0,
  });
  presence.sync();
  await tick();
  assertStringIncludes(warnings[0], "could not start (denied)");
  presence.dispose();
});

Deno.test("presence: a helper that ignores the ask to leave is ended after the grace period", async () => {
  let showing = true;
  const c = fakeChild(true);
  const presence = createDockPresence({
    wanted: () => showing,
    launch: () => Promise.resolve(c),
    onActivate: () => {},
    onQuit: () => {},
    warn: () => {},
    stopDelayMs: 0,
    exitGraceMs: 5,
    pollMs: 0,
  });
  presence.sync();
  await tick();
  assertEquals(presence.state(), "running");
  showing = false;
  presence.sync();
  await tick(1);
  assertEquals(presence.state(), "stopping");
  assertEquals(c.exits, 1);
  await tick(20);
  assertEquals(c.kills, 1);
  assertEquals(presence.state(), "idle");
  presence.dispose();
});

Deno.test("presence: a stop whose helper already crashed does nothing; a disposed presence clears its kill timer", async () => {
  let showing = true;
  const children: ReturnType<typeof fakeChild>[] = [];
  const presence = createDockPresence({
    wanted: () => showing,
    launch: () => {
      const c = fakeChild(true);
      children.push(c);
      return Promise.resolve(c);
    },
    onActivate: () => {},
    onQuit: () => {},
    warn: () => {},
    stopDelayMs: 10,
    exitGraceMs: 1_000,
    pollMs: 0,
  });
  presence.sync();
  await tick();
  showing = false;
  presence.sync(); // The stop is scheduled ...
  children[0].end(1); // ... and the helper crashes first.
  await tick(25);
  assertEquals(children[0].exits, 0, "the timer found nothing to stop");
  assertEquals(presence.state(), "idle");
  // Running again, then stopping with a kill timer pending: dispose clears it.
  showing = true;
  presence.sync();
  await tick();
  showing = false;
  presence.sync();
  await tick(20);
  assertEquals(presence.state(), "stopping");
  presence.dispose();
  assertEquals(presence.state(), "disposed");
  assertEquals(children[1].kills, 0);
});

Deno.test("presence: a wanted() that throws counts as no window; crashes older than a minute are forgotten", async () => {
  let clock = 0;
  let throwing = false;
  const children: ReturnType<typeof fakeChild>[] = [];
  const presence = createDockPresence({
    wanted: () => {
      if (throwing) throw new Error("registry gone");
      return true;
    },
    launch: () => {
      const c = fakeChild();
      children.push(c);
      return Promise.resolve(c);
    },
    onActivate: () => {},
    onQuit: () => {},
    warn: () => {},
    now: () => clock,
    pollMs: 0,
  });
  presence.sync();
  await tick();
  for (let i = 0; i < 4; i++) {
    clock += 40_000;
    children.at(-1)!.end(1);
    await tick();
    assertEquals(presence.state(), "running", `crash ${i}`);
  }
  assertEquals(children.length, 5);
  throwing = true;
  presence.sync();
  assertEquals(presence.state(), "running", "a stop is only scheduled");
  presence.dispose();
});

Deno.test("presence: the windows are polled on an interval until dispose", async () => {
  let looks = 0;
  const presence = createDockPresence({
    wanted: () => {
      looks++;
      return false;
    },
    launch: () => Promise.resolve(undefined),
    onActivate: () => {},
    onQuit: () => {},
    warn: () => {},
    pollMs: 2,
  });
  await tick(20);
  assert(looks > 0, "polled");
  presence.dispose();
  const after = looks;
  await tick(10);
  assertEquals(looks, after);
  // The default interval is set up and cleared too.
  const quiet = createDockPresence({
    wanted: () => false,
    launch: () => Promise.resolve(undefined),
    onActivate: () => {},
    onQuit: () => {},
    warn: () => {},
  });
  quiet.dispose();
  assertEquals(quiet.state(), "disposed");
});

Deno.test("presence: windows without an isVisible count, a throwing one does not; nothing to focus or a failing focus is fine", () => {
  const bare: DockWindow = { id: "bare", kind: "window", window: {} };
  const broken: DockWindow = {
    id: "broken",
    kind: "window",
    window: {
      isVisible: () => {
        throw new Error("closed");
      },
    },
  };
  assert(holdsDockIcon(bare));
  assert(!holdsDockIcon(broken));
  focusForDock(undefined, [broken]);
  focusForDock(undefined, []);
  focusForDock(bare, [bare]); // no isMinimized / focus: nothing to call
  const failing: DockWindow = {
    id: "failing",
    kind: "main",
    window: {
      focus: () => {
        throw new Error("closing");
      },
    },
  };
  focusForDock(failing, [failing]);
  const closed: string[] = [];
  closeForDock([bare, broken], (id) => closed.push(id));
  assertEquals(closed, ["bare"]);
});

Deno.test("startup: an executable outside a bundle, or no data folder, keeps the accessory behaviour", async () => {
  await inTemp(async (dir) => {
    const warnings: string[] = [];
    const base = {
      windows: () => [],
      keyWindow: () => undefined,
      closeWindow: () => {},
      warn: (m: string) => warnings.push(m),
    };
    assertEquals(
      await startDockHelper({ ...base, dataDir: dir, execPath: join(dir, "bin", "deno") }),
      undefined,
    );
    const app = join(dir, "Tray.app");
    await candidate(app, "Fleet.app", { plist: "<key>DenextDockHelperFor</key>", exe: "file" });
    assertEquals(
      await startDockHelper({
        ...base,
        dataDir: undefined,
        execPath: join(app, "Contents", "MacOS", "laufey_webview"),
      }),
      undefined,
    );
    assertEquals(warnings.length, 2);
    for (const w of warnings) assertStringIncludes(w, "this build has no Dock helper");
  });
});

Deno.test("startup: with a helper the presence follows the windows, and a copy that cannot be made is one warning", async () => {
  await inTemp(async (dir) => {
    const app = join(dir, "Tray.app");
    await candidate(app, "Fleet.app", { plist: "<key>DenextDockHelperFor</key>", exe: "file" });
    const data = join(dir, "data");
    await Deno.mkdir(data);
    // The copy's folder is a file: the install fails before anything is opened.
    await Deno.writeTextFile(join(data, "dock-helper"), "not a folder");
    const warnings: string[] = [];
    let windows: DockWindow[] = [];
    const presence = await startDockHelper({
      windows: () => windows,
      keyWindow: () => windows[0],
      closeWindow: () => {},
      dataDir: data,
      warn: (m) => warnings.push(m),
      execPath: join(app, "Contents", "MacOS", "laufey_webview"),
    });
    assert(presence);
    assertEquals(presence.state(), "idle", "no window yet");
    windows = [{ id: "main", kind: "main", window: { isVisible: () => true } }];
    presence.sync();
    for (let i = 0; i < 100 && presence.state() !== "failed"; i++) await tick(5);
    assertEquals(presence.state(), "failed");
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0], "could not start");
    presence.dispose();
  });
});
