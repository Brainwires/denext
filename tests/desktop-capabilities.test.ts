// `denext desktop add` (src/build/desktop-capabilities.ts): the capability table, the
// desktop.capabilities config splice (idempotent, comment-preserving, dry-run), and the
// permission flags each capability implies.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  addDesktopCapabilities,
  DESKTOP_CAPABILITIES,
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
  assertStringIncludes(out, "BROAD");
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
    new URL("../apps/web/app/docs/desktop/page.tsx", import.meta.url),
  );
  for (const name of Object.keys(DESKTOP_CAPABILITIES)) {
    assertStringIncludes(page, `<code>${name}</code>`, `docs/desktop is missing ${name}`);
  }
});
