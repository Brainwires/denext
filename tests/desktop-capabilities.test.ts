// `denext desktop add` (src/build/desktop-capabilities.ts): the capability table, the
// desktop.capabilities config splice (idempotent, comment-preserving, dry-run), and the
// permission flags each capability implies.

import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  addDesktopCapabilities,
  DESKTOP_BASELINE_FLAGS,
  DESKTOP_CAPABILITIES,
  DESKTOP_DATA_TOKEN,
  desktopBuildFlags,
  desktopIncludeArgs,
  desktopNpmArgs,
  desktopNpmArgsFor,
  desktopPackageFlags,
  desktopPermissionFlags,
  desktopScopedPath,
  formatDesktopAddReport,
  formatDesktopCapabilityTable,
  passkeyRpId,
} from "../src/build/desktop-capabilities.ts";
import { desktopPasskeyRpIds } from "../src/build/desktop-launch-policy.ts";
import { readConfigModel } from "../src/build/config-edit.ts";
import { makeTempDirUntilExit } from "./helpers/temp.ts";

function project(config?: string): string {
  const dir = makeTempDirUntilExit("denext-desktop-add-");
  if (config !== undefined) Deno.writeTextFileSync(join(dir, "denext.config.ts"), config);
  return dir;
}

Deno.test("desktop add --list: every capability has a key, an API and a trust level", () => {
  const table = formatDesktopCapabilityTable();
  for (const [name, cap] of Object.entries(DESKTOP_CAPABILITIES)) {
    assertStringIncludes(table, name);
    assert(cap.key.length > 0 && cap.api.length > 0, name);
    assert(["none", "scoped", "broad", "full"].includes(cap.trust), name);
  }
  // The page-side capabilities this release wires, by name.
  for (
    const name of [
      "secure-store",
      "fs",
      "sqlite",
      "context-menu",
      "shell",
      "dialogs",
      "notifications",
      "keep-awake",
      "clipboard",
      "device",
    ]
  ) {
    assert(Object.hasOwn(DESKTOP_CAPABILITIES, name), name);
  }
});

Deno.test("desktop add: writes desktop.capabilities into an existing config, keeping comments", async () => {
  const dir = project(
    '// my config\nexport default {\n  // keep me\n  basePath: "/app",\n};\n',
  );
  const report = await addDesktopCapabilities({ capabilities: ["secure-store", "fs"], dir });
  assertEquals(report.added, ["secure-store", "fs"]);
  assertEquals(report.created, false);
  const text = await Deno.readTextFile(join(dir, "denext.config.ts"));
  assertStringIncludes(text, "// keep me");
  assertStringIncludes(text, 'basePath: "/app"');
  assertStringIncludes(text, "secureStore: true");
  assertStringIncludes(text, '"$APPDATA"');
  // Idempotent: a second run keeps what is there.
  const again = await addDesktopCapabilities({ capabilities: ["fs", "secureStore"], dir });
  assertEquals(again.added, []);
  assertEquals(again.kept, ["fs", "secure-store"]);
  assertEquals(again.diff, "");
  assertEquals(await Deno.readTextFile(join(dir, "denext.config.ts")), text);
});

Deno.test("desktop add: a key the user customised is kept", async () => {
  const dir = project(
    'export default {\n  desktop: { capabilities: { shell: { openExternal: ["https:"] } } },\n};\n',
  );
  const report = await addDesktopCapabilities({ capabilities: ["shell", "clipboard"], dir });
  assertEquals(report.kept, ["shell"]);
  assertEquals(report.added, ["clipboard"]);
  const text = await Deno.readTextFile(join(dir, "denext.config.ts"));
  assertStringIncludes(text, 'openExternal: ["https:"]');
  assertStringIncludes(text, "clipboard: true");
});

Deno.test("desktop add: drops the scaffold's commented capabilities hint once a real block exists", async () => {
  const dir = project(
    "export default {\n  desktop: {\n" +
      '    app: { identifier: "com.example.denext" },\n' +
      "    // capabilities: { fs: true, secureStore: true, shell: true },  // denext desktop add <cap>\n" +
      "  },\n};\n",
  );
  const report = await addDesktopCapabilities({ capabilities: ["fs"], dir });
  assertEquals(report.added, ["fs"]);
  const text = await Deno.readTextFile(join(dir, "denext.config.ts"));
  assertStringIncludes(text, "$APPDATA"); // the real fs block was written
  assert(!text.includes("denext desktop add <cap>"), "the commented hint line is gone");
  assert(!text.includes("// capabilities:"), "no commented capabilities placeholder remains");
});

Deno.test("desktop add: creates denext.config.ts when the project has none", async () => {
  const dir = project();
  const report = await addDesktopCapabilities({ capabilities: ["context-menu"], dir });
  assertEquals(report.created, true);
  const text = await Deno.readTextFile(join(dir, "denext.config.ts"));
  assertStringIncludes(text, "contextMenu: true");
});

Deno.test("desktop add --dry-run: plans without writing", async () => {
  const dir = project("export default {};\n");
  const report = await addDesktopCapabilities({ capabilities: ["dialogs"], dir, dryRun: true });
  assertEquals(report.added, ["dialogs"]);
  assertStringIncludes(report.diff, "+");
  assertEquals(await Deno.readTextFile(join(dir, "denext.config.ts")), "export default {};\n");
  const out = formatDesktopAddReport(report, true);
  assertStringIncludes(out, "would enable: dialogs");
  // osascript / powershell.exe are interpreters: dialogs is FULL trust, not merely broad.
  assertStringIncludes(out, "FULL");
});

Deno.test("desktop add: unknown or missing capabilities are refused", async () => {
  const dir = project("export default {};\n");
  await assertRejects(
    () => addDesktopCapabilities({ capabilities: ["tray-icon"], dir }),
    Error,
    "unknown capability",
  );
  await assertRejects(
    () => addDesktopCapabilities({ capabilities: [], dir }),
    Error,
    "at least one",
  );
});

/** The config's `desktop.capabilities.passkeys.rpIds`, as the packaging reads it. */
async function rpIdsIn(dir: string): Promise<string[] | null> {
  const model = await readConfigModel(await Deno.readTextFile(join(dir, "denext.config.ts")));
  return desktopPasskeyRpIds({ desktop: model.keys.desktop?.value });
}

Deno.test("desktop add passkeys --rp-id: writes rpIds instead of an empty pin; repeatable, merged", async () => {
  const bare = project("export default {};\n");
  const empty = await addDesktopCapabilities({ capabilities: ["passkeys"], dir: bare });
  assertEquals(await rpIdsIn(bare), [], "without --rp-id the pin is empty (fail closed)");
  assert(empty.manual.some((m) => m.includes("--rp-id <domain>")), "and the step says how");
  const dir = project("export default {};\n");
  const report = await addDesktopCapabilities({
    capabilities: ["passkeys"],
    dir,
    passkeyRpIds: ["Example.com", "clerk.example.com", "example.com"],
  });
  assertEquals(report.added, ["passkeys"]);
  assertEquals(report.rpIds, ["example.com", "clerk.example.com"]);
  assertEquals(await rpIdsIn(dir), ["example.com", "clerk.example.com"]);
  assertFalse(report.manual.some((m) => m.includes("--rp-id <domain>")), "no empty-pin step");
  assertStringIncludes(formatDesktopAddReport(report, false), "relying parties: example.com");
  // a second run merges into the list it finds, keeping what is there
  const again = await addDesktopCapabilities({
    capabilities: ["passkeys"],
    dir,
    passkeyRpIds: ["auth.example.org", "example.com"],
  });
  assertEquals(again.kept, ["passkeys"]);
  assertEquals(await rpIdsIn(dir), ["example.com", "clerk.example.com", "auth.example.org"]);
  const same = await addDesktopCapabilities({
    capabilities: ["passkeys"],
    dir,
    passkeyRpIds: ["auth.example.org"],
  });
  assertEquals(same.diff, "");
  // an empty pin `add` wrote earlier is filled in; a `false` is replaced (enabled)
  await addDesktopCapabilities({ capabilities: ["passkeys"], dir: bare, passkeyRpIds: ["a.dev"] });
  assertEquals(await rpIdsIn(bare), ["a.dev"]);
  const off = project("export default { desktop: { capabilities: { passkeys: false } } };\n");
  const on = await addDesktopCapabilities({
    capabilities: ["passkeys"],
    dir: off,
    passkeyRpIds: ["a.dev"],
  });
  assertEquals([on.added, await rpIdsIn(off)], [["passkeys"], ["a.dev"]]);
});

Deno.test("denext desktop add passkeys --rp-id a --rp-id b: the CLI writes both", async () => {
  const { CommandRegistry } = await import("../src/cli/command.ts");
  const { desktopCommand } = await import("../src/cli/commands/desktop.ts");
  const { desktopAdd } = await import("../src/cli/commands/desktop-add.ts");
  const reg = new CommandRegistry();
  reg.register(desktopCommand);
  const dir = project("export default {};\n");
  const out = reg.parse([
    "desktop",
    "add",
    "passkeys",
    "--rp-id",
    "a.dev",
    "--rp-id=b.example.com",
  ]);
  assert(out.kind === "run");
  const log = console.log;
  console.log = () => {};
  try {
    await desktopAdd(out.ctx, dir);
  } finally {
    console.log = log;
  }
  assertEquals(await rpIdsIn(dir), ["a.dev", "b.example.com"]);
});

Deno.test("desktop add passkeys --rp-id: each ID must be a registrable domain", async () => {
  assertEquals(passkeyRpId(" Example.COM "), "example.com");
  assertEquals(passkeyRpId("bücher.example"), "xn--bcher-kva.example");
  for (
    const bad of [
      "localhost",
      "https://example.com",
      "example.com:443",
      "example.com/path",
      "192.168.1.10",
      "-bad.example.com",
      "a..example.com",
      ".example.com",
      "",
      "exa mple.com",
    ]
  ) {
    let threw = false;
    try {
      passkeyRpId(bad);
    } catch (err) {
      threw = true;
      assertStringIncludes(String(err), "not a registrable domain");
    }
    assert(threw, bad);
  }
  const dir = project("export default {};\n");
  await assertRejects(
    () => addDesktopCapabilities({ capabilities: ["passkeys"], dir, passkeyRpIds: ["localhost"] }),
    Error,
    "not a registrable domain",
  );
  await assertRejects(
    () => addDesktopCapabilities({ capabilities: ["fs"], dir, passkeyRpIds: ["example.com"] }),
    Error,
    "--rp-id applies to the passkeys capability",
  );
  assertEquals(await Deno.readTextFile(join(dir, "denext.config.ts")), "export default {};\n");
});

Deno.test("desktop add: a config whose desktop value is code is refused with the snippet", async () => {
  const dir = project("const d = { capabilities: {} };\nexport default { desktop: d };\n");
  await assertRejects(
    () => addDesktopCapabilities({ capabilities: ["clipboard"], dir }),
    Error,
    "Add by hand",
  );
});

Deno.test("desktop permission flags: per OS, unioned, unscoped where a picked path needs it", () => {
  assertEquals(desktopPermissionFlags(["context-menu", "passkeys"], "darwin"), []);
  // The pinned runtime's clipboard reads, global shortcuts, launch at login and OS notifications
  // need an UNSCOPED --allow-sys, which absorbs a scoped one.
  for (const cap of ["clipboard", "global-shortcuts", "launch-at-login", "notifications"]) {
    for (const os of ["darwin", "windows", "linux"] as const) {
      assertEquals(desktopPermissionFlags([cap], os), ["--allow-sys"], `${cap} ${os}`);
    }
  }
  assertEquals(desktopPermissionFlags(["device", "clipboard"], "linux"), ["--allow-sys"]);
  assertEquals(desktopPermissionFlags(["keep-awake", "shell"], "darwin"), [
    "--allow-run=caffeinate,open,osascript",
  ]);
  assertEquals(desktopPermissionFlags(["keep-awake"], "windows"), ["--allow-ffi=kernel32.dll"]);
  const dialogs = desktopPermissionFlags(["dialogs", "fs"], "linux");
  assert(dialogs.includes("--allow-read"), dialogs.join(" "));
  assert(dialogs.includes("--allow-write"), dialogs.join(" "));
  assertEquals(desktopPermissionFlags(["device"], "linux"), ["--allow-sys=osRelease"]);
});

Deno.test("docs: the desktop page lists every capability `denext desktop add` knows", async () => {
  const page = await Deno.readTextFile(
    new URL("../site/app/docs/desktop/page.tsx", import.meta.url),
  );
  for (const name of Object.keys(DESKTOP_CAPABILITIES)) {
    assertStringIncludes(page, `<code>${name}</code>`, `docs/desktop is missing ${name}`);
  }
});

/** Wrap a `desktop.capabilities` object as a whole config (desktopBuildFlags takes the config). */
function caps(capabilities: Record<string, unknown>): unknown {
  return { desktop: { capabilities } };
}

Deno.test("desktopBuildFlags: no capabilities → only the loopback + read + env baseline (never -A)", () => {
  for (const config of [undefined, {}, caps({ extensions: ["./ext.ts"] })]) {
    const flags = desktopBuildFlags(config, "darwin");
    assertEquals(flags, [...DESKTOP_BASELINE_FLAGS]);
    assert(!flags.includes("-A") && !flags.includes("--allow-all"));
  }
});

Deno.test("desktopBuildFlags: run/ffi/sys are baked exactly; read/env/net stay the baseline", () => {
  // Scoped caps add only their exact run + sys; no write, no per-token read/write leaks.
  // secure-store on macOS: the runtime's Keychain store (unscoped --allow-sys, which subsumes
  // device's osRelease) and `security` (older runtimes, moving older items over).
  assertEquals(desktopBuildFlags(caps({ secureStore: true, device: true }), "darwin"), [
    ...DESKTOP_BASELINE_FLAGS,
    "--allow-sys",
    "--allow-run=security",
  ]);
  assertEquals(desktopBuildFlags(caps({ device: true }), "darwin"), [
    ...DESKTOP_BASELINE_FLAGS,
    "--allow-sys=osRelease",
  ]);
  // secure-store on Windows uses WinRT PasswordVault via powershell.exe (not on other OSes).
  assertEquals(desktopBuildFlags(caps({ secureStore: true }), "windows"), [
    ...DESKTOP_BASELINE_FLAGS,
    "--allow-run=powershell.exe",
  ]);
  // keep-awake's Windows backend is FFI, not a program.
  assertEquals(desktopBuildFlags(caps({ keepAwake: true }), "windows"), [
    ...DESKTOP_BASELINE_FLAGS,
    "--allow-ffi=kernel32.dll",
  ]);
});

Deno.test("desktopBuildFlags: a capability that writes collapses to one broad --allow-write", () => {
  // fs/sqlite/dialogs write to per-user (or picked) paths that can't be baked, so packaging grants
  // a broad --allow-write once; the runtime cap layer confines it. No `--allow-write=$APPDATA` leaks.
  const flags = desktopBuildFlags(
    caps({ fs: { read: ["$APPDATA"], write: ["$APPDATA"] }, sqlite: true }),
    "linux",
  );
  assert(flags.includes("--allow-write"), flags.join(" "));
  assert(!flags.some((f) => f.startsWith("--allow-write=")), flags.join(" "));
  // read is covered by the broad baseline, so no capability-scoped --allow-read is added.
  assertEquals(flags.filter((f) => f.startsWith("--allow-read")), ["--allow-read"]);
});

Deno.test("desktopBuildFlags: on a runtime that expands $DENO_DESKTOP_DATA the app-folder writes are scoped", () => {
  const app = (
    desktop: Record<string, unknown>,
    identifier: string | null = "com.example.app",
  ) => ({
    desktop: { ...(identifier !== null ? { app: { identifier } } : {}), ...desktop },
  });
  const writeOf = (flags: string[]) => flags.filter((f) => f.startsWith("--allow-write"));
  const scope = { dataScope: true, cacheScope: true } as const;
  // fs (its default folders), sqlite and updates: the data and cache folders, never broad.
  assertEquals(
    writeOf(
      desktopBuildFlags(
        app({ capabilities: { fs: true, sqlite: true, updates: true } }),
        "darwin",
        scope,
      ),
    ),
    [`--allow-write=$DENO_DESKTOP_CACHE,${DESKTOP_DATA_TOKEN}`],
  );
  // The UI overlay keeps its versions in <data>/ui-updates; a sidecar's log file in <data>/logs.
  assertEquals(
    writeOf(desktopBuildFlags(
      app({
        update: { ui: { feedUrl: "https://u.example.com/f", publicKey: "k" } },
        sidecars: [{ name: "api", run: { module: "./api.ts" }, logs: "file" }],
      }),
      "linux",
      scope,
    )),
    [`--allow-write=${DESKTOP_DATA_TOKEN}/logs,${DESKTOP_DATA_TOKEN}/ui-updates`],
  );
  // extraPermissions: a folder token or an absolute path is kept exactly.
  assertEquals(
    writeOf(desktopBuildFlags(
      app({
        capabilities: { sqlite: true },
        extraPermissions: { write: ["$APPDATA/exports", "/var/tmp/app"] },
      }),
      "linux",
      scope,
    )),
    [`--allow-write=${DESKTOP_DATA_TOKEN},${DESKTOP_DATA_TOKEN}/exports,/var/tmp/app`],
  );
  // A write that has no folder token stays broad: a picked path (dialogs), $DOCUMENTS, a relative
  // path, a `..` component.
  for (
    const desktop of [
      { capabilities: { dialogs: true, sqlite: true } },
      { capabilities: { fs: { read: ["$APPDATA"], write: ["$APPDATA", "$DOCUMENTS"] } } },
      { extraPermissions: { write: ["data"] } },
      { extraPermissions: { write: ["$APPDATA/../other"] } },
    ]
  ) {
    assertEquals(writeOf(desktopBuildFlags(app(desktop), "linux", scope)), ["--allow-write"]);
  }
  // No identifier (the runtime could not expand the token) or an older runtime: today's flags.
  const sqlite = { capabilities: { sqlite: true } };
  assertEquals(writeOf(desktopBuildFlags(app(sqlite, null), "linux", scope)), ["--allow-write"]);
  assertEquals(writeOf(desktopBuildFlags(app(sqlite, " "), "linux", scope)), ["--allow-write"]);
  assertEquals(
    writeOf(desktopBuildFlags(app(sqlite), "linux", { dataScope: false })),
    ["--allow-write"],
  );
  // Nothing writes: no --allow-write at all, whatever the runtime.
  assertEquals(writeOf(desktopBuildFlags(app({}), "linux", scope)), []);
  // Read stays the broad baseline in the default mode.
  assert(desktopBuildFlags(app(sqlite), "linux", scope).includes("--allow-read"));
});

Deno.test("desktopScopedPath: folder tokens become the runtime's, absolute paths stay, the rest cannot be scoped", () => {
  assertEquals(desktopScopedPath("$APPDATA"), DESKTOP_DATA_TOKEN);
  assertEquals(desktopScopedPath("$APPDATA/logs"), `${DESKTOP_DATA_TOKEN}/logs`);
  assertEquals(desktopScopedPath("$APPDATA\\a\\b"), `${DESKTOP_DATA_TOKEN}/a/b`);
  assertEquals(desktopScopedPath("$CACHE"), "$DENO_DESKTOP_CACHE");
  assertEquals(
    desktopScopedPath("$DENO_DESKTOP_CACHE/sidecars/x"),
    "$DENO_DESKTOP_CACHE/sidecars/x",
  );
  assertEquals(desktopScopedPath(`${DESKTOP_DATA_TOKEN}/x`), `${DESKTOP_DATA_TOKEN}/x`);
  assertEquals(desktopScopedPath("/opt/app"), "/opt/app");
  assertEquals(desktopScopedPath("C:\\Data"), "C:\\Data");
  assertEquals(desktopScopedPath("D:/Data"), "D:/Data");
  assertEquals(desktopScopedPath("\\\\server\\share"), "\\\\server\\share");
  for (const value of ["*", "$DOCUMENTS", "$APPDATAX", "data", "./x", "$APPDATA/../x", "/a/../b"]) {
    assertEquals(desktopScopedPath(value), undefined, value);
  }
});

Deno.test("desktopBuildFlags: the full capability set on Windows, least-privilege", () => {
  const config = caps({
    device: true,
    fs: true,
    sqlite: true,
    shell: true,
    keepAwake: true,
    secureStore: true,
    dialogs: true,
    contextMenu: true, // a runtime API: contributes no flags
  });
  assertEquals(desktopBuildFlags(config, "windows"), [
    ...DESKTOP_BASELINE_FLAGS,
    "--allow-write",
    "--allow-sys=osRelease",
    "--allow-run=explorer.exe,powershell.exe,rundll32.exe",
    "--allow-ffi=kernel32.dll",
  ]);
  // A capability that needs the unscoped --allow-sys widens the scoped one: a partial
  // `--allow-sys=<names>` would leave them NotCapable under the pinned runtime.
  const withRuntimeApis = caps({
    ...(config as { desktop: { capabilities: Record<string, unknown> } }).desktop.capabilities,
    clipboard: true,
    notifications: true,
  });
  assertEquals(desktopBuildFlags(withRuntimeApis, "windows"), [
    ...DESKTOP_BASELINE_FLAGS,
    "--allow-write",
    "--allow-sys",
    "--allow-run=explorer.exe,powershell.exe,rundll32.exe",
    "--allow-ffi=kernel32.dll",
  ]);
});

Deno.test("desktopBuildFlags: declared deep-link schemes bake the unscoped --allow-sys", () => {
  // Claiming a scheme back (`registerScheme({ force: true })`) needs it under the pinned runtime.
  const links = { desktop: { app: { deepLinks: ["myapp"] }, capabilities: { device: true } } };
  for (const os of ["darwin", "windows", "linux"] as const) {
    assertEquals(desktopBuildFlags(links, os), [...DESKTOP_BASELINE_FLAGS, "--allow-sys"], os);
  }
  // No schemes (or an empty list): nothing added.
  assertEquals(desktopBuildFlags({ desktop: { app: { deepLinks: [] } } }, "linux"), [
    ...DESKTOP_BASELINE_FLAGS,
  ]);
  assertEquals(desktopBuildFlags({ desktop: { app: { origin: "myapp://app" } } }, "linux"), [
    ...DESKTOP_BASELINE_FLAGS,
  ]);
});

Deno.test("desktopBuildFlags: a `false` value disables a capability", () => {
  assertEquals(desktopBuildFlags(caps({ device: false, keepAwake: true }), "darwin"), [
    ...DESKTOP_BASELINE_FLAGS,
    "--allow-run=caffeinate",
  ]);
});

Deno.test("desktopBuildFlags: auth-session bakes the per-OS browser opener", () => {
  assertEquals(desktopBuildFlags(caps({ authSession: true }), "darwin"), [
    ...DESKTOP_BASELINE_FLAGS,
    "--allow-run=open",
  ]);
  assertEquals(desktopBuildFlags(caps({ authSession: true }), "windows"), [
    ...DESKTOP_BASELINE_FLAGS,
    "--allow-run=rundll32.exe",
  ]);
  assertEquals(desktopBuildFlags(caps({ authSession: true }), "linux"), [
    ...DESKTOP_BASELINE_FLAGS,
    "--allow-run=xdg-open",
  ]);
});

Deno.test("desktopBuildFlags: a non-loopback spa.proxy host merges into the single --allow-net", () => {
  const flags = desktopBuildFlags(
    { spa: { proxy: { target: "https://api.example.com", allowNonLoopback: true } } },
    "darwin",
  );
  // ONE --allow-net carrying loopback + the proxy host, sorted (Deno keeps only the last --allow-net).
  assertEquals(flags.filter((f) => f.startsWith("--allow-net")), [
    "--allow-net=127.0.0.1,api.example.com,localhost",
  ]);
  // A loopback proxy target (or one without allowNonLoopback) does not widen net.
  assertEquals(
    desktopBuildFlags({ spa: { proxy: { target: "http://127.0.0.1:8080" } } }, "darwin"),
    [...DESKTOP_BASELINE_FLAGS],
  );
});

Deno.test("desktopBuildFlags: extraPermissions is the escape hatch (updater net+write, custom run)", () => {
  const flags = desktopBuildFlags(
    {
      desktop: {
        capabilities: { device: true },
        extraPermissions: {
          net: ["updates.example.com"],
          write: ["ignored-value"],
          run: ["myhelper"],
        },
      },
    },
    "darwin",
  );
  // net merges loopback + the updater feed host; write becomes broad; run unions device(none)+myhelper+sys.
  assert(flags.includes("--allow-net=127.0.0.1,localhost,updates.example.com"), flags.join(" "));
  assert(flags.includes("--allow-write"), "extraPermissions.write → broad --allow-write");
  assert(!flags.some((f) => f.startsWith("--allow-write=")), "write is broad, not scoped");
  assert(flags.includes("--allow-run=myhelper"), flags.join(" "));
  assert(flags.includes("--allow-sys=osRelease"), "device's sys still baked");
});

Deno.test('desktopBuildFlags: an extraPermissions "*" bakes the unscoped flag (Node-API addons)', () => {
  const flags = desktopBuildFlags(
    { desktop: { capabilities: { device: true }, extraPermissions: { ffi: ["*"] } } },
    "darwin",
  );
  assert(flags.includes("--allow-ffi"), flags.join(" "));
  assert(!flags.some((f) => f.startsWith("--allow-ffi=")), "unscoped, not a list containing *");
  assert(flags.includes("--allow-sys=osRelease"), "the other kinds keep their scopes");
  const sys = desktopBuildFlags(
    { desktop: { capabilities: { device: true }, extraPermissions: { sys: ["*"] } } },
    "linux",
  );
  assert(sys.includes("--allow-sys") && !sys.some((f) => f.startsWith("--allow-sys=")));
});

Deno.test("desktopPackageFlags: reads denext.config.ts next to the script (missing → baseline)", async () => {
  // No config next to the script → baseline only (the examples/native case).
  const bare = await Deno.makeTempDir({ prefix: "denext-pkgflags-bare-" });
  // A config with capabilities → baseline + their least-privilege flags.
  const withCfg = await Deno.makeTempDir({ prefix: "denext-pkgflags-cfg-" });
  try {
    await Deno.mkdir(join(bare, "scripts"));
    await Deno.mkdir(join(withCfg, "scripts"));
    await Deno.writeTextFile(
      join(withCfg, "denext.config.ts"),
      "export default { desktop: { capabilities: { device: true, shell: true } } };\n",
    );
    // The stock runtime's flags (the split network grant is its own test).
    assertEquals(
      await desktopPackageFlags(
        `file://${join(bare, "scripts", "package-macos.ts")}`,
        "darwin",
        false,
      ),
      [...DESKTOP_BASELINE_FLAGS],
    );
    assertEquals(
      await desktopPackageFlags(
        `file://${join(withCfg, "scripts", "package-macos.ts")}`,
        "darwin",
        false,
      ),
      [...DESKTOP_BASELINE_FLAGS, "--allow-sys=osRelease", "--allow-run=open,osascript"],
    );
    // On the pinned runtime (3.0.0-rc.2+) the network grant is split by direction.
    assertEquals(
      await desktopPackageFlags(
        `file://${join(withCfg, "scripts", "package-macos.ts")}`,
        "darwin",
        true,
      ),
      [
        "--allow-net-connect=127.0.0.1,localhost",
        "--allow-net-listen=127.0.0.1,localhost",
        "--allow-read",
        "--allow-env",
        "--allow-sys=osRelease",
        "--allow-run=open,osascript",
      ],
    );
  } finally {
    await Deno.remove(bare, { recursive: true });
    await Deno.remove(withCfg, { recursive: true });
  }
});

Deno.test("desktopIncludeArgs: one --include per desktop.capabilities.extensions path (none → [])", async () => {
  // No config, and a config with no extensions → nothing extra to embed.
  const bare = await Deno.makeTempDir({ prefix: "denext-inc-bare-" });
  const noExt = await Deno.makeTempDir({ prefix: "denext-inc-noext-" });
  // A config that declares extension modules → one `--include <path>` each (so the packaged
  // binary embeds them, not just the export dir).
  const withExt = await Deno.makeTempDir({ prefix: "denext-inc-ext-" });
  try {
    await Deno.mkdir(join(noExt, "scripts"));
    await Deno.mkdir(join(withExt, "scripts"));
    await Deno.writeTextFile(
      join(noExt, "denext.config.ts"),
      "export default { desktop: { capabilities: { fs: true } } };\n",
    );
    await Deno.writeTextFile(
      join(withExt, "denext.config.ts"),
      'export default { desktop: { capabilities: { extensions: ["./desktop/diag.ts", "./desktop/tools.ts"] } } };\n',
    );
    assertEquals(
      await desktopIncludeArgs(`file://${join(bare, "scripts", "package-macos.ts")}`),
      [],
    );
    assertEquals(
      await desktopIncludeArgs(`file://${join(noExt, "scripts", "package-macos.ts")}`),
      [],
    );
    assertEquals(
      await desktopIncludeArgs(`file://${join(withExt, "scripts", "package-macos.ts")}`),
      ["--include", "./desktop/diag.ts", "--include", "./desktop/tools.ts"],
    );
  } finally {
    await Deno.remove(bare, { recursive: true });
    await Deno.remove(noExt, { recursive: true });
    await Deno.remove(withExt, { recursive: true });
  }
});

Deno.test("desktopNpmArgs: a project with node_modules embeds only the npm packages it reaches", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-desktop-npm-" });
  try {
    const script = toFileUrl(join(dir, "scripts", "package-macos.ts")).href;
    // No node_modules (a native denext app): nothing to add.
    assertEquals(await desktopNpmArgsFor(dir), []);
    assertEquals(await desktopNpmArgs(script), []);
    // A next-compat app: `deno desktop` would otherwise embed the whole directory.
    await Deno.mkdir(join(dir, "node_modules"));
    const flags = ["--node-modules-dir=none", "--exclude-unused-npm"];
    assertEquals(await desktopNpmArgsFor(dir), flags);
    assertEquals(await desktopNpmArgs(script), flags);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktopNpmArgs: a package.json without node_modules resolves npm from the cache", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-desktop-npm-" });
  try {
    // A fresh clone of an app with a package.json, before `deno install`: Deno's manual
    // node_modules mode would fail the type check on npm:@types/node.
    await Deno.writeTextFile(join(dir, "package.json"), '{"private":true}');
    assertEquals(await desktopNpmArgsFor(dir), ["--node-modules-dir=none", "--exclude-unused-npm"]);
    // A directory named package.json is not one.
    const odd = await Deno.makeTempDir({ prefix: "denext-desktop-npm-" });
    await Deno.mkdir(join(odd, "package.json"));
    assertEquals(await desktopNpmArgsFor(odd), []);
    await Deno.remove(odd, { recursive: true });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
