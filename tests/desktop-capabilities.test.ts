// `denext desktop add` (src/build/desktop-capabilities.ts): the capability table, the
// desktop.capabilities config splice (idempotent, comment-preserving, dry-run), and the
// permission flags each capability implies.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  addDesktopCapabilities,
  DESKTOP_BASELINE_FLAGS,
  DESKTOP_CAPABILITIES,
  desktopBuildFlags,
  desktopIncludeArgs,
  desktopPackageFlags,
  desktopPermissionFlags,
  formatDesktopAddReport,
  formatDesktopCapabilityTable,
} from "../src/build/desktop-capabilities.ts";

async function project(config?: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext-desktop-add-" });
  if (config !== undefined) await Deno.writeTextFile(join(dir, "denext.config.ts"), config);
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
  const dir = await project(
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
  const dir = await project(
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
  const dir = await project(
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
  const dir = await project();
  const report = await addDesktopCapabilities({ capabilities: ["context-menu"], dir });
  assertEquals(report.created, true);
  const text = await Deno.readTextFile(join(dir, "denext.config.ts"));
  assertStringIncludes(text, "contextMenu: true");
});

Deno.test("desktop add --dry-run: plans without writing", async () => {
  const dir = await project("export default {};\n");
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
  const dir = await project("export default {};\n");
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

Deno.test("desktop add: a config whose desktop value is code is refused with the snippet", async () => {
  const dir = await project("const d = { capabilities: {} };\nexport default { desktop: d };\n");
  await assertRejects(
    () => addDesktopCapabilities({ capabilities: ["clipboard"], dir }),
    Error,
    "Add by hand",
  );
});

Deno.test("desktop permission flags: per OS, unioned, unscoped where a picked path needs it", () => {
  assertEquals(
    desktopPermissionFlags(["clipboard", "context-menu", "notifications"], "darwin"),
    [],
  );
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
  assertEquals(desktopBuildFlags(caps({ secureStore: true, device: true }), "darwin"), [
    ...DESKTOP_BASELINE_FLAGS,
    "--allow-sys=osRelease",
    "--allow-run=security",
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

Deno.test("desktopBuildFlags: the full capability set on Windows, least-privilege", () => {
  const config = caps({
    device: true,
    fs: true,
    sqlite: true,
    shell: true,
    keepAwake: true,
    secureStore: true,
    dialogs: true,
    clipboard: true, // a runtime API: contributes no flags
    contextMenu: true, // a runtime API
    notifications: true, // a runtime API
  });
  assertEquals(desktopBuildFlags(config, "windows"), [
    ...DESKTOP_BASELINE_FLAGS,
    "--allow-write",
    "--allow-sys=osRelease",
    "--allow-run=explorer.exe,powershell.exe,rundll32.exe",
    "--allow-ffi=kernel32.dll",
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
    assertEquals(
      await desktopPackageFlags(`file://${join(bare, "scripts", "package-macos.ts")}`, "darwin"),
      [...DESKTOP_BASELINE_FLAGS],
    );
    assertEquals(
      await desktopPackageFlags(`file://${join(withCfg, "scripts", "package-macos.ts")}`, "darwin"),
      [...DESKTOP_BASELINE_FLAGS, "--allow-sys=osRelease", "--allow-run=open,osascript"],
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
