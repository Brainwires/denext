// Over-the-air UI re-verification (`denext mobile add-ota`, OTA template generation 9): a
// downloaded UI is verified when it arrives AND whenever the shell serves it. Every launch checks
// the manifest stored with the files (signature with the embedded key, version recomputed from
// the file list) before the first page, and each file's SHA-256 is checked the first time it is
// served in a process (iOS: `DenextOtaRouter` in front of the asset handler; Android: the
// `RouteProcessor` `DenextOta.prepare` gives the bridge). A file changed, added or removed on the
// device after the download quarantines the version, the shell falls back to its bundled UI and
// the page hears `otaRejected`.
//
// The native halves are compiled and RUN where the toolchains exist: the Java templates against
// plain-JDK stand-ins for Android / Capacitor / org.json (javac + java), the Swift store on macOS
// against a Capacitor stub module (swiftc), and the Swift plugin type-checked against UIKit (the
// iOS SDK). The fixtures live in tests/fixtures/ota-reverify/.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  OTA_ANDROID_FILES,
  OTA_IOS_FILES,
  OTA_TEMPLATE_VERSION,
} from "../src/build/ota-native-templates.ts";
import { EXPORT_ROUTER_SWIFT } from "../src/build/bridge-export-router-native-template.ts";
import { addOtaToProject } from "../src/build/mobile-ota-install.ts";
import { runMobileDoctor } from "../src/build/mobile-doctor.ts";

const FIXTURES = new URL("./fixtures/ota-reverify/", import.meta.url);
const fixture = (path: string) => new URL(path, FIXTURES).pathname;

const IOS_STORE = OTA_IOS_FILES["DenextOtaStore.swift"];
const IOS_PLUGIN = OTA_IOS_FILES["DenextOtaPlugin.swift"];
const IOS_BRIDGE = OTA_IOS_FILES["DenextBridgeViewController.swift"];
const ANDROID_STORE = OTA_ANDROID_FILES["DenextOtaStore.java"];
const ANDROID_PLUGIN = OTA_ANDROID_FILES["DenextOtaPlugin.java"];
const ANDROID_ENTRY = OTA_ANDROID_FILES["DenextOta.java"];

/** `source` from `signature` to the first blank line (one member of a template). */
function member(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert(start >= 0, `missing ${signature}`);
  const end = source.indexOf("\n\n", start);
  return source.slice(start, end === -1 ? undefined : end);
}

// ---- the templates ---------------------------------------------------------------------------

Deno.test("OTA re-verification: generation 9 carries it on both platforms", () => {
  // An older denext keeps a generation-9 file instead of rewriting the check away.
  assert(OTA_TEMPLATE_VERSION >= 9);
  // iOS: the bridge's router checks each file; launch checks the stored manifest first.
  assertStringIncludes(
    IOS_BRIDGE,
    "override open func router() -> Router {\n        DenextOtaRouter()\n",
  );
  assertStringIncludes(IOS_STORE, "struct DenextOtaRouter: Router {");
  assertStringIncludes(
    member(IOS_STORE, "    func route(for path: String) -> String {"),
    'DenextOtaStore.shared.admit(file, servedFrom: basePath) ? file : basePath + "/"',
  );
  const launch = member(IOS_STORE, "    func prepareLaunch() -> (directory: URL?, trial: Bool) {");
  assertStringIncludes(launch, "_ = try installedUi(version)");
  assertStringIncludes(
    launch,
    "report(version, reason: error.localizedDescription, serving: false)",
  );
  // Android: the route processor goes in before the bridge is built; launch verifies the same way.
  const prepare = member(ANDROID_ENTRY, "    public static void prepare(");
  assert(
    prepare.indexOf("bridgeBuilder.setRouteProcessor(store.routes());") <
      prepare.indexOf("store.startDirectory()"),
    prepare,
  );
  assertStringIncludes(ANDROID_STORE, "static final class Routes implements RouteProcessor {");
  assertStringIncludes(
    member(ANDROID_STORE, "        public ProcessedRoute process(String basePath, String path) {"),
    "route.setPath(store.admit(served, path) ? served + path : served);",
  );
  assertStringIncludes(
    member(ANDROID_STORE, "    synchronized File startDirectory() {"),
    "installedUi(version);",
  );
});

Deno.test("OTA re-verification: the stored manifest keeps every field the signature covers", () => {
  const swift = member(
    IOS_STORE,
    "    static func storedManifest(_ request: ApplyRequest) throws -> Data {",
  );
  for (
    const line of [
      `"required": request.required`,
      `"notes": request.notes`,
      `manifest["sequence"] = sequence`,
      `manifest["minNative"] = minNative`,
      `manifest["nativeFingerprint"] = nativeFingerprint`,
      `manifest["signature"] = signature`,
    ]
  ) assertStringIncludes(swift, line);
  const java = ANDROID_STORE.slice(ANDROID_STORE.indexOf("private static void writeManifest("));
  for (
    const field of ["required", "notes", "sequence", "minNative", "nativeFingerprint", "signature"]
  ) {
    assertStringIncludes(java.slice(0, java.indexOf("File target")), `.put("${field}"`);
  }
  // The launch check verifies the signature over the same payload the download did.
  assertStringIncludes(
    member(IOS_STORE, "    static func verifyInstalled("),
    'guard isValidSignature(manifest["signature"] as? String, by: key, over: payload) else {',
  );
  assertStringIncludes(
    ANDROID_STORE,
    "if (!isValidSignature(key, payload, signature instanceof String ? (String) signature : null)) {",
  );
});

Deno.test("OTA re-verification: the plugins report it (status.tampered, the retained otaRejected event)", () => {
  assertStringIncludes(IOS_PLUGIN, `"tampered": store.tampered ?? NSNull()`);
  assertStringIncludes(
    IOS_PLUGIN,
    `notifyListeners("otaRejected", data: ["version": version, "reason": reason], retainUntilConsumed: true)`,
  );
  assertStringIncludes(IOS_PLUGIN, "switchWebView(to: store.fallbackDirectory())");
  assertStringIncludes(ANDROID_PLUGIN, `result.put("tampered", orNull(store.tampered()));`);
  assertStringIncludes(ANDROID_PLUGIN, `notifyListeners("otaRejected", event, true);`);
  assertStringIncludes(ANDROID_PLUGIN, "switchWebView(store.fallbackDirectory());");
  assertStringIncludes(ANDROID_PLUGIN, "store().attach(getBridge(), ");
  // A reset forgets it, on both platforms.
  assertStringIncludes(member(IOS_STORE, "    func reset() {"), "Key.tampered");
  assertStringIncludes(ANDROID_STORE, ".remove(KEY_TAMPERED)");
});

// ---- the doctor and the upgrade --------------------------------------------------------------

const PBXPROJ = await Deno.readTextFile(
  new URL("./fixtures/capacitor8/project.pbxproj", import.meta.url),
);

/** A Capacitor 8 project with both platforms. */
async function project(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ota_reverify_" });
  const files: Record<string, string> = {
    "capacitor.config.json": JSON.stringify({ appId: "com.example.app", webDir: "out" }),
    "out/index.html": "<!doctype html>",
    "ios/App/App.xcodeproj/project.pbxproj": PBXPROJ,
    "ios/App/App/SceneDelegate.swift": "import UIKit\nimport Capacitor\n",
    "android/app/src/main/java/com/example/app/MainActivity.java":
      "package com.example.app;\n\nimport com.getcapacitor.BridgeActivity;\n\npublic class MainActivity extends BridgeActivity {}\n",
  };
  for (const [path, content] of Object.entries(files)) {
    await Deno.mkdir(join(dir, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, path), content);
  }
  return dir;
}

/** Whether this checkout has `tag` (a shallow CI clone may not). */
function hasTag(tag: string): boolean {
  try {
    return new Deno.Command("git", { args: ["rev-parse", "-q", "--verify", `refs/tags/${tag}`] })
      .outputSync().success;
  } catch {
    return false;
  }
}

/**
 * The OTA files exactly as `add-ota` wrote them at `tag`: the module at that tag, its imports
 * pointed at this checkout's helper modules.
 */
async function writtenAt(
  tag: string,
): Promise<{ generation: number; files: Record<string, string> }> {
  const out = await new Deno.Command("git", {
    args: ["show", `${tag}:src/build/ota-native-templates.ts`],
  }).output();
  assert(out.success);
  const build = new URL("../src/build/", import.meta.url).href;
  const source = new TextDecoder().decode(out.stdout).replaceAll(`from "./`, `from "${build}`);
  const file = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(file, source);
    const mod = await import(`file://${file}`);
    const files: Record<string, string> = {};
    for (const [name, text] of Object.entries({ ...mod.OTA_IOS_FILES, ...mod.OTA_ANDROID_FILES })) {
      files[name] = await mod.renderOtaTemplate(text as string);
    }
    return { generation: mod.OTA_TEMPLATE_VERSION, files };
  } finally {
    await Deno.remove(file);
  }
}

const IOS_DIR = "ios/App/App";
const ANDROID_DIR = "android/app/src/main/java/dev/denext/ota";

Deno.test({
  name: "OTA re-verification: the doctor flags a 3.2.0 plugin, and add-ota upgrades it in place",
  ignore: !hasTag("v3.2.0"),
  async fn() {
    const { generation, files } = await writtenAt("v3.2.0");
    assert(generation < 9, `3.2.0 shipped generation ${generation}`);
    assert(!files["DenextOtaStore.swift"].includes("verifyInstalled"));
    const dir = await project();
    try {
      await addOtaToProject({ dir });
      const current: Record<string, string> = {};
      for (const name of Object.keys(files)) {
        const path = join(dir, name.endsWith(".swift") ? IOS_DIR : ANDROID_DIR, name);
        current[name] = await Deno.readTextFile(path);
        await Deno.writeTextFile(path, files[name]);
      }
      for (const profile of ["store", "release"] as const) {
        const report = await runMobileDoctor({ root: dir, profile });
        const hit = report.findings.filter((f) => f.check === "ota-reverify");
        assertEquals(hit.map((f) => f.message.split(":")[0]), ["iOS", "Android"], profile);
        assert(hit.every((f) => f.level === "error"));
        assertStringIncludes(hit[0].message, "predates re-verification");
        assertStringIncludes(hit[0].fix, "denext mobile add-ota");
      }
      // An unedited earlier template is upgraded without --force, and the finding is gone.
      const again = await addOtaToProject({ dir });
      assertEquals(again.kept, []);
      for (const name of Object.keys(files)) {
        const path = join(dir, name.endsWith(".swift") ? IOS_DIR : ANDROID_DIR, name);
        assertEquals(await Deno.readTextFile(path), current[name], name);
      }
      const after = await runMobileDoctor({ root: dir, profile: "release" });
      assertEquals(after.findings.filter((f) => f.check === "ota-reverify"), []);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("OTA re-verification: the doctor needs both halves per platform", async () => {
  const dir = await project();
  try {
    await addOtaToProject({ dir });
    const clean = await runMobileDoctor({ root: dir, profile: "store" });
    assert(clean.checks.includes("ota-reverify"));
    assertEquals(clean.findings.filter((f) => f.check === "ota-reverify"), []);
    // A store with the launch check but a bridge whose router serves without it (an edit).
    const bridge = join(dir, IOS_DIR, "DenextBridgeViewController.swift");
    await Deno.writeTextFile(
      bridge,
      (await Deno.readTextFile(bridge)).replace("DenextOtaRouter()", "DenextExportRouter()"),
    );
    // An Android entry point that no longer installs the route processor.
    const entry = join(dir, ANDROID_DIR, "DenextOta.java");
    await Deno.writeTextFile(
      entry,
      (await Deno.readTextFile(entry)).replace(
        "bridgeBuilder.setRouteProcessor(store.routes());",
        "",
      ),
    );
    const flagged = await runMobileDoctor({ root: dir, profile: "release" });
    assertEquals(
      flagged.findings.filter((f) => f.check === "ota-reverify").map((f) =>
        f.message.split(":")[0]
      ),
      ["iOS", "Android"],
    );
    // No OTA plugin at all: the check does not apply.
    const none = await project();
    try {
      assert(
        !(await runMobileDoctor({ root: none, profile: "release" })).checks.includes(
          "ota-reverify",
        ),
      );
    } finally {
      await Deno.remove(none, { recursive: true });
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---- the native halves, compiled and run -----------------------------------------------------

const has = (tool: string, args = ["-version"]): boolean => {
  try {
    return new Deno.Command(tool, { args, stdout: "null", stderr: "null" }).outputSync().success;
  } catch {
    return false;
  }
};

/** Every `.java` file under `dir`. */
function javaFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) out.push(...javaFiles(path));
    else if (entry.name.endsWith(".java")) out.push(path);
  }
  return out;
}

/** Run `cmd`; fail with its stderr unless it succeeds. Returns stdout. */
async function run(cmd: string, args: string[]): Promise<string> {
  const out = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" }).output();
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  assert(out.success, `${cmd} failed:\n${decode(out.stderr)}\n${decode(out.stdout)}`);
  return decode(out.stdout);
}

/** The checks both harnesses run (the Java one has a few more), each of which must pass. */
const SHARED_CHECKS = [
  "launch serves a downloaded UI whose stored manifest verifies",
  "an untampered file is served",
  "the stored manifest is served (pageUiVersion)",
  "a missing unlisted file is refused without quarantining",
  "a path that climbs out is refused without quarantining",
  "a launch over a changed file still starts (the manifest verifies)",
  "the unchanged page is served",
  "the changed file is refused",
  "the version is recorded as tampered",
  "it is no longer current",
  "its directory moved to quarantine/",
  "the plugin is told while it is being served",
  "nothing else of it is served afterwards",
  "the next launch serves the bundled UI",
  "a stored manifest whose signature no longer verifies is refused at launch",
  "it is recorded as tampered and quarantined",
  "the plugin hears it once it loads",
  "a manifest signed by another key is refused at launch",
  "a file the manifest does not list is refused and quarantines the UI",
  "a pending UI that fails re-verification is not tried",
  "its trial is cleared",
  "without a key, a UI whose manifest matches its version is served",
  "without a key, a changed file is still refused",
  "a fresh download of a quarantined version is served again",
];

/** Asserts a harness's output: every line ok, the shared checks all present, a clean tally. */
function assertHarness(output: string, platform: string): void {
  const lines = output.trim().split("\n");
  const failed = lines.filter((l) => l.startsWith("FAIL"));
  assertEquals(failed, [], `${platform}:\n${output}`);
  const passed = new Set(lines.filter((l) => l.startsWith("ok ")).map((l) => l.slice(3)));
  for (const name of SHARED_CHECKS) assert(passed.has(name), `${platform}: no "${name}"`);
  assertEquals(lines.at(-1), "done 0");
}

Deno.test({
  name: "OTA re-verification (Android): the Java templates compile and refuse a tampered UI",
  ignore: !has("javac") || !has("java"),
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "denext_ota_reverify_java_" });
    try {
      const pkg = join(dir, "src", "dev", "denext", "ota");
      await Deno.mkdir(pkg, { recursive: true });
      for (const [name, text] of Object.entries(OTA_ANDROID_FILES)) {
        await Deno.writeTextFile(join(pkg, name), text);
      }
      await Deno.copyFile(fixture("OtaReverifyHarness.java"), join(pkg, "OtaReverifyHarness.java"));
      const classes = join(dir, "classes");
      await run("javac", [
        "-nowarn",
        "-d",
        classes,
        ...javaFiles(fixture("java")),
        ...javaFiles(pkg),
      ]);
      const work = join(dir, "work");
      await Deno.mkdir(work);
      const out = await run("java", ["-cp", classes, "dev.denext.ota.OtaReverifyHarness", work]);
      assertHarness(out, "android");
      assertStringIncludes(out, "ok the bundled assets are answered as Capacitor does");
      assertStringIncludes(
        out,
        "ok the stored manifest keeps the signed fields and verifies again",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

const MAC_SWIFT = Deno.build.os === "darwin" && has("swiftc", ["--version"]);

Deno.test({
  name: "OTA re-verification (iOS): the Swift store compiles and refuses a tampered UI",
  ignore: !MAC_SWIFT,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "denext_ota_reverify_swift_" });
    try {
      // The Capacitor stub as a module, then the store + the export router + the harness as one
      // executable (the harness reaches the store's internals).
      await Deno.copyFile(fixture("swift/CapacitorCore.swift"), join(dir, "Capacitor.swift"));
      await run("swiftc", [
        "-emit-library",
        "-emit-module",
        "-parse-as-library",
        "-module-name",
        "Capacitor",
        "-module-link-name",
        "Capacitor",
        "-emit-module-path",
        join(dir, "Capacitor.swiftmodule"),
        "-o",
        join(dir, "libCapacitor.dylib"),
        join(dir, "Capacitor.swift"),
      ]);
      await Deno.writeTextFile(join(dir, "DenextOtaStore.swift"), IOS_STORE);
      await Deno.writeTextFile(
        join(dir, "DenextExportRouter.swift"),
        "import Foundation\nimport Capacitor\n" + EXPORT_ROUTER_SWIFT,
      );
      await Deno.copyFile(fixture("OtaReverifyHarness.swift"), join(dir, "main.swift"));
      const bin = join(dir, "harness");
      await run("swiftc", [
        "-swift-version",
        "5",
        "-I",
        dir,
        "-L",
        dir,
        "-Xlinker",
        "-rpath",
        "-Xlinker",
        dir,
        "-o",
        bin,
        join(dir, "main.swift"),
        join(dir, "DenextOtaStore.swift"),
        join(dir, "DenextExportRouter.swift"),
      ]);
      const work = join(dir, "work");
      await Deno.mkdir(work);
      const out = await run(bin, [work]);
      assertHarness(out, "ios");
      assertStringIncludes(out, "ok an embedded key that does not parse refuses it (fail closed)");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

const IOS_SDK = Deno.build.os === "darwin" &&
  has("xcrun", ["--sdk", "iphoneos", "--show-sdk-path"]);

Deno.test({
  name:
    "OTA re-verification (iOS): the plugin and the store type-check against UIKit and a Capacitor stub",
  ignore: !IOS_SDK,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "denext_ota_reverify_ios_" });
    try {
      const xcrun = (args: string[]) =>
        run("xcrun", ["--sdk", "iphoneos", "swiftc", "-target", "arm64-apple-ios15.0", ...args]);
      await Deno.writeTextFile(
        join(dir, "Capacitor.swift"),
        (await Deno.readTextFile(fixture("swift/CapacitorCore.swift"))) +
          (await Deno.readTextFile(fixture("swift/CapacitorUI.swift"))),
      );
      await xcrun([
        "-emit-module",
        "-parse-as-library",
        "-module-name",
        "Capacitor",
        "-emit-module-path",
        join(dir, "Capacitor.swiftmodule"),
        join(dir, "Capacitor.swift"),
      ]);
      const sources = {
        "DenextOtaStore.swift": IOS_STORE,
        "DenextOtaPlugin.swift": IOS_PLUGIN,
        "DenextExportRouter.swift": "import Foundation\nimport Capacitor\n" + EXPORT_ROUTER_SWIFT,
      };
      for (const [name, text] of Object.entries(sources)) {
        await Deno.writeTextFile(join(dir, name), text);
      }
      await xcrun([
        "-typecheck",
        "-swift-version",
        "5",
        "-I",
        dir,
        ...Object.keys(sources).map((name) => join(dir, name)),
      ]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
