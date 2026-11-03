// The denext/expo shim manifest (src/expo/manifest.ts) against the shims themselves, the
// deno.json exports, the prebuilt-runtime wiring, and the pinned versions in the reference
// package.json fixture (tests/fixtures/expo-pins).

import { assert, assertEquals } from "@std/assert";
import { EXPO_SHIMS } from "../src/expo/manifest.ts";
import {
  EXPO_FILTER,
  expoRuntimeEntries,
  expoRuntimeFiles,
  expoShimName,
  expoShimSpecifier,
  isExpoBridgeImport,
} from "../src/build/expo-shims.ts";
import { runtimeEntryPoints } from "../src/build/next-compat.ts";
import { isSqliteWasmBridgeImport } from "../src/build/sqlite-wasm.ts";

const EXPO_DIR = new URL("../src/expo/", import.meta.url);

/** The shim name of a manifest module path. */
const nameOf = (module: string) => module.replace(/^\.\//, "").replace(/\.ts$/, "");

/**
 * The npm package of a manifest key (`expo-file-system/legacy` → `expo-file-system`,
 * `@expo/ui/swift-ui` → `@expo/ui`).
 */
const packageOf = (key: string) =>
  key.startsWith("@") ? key.split("/").slice(0, 2).join("/") : key.split("/")[0];

Deno.test("expo manifest: every entry's module exists, exports something, and omits what it says", async () => {
  for (const [pkg, shim] of Object.entries(EXPO_SHIMS)) {
    assert(
      /^(expo(-[a-z0-9-]+)?(\/[a-z0-9-]+)*|@expo\/[a-z0-9-]+(\/[a-z0-9-]+)+)$/.test(pkg),
      `${pkg} is an expo package name`,
    );
    // A subpath of an unscoped package extends that package's shim; a scoped package is
    // shimmed per subpath only.
    if (pkg.includes("/") && !pkg.startsWith("@")) {
      assert(packageOf(pkg) in EXPO_SHIMS, `${pkg}: its package has a shim`);
    }
    assert(["full", "partial", "stub"].includes(shim.status), `${pkg}: status`);
    assert(/^\d+\.\d+\.\d+$/.test(shim.pinned), `${pkg}: pinned is an exact version`);
    const mod = await import(new URL(shim.module, EXPO_DIR).href);
    assert(Object.keys(mod).length > 0, `${pkg}: ${shim.module} exports nothing`);
    for (const name of shim.omitted ?? []) {
      assert(!(name in mod), `${pkg}: "${name}" is listed as omitted but exported`);
    }
  }
});

Deno.test("expo manifest: every src/expo module has an entry, an export and a runtime entry", async () => {
  const modules = new Set(Object.values(EXPO_SHIMS).map((s) => s.module));
  const exports = JSON.parse(await Deno.readTextFile(new URL("../deno.json", import.meta.url)))
    .exports as Record<string, string>;
  for await (const entry of Deno.readDir(EXPO_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    // The manifest itself: its public module, the hand-written data and the packed copy.
    if (/^manifest(?:-data(?:\.packed)?)?\.ts$/.test(entry.name)) continue;
    assert(modules.has(`./${entry.name}`), `src/expo/${entry.name} has no manifest entry`);
  }
  const runtime = runtimeEntryPoints("file:///fw/");
  const files = expoRuntimeFiles();
  for (const [pkg, shim] of Object.entries(EXPO_SHIMS)) {
    const file = nameOf(shim.module);
    const name = expoShimName(pkg)!;
    const flat = name.replaceAll("/", "-");
    assertEquals(exports[`./expo/${name}`], `./src/expo/${file}.ts`, `deno.json export for ${pkg}`);
    assertEquals(
      runtime[`expo-${flat}`],
      `file:///fw/src/expo/${file}.ts`,
      `runtime entry for ${pkg}`,
    );
    assertEquals(files[`denext/expo/${name}`], `expo-${flat}.js`);
    assertEquals(expoShimSpecifier(pkg), `denext/expo/${name}`);
  }
  assertEquals(expoShimName("expo-haptics"), "haptics");
  assertEquals(expoShimName("expo-file-system/legacy"), "file-system/legacy");
  assertEquals(expoShimName("expo-task-manager"), null);
  assertEquals(expoShimSpecifier("expo-file-system/legacy"), "denext/expo/file-system/legacy");
  assertEquals(files["denext/expo/file-system/legacy"], "expo-file-system-legacy.js");
  // SDK 58's `/next` is the package's main entry again: the same shim.
  assertEquals(expoShimSpecifier("expo-file-system/next"), "denext/expo/file-system");
  assertEquals(Object.keys(expoRuntimeEntries((r) => r)).length, Object.keys(EXPO_SHIMS).length);
  assertEquals(expoShimSpecifier("expo/fetch"), "denext/expo/expo");
  assertEquals(expoShimSpecifier("expo/config"), null);
  assertEquals(expoShimSpecifier("expo-haptics/build/Haptics"), null);
  assertEquals(expoShimSpecifier("expo-sqlite"), "denext/expo/sqlite");
  assertEquals(expoShimSpecifier("expo-sqlite/kv-store"), null);
  assertEquals(expoShimSpecifier("react-native"), null);
  assertEquals(expoShimName("@expo/ui/swift-ui"), "ui/swift-ui");
  assertEquals(
    expoShimSpecifier("@expo/ui/swift-ui/modifiers"),
    "denext/expo/ui/swift-ui/modifiers",
  );
  assertEquals(files["denext/expo/ui/jetpack-compose"], "expo-ui-jetpack-compose.js");
  assertEquals(expoShimSpecifier("@expo/ui"), null, "the scoped package itself is not shimmed");
  assertEquals(
    expoShimSpecifier("@expo/ui/community/masked-view"),
    "denext/expo/ui/community/masked-view",
  );
  assertEquals(expoShimSpecifier("@expo/ui/community/slider"), null, "its web build works");
  assertEquals(expoShimSpecifier("@expo/vector-icons"), null);
  assertEquals(
    expoShimSpecifier("expo-auth-session/providers/google"),
    "denext/expo/auth-session/providers/google",
  );
  assertEquals(expoShimSpecifier("expo-auth-session/providers/github"), null);
  assert(EXPO_FILTER.test("@expo/ui/swift-ui") && !EXPO_FILTER.test("@expo/vector-icons"));
});

/**
 * The `/legacy` and `/next` subpaths in the `exports` map of each shimmed package at its pinned
 * SDK 58 version (`npm view <pkg>@<pin> exports`; no other shimmed package exports one). `next`
 * points at the package's main entry, `legacy` at the pre-SDK-58 API.
 */
const EXPO_58_SUBPATHS: Readonly<Record<string, readonly ("legacy" | "next")[]>> = {
  "expo-calendar": ["next", "legacy"],
  "expo-contacts": ["next", "legacy"],
  "expo-file-system": ["next", "legacy"],
  "expo-media-library": ["next", "legacy"],
};

Deno.test("expo manifest: every /legacy and /next subpath Expo 58 exports is aliased to a shim", () => {
  for (const [pkg, subpaths] of Object.entries(EXPO_58_SUBPATHS)) {
    assert(pkg in EXPO_SHIMS, `${pkg} is shimmed`);
    for (const sub of subpaths) {
      const spec = `${pkg}/${sub}`;
      if (sub === "next") {
        assertEquals(expoShimSpecifier(spec), expoShimSpecifier(pkg), `${spec} is the main shim`);
      } else {
        // A legacy API is its own shim (and its own parity target).
        assert(spec in EXPO_SHIMS, `${spec} has a manifest entry`);
        assertEquals(expoShimSpecifier(spec), `denext/expo/${expoShimName(spec)}`, spec);
      }
    }
  }
  assertEquals(expoShimSpecifier("expo-calendar/legacy"), "denext/expo/calendar/legacy");
  assertEquals(expoShimSpecifier("expo-contacts/next"), "denext/expo/contacts");
});

Deno.test("expo-calendar/legacy, expo-contacts/legacy: the main shims' legacy functions, not the object API", async () => {
  const calendar = await import("../src/expo/calendar.ts");
  const calendarLegacy = await import("../src/expo/calendar-legacy.ts");
  assertEquals(calendarLegacy.getCalendarsAsync, calendar.getCalendarsAsync);
  assertEquals(calendarLegacy.EntityTypes, calendar.EntityTypes);
  assertEquals(calendarLegacy.PermissionStatus.GRANTED, "granted");
  assert(!("getCalendars" in calendarLegacy), "the object API is the main entry's");
  const contacts = await import("../src/expo/contacts.ts");
  const contactsLegacy = await import("../src/expo/contacts-legacy.ts");
  assertEquals(contactsLegacy.getContactsAsync, contacts.getContactsAsync);
  assertEquals(contactsLegacy.Fields, contacts.Fields);
  assertEquals(contactsLegacy.onContactsChangeEventName, "onContactsChange");
  // `Contact` / `Group` are the legacy record types there, not the classes.
  assert(!("Contact" in contactsLegacy) && !("Group" in contactsLegacy));
});

Deno.test("expo bridge: only the shims' import of internal/react-native.ts is externalized", () => {
  const cases: Array<[string, string, boolean]> = [
    ["./internal/react-native.ts", "file:///fw/src/expo/image.ts", true],
    ["./react-native.ts", "file:///fw/src/expo/internal/common.ts", true],
    ["./internal/react-native.ts", "https://jsr.io/@denext/denext/2.10.0/src/expo/blur.ts", true],
    ["./internal/react-native.ts", "/fw/src/expo/video.ts", true],
    ["./react-native.ts", "file:///fw/src/build/x.ts", false],
    ["./other.ts", "file:///fw/src/expo/image.ts", false],
  ];
  for (const [path, importer, expected] of cases) {
    assertEquals(isExpoBridgeImport(path, importer), expected, `${path} from ${importer}`);
  }
});

Deno.test("sqlite bridge: only denext/mobile's import of sqlite-wasm.ts is externalized", () => {
  const cases: Array<[string, string, boolean]> = [
    ["./sqlite-wasm.ts", "file:///fw/src/mobile/sqlite.ts", true],
    ["./sqlite-wasm.ts", "https://jsr.io/@denext/denext/2.10.0/src/mobile/sqlite.ts", true],
    ["./sqlite-wasm.ts", "/fw/src/mobile/sqlite.ts", true],
    ["./sqlite-wasm.ts", "file:///fw/src/expo/sqlite.ts", false],
    ["../mobile/sqlite-wasm.ts", "file:///app/src/mobile/x.ts", true],
    ["./other.ts", "file:///fw/src/mobile/sqlite.ts", false],
  ];
  for (const [path, importer, expected] of cases) {
    assertEquals(isSqliteWasmBridgeImport(path, importer), expected, `${path} from ${importer}`);
  }
});

/** The reference package.json whose expo-* pins the manifest is meant to track. */
const PINS_FIXTURE = new URL("./fixtures/expo-pins/package.json", import.meta.url);

Deno.test("expo manifest: pinned versions match the reference package.json fixture", async () => {
  const deps = JSON.parse(await Deno.readTextFile(PINS_FIXTURE)).dependencies as Record<
    string,
    string
  >;
  for (const [key, shim] of Object.entries(EXPO_SHIMS)) {
    const pkg = packageOf(key);
    assert(pkg in deps, `${pkg} is not in the reference package.json`);
    assertEquals(shim.pinned, deps[pkg].replace(/^[~^]/, ""), `${key} pin`);
  }
  for (const pkg of Object.keys(deps).filter((d) => /^expo(-|$)/.test(d))) {
    assert(Object.keys(EXPO_SHIMS).some((k) => packageOf(k) === pkg), `${pkg} has no shim`);
  }
});
