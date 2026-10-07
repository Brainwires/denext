// React Native mode's `AppState` `memoryWarning` (src/react-native/app-state.ts): inside the
// Capacitor shell the bridge forwards the OS's low-memory signal as the `denext:memorywarning`
// window event (iOS: `DenextMemoryWarning` in every DenextBridgeViewController,
// src/build/bridge-memory-warning-native-template.ts; Android: `onTrimMemory` / `onLowMemory` in
// the composed MainActivity, src/build/mobile-native-install.ts), and AppState emits it to its
// `memoryWarning` listeners. A browser and a Deno Desktop window never fire it. The native halves
// are compiled where swiftc (with the iOS SDK) and javac exist.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  AppState,
  MEMORY_WARNING_EVENT,
  resetAppStateForTesting,
} from "../src/react-native/app-state.ts";
import {
  MEMORY_WARNING_INSTALL,
  MEMORY_WARNING_SWIFT,
  NATIVE_MEMORY_WARNING_EVENT as NATIVE_EVENT,
  withMemoryWarning,
} from "../src/build/bridge-memory-warning-native-template.ts";
import { FRAME_GUARD_INSTALL } from "../src/build/bridge-frame-guard-native-template.ts";
import {
  type AndroidFeature,
  bridgeViewControllerSource,
  mainActivitySource,
  type NativeFeature,
} from "../src/build/mobile-native-install.ts";
import { renderMarkedTemplate } from "../src/build/native-template-marker.ts";
import { addSettingsToProject } from "../src/build/mobile-settings-install.ts";
import { inShell, withGlobals } from "./helpers/mobile-fakes.ts";
import { IGNORE_WITHOUT_JDK, requireJdk } from "./_jdk.ts";

/** Fire the bridge's event, as Capacitor's `triggerWindowJSEvent` does. */
const fire = () => globalThis.dispatchEvent(new Event(MEMORY_WARNING_EVENT));

// ---- AppState ------------------------------------------------------------------------------

Deno.test("memoryWarning: the shell's window event reaches every listener, with no argument", async () => {
  try {
    for (const platform of ["ios", "android"] as const) {
      await inShell(platform, {}, () => {
        const seen: unknown[][] = [];
        const changes: string[] = [];
        const a = AppState.addEventListener("memoryWarning", (...args) => void seen.push(args));
        const b = AppState.addEventListener("memoryWarning", (...args) => void seen.push(args));
        const c = AppState.addEventListener("change", (s) => void changes.push(s));
        fire();
        assertEquals(seen, [[undefined], [undefined]], platform);
        assertEquals(changes, [], "a memory warning is not a state change");
        a.remove();
        fire();
        assertEquals(seen.length, 3, "a removed listener is not called");
        b.remove();
        c.remove();
        fire();
        assertEquals(seen.length, 3, "the source stops with the last listener");
      });
      resetAppStateForTesting();
    }
  } finally {
    resetAppStateForTesting();
  }
});

Deno.test("memoryWarning: a browser and a Deno Desktop window never fire it", async () => {
  try {
    for (const globals of [{}, { __denext: { desktop: true } }]) {
      await withGlobals(globals, () => {
        let calls = 0;
        const sub = AppState.addEventListener("memoryWarning", () => void calls++);
        fire();
        assertEquals(calls, 0, JSON.stringify(globals));
        assertEquals(typeof sub.remove, "function", "still a subscription");
        sub.remove();
      });
      resetAppStateForTesting();
    }
  } finally {
    resetAppStateForTesting();
  }
});

Deno.test("memoryWarning: the native halves fire the event AppState listens for", async () => {
  assertEquals(NATIVE_EVENT, MEMORY_WARNING_EVENT);
  assertStringIncludes(MEMORY_WARNING_SWIFT, `triggerWindowJSEvent(eventName: "${NATIVE_EVENT}")`);
  assertStringIncludes(
    await mainActivitySource("com.example.app", new Set()),
    `bridge.triggerWindowJSEvent("${NATIVE_EVENT}")`,
  );
});

// ---- iOS: the bridge view controller ---------------------------------------------------------

/** The bridge variants: OTA alone, OTA composed, auth-session alone, registering-only ones. */
const VARIANTS: readonly (readonly NativeFeature[])[] = [
  [],
  ["ota"],
  ["ota", "auth-session", "settings", "storage"],
  ["auth-session"],
  ["settings"],
  ["context-menu", "native-modules"],
];

/** The generation denext 3.2.0 wrote for each bridge family (before the forwarder). */
const V3_2_0_GENERATIONS: Readonly<Record<string, number>> = {
  ota: 7,
  "auth-session": 4,
  "app-extension": 4,
};

Deno.test("memoryWarning (iOS): every bridge variant installs the forwarder once, after the guard", async () => {
  for (const set of VARIANTS) {
    const label = set.join("+") || "(none)";
    const text = await bridgeViewControllerSource(new Set(set));
    assertStringIncludes(text, FRAME_GUARD_INSTALL + MEMORY_WARNING_INSTALL, label);
    assertEquals(text.split("enum DenextMemoryWarning").length, 2, label);
    assertStringIncludes(text, MEMORY_WARNING_SWIFT, label);
    // A marker 3.2.0's installers see as newer, so they keep the file instead of dropping it.
    const [, family, generation] = /^\/\/ denext-([a-z-]+)-template: (\d+) /.exec(text) ?? [];
    assert(family in V3_2_0_GENERATIONS, label);
    assert(Number(generation) > V3_2_0_GENERATIONS[family], `${label}: ${family} ${generation}`);
  }
});

Deno.test("memoryWarning (iOS): the Swift observes the system notification for the bridge", () => {
  assertStringIncludes(MEMORY_WARNING_SWIFT, "UIApplication.didReceiveMemoryWarningNotification");
  // Weak: the observer outlives nothing it should keep alive.
  assertStringIncludes(MEMORY_WARNING_SWIFT, "[weak bridge]");
  // A recreated bridge replaces the observer instead of adding a second.
  assertStringIncludes(MEMORY_WARNING_SWIFT, "NotificationCenter.default.removeObserver(observer)");
  assert(!MEMORY_WARNING_SWIFT.includes("`") && !MEMORY_WARNING_SWIFT.includes("${"));
  assertThrows(() => withMemoryWarning("class X {}\n"), Error, "no place for the memory warning");
});

const has = (tool: string, args = ["-version"]): boolean => {
  try {
    return new Deno.Command(tool, { args, stdout: "null", stderr: "null" }).outputSync().success;
  } catch {
    return false;
  }
};

const IOS_SDK = Deno.build.os === "darwin" &&
  has("xcrun", ["--sdk", "iphoneos", "--show-sdk-path"]);

Deno.test({
  name: "memoryWarning (iOS): the forwarder type-checks against UIKit and a Capacitor stub",
  ignore: !IOS_SDK,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "denext_memory_warning_swift_" });
    try {
      const file = join(dir, "MemoryWarning.swift");
      await Deno.writeTextFile(
        file,
        `import UIKit
@objc protocol CAPBridgeProtocol: NSObjectProtocol {
    func triggerWindowJSEvent(eventName: String)
}
${MEMORY_WARNING_SWIFT}`,
      );
      const out = await new Deno.Command("xcrun", {
        args: [
          "--sdk",
          "iphoneos",
          "swiftc",
          "-typecheck",
          "-swift-version",
          "5",
          "-target",
          "arm64-apple-ios15.0",
          file,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(out.success, new TextDecoder().decode(out.stderr));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// ---- iOS: upgrading a bridge an earlier denext wrote -------------------------------------------

const PBXPROJ_FIXTURE = await Deno.readTextFile(
  new URL("./fixtures/capacitor8/project.pbxproj", import.meta.url),
);
const BRIDGE = "ios/App/App/DenextBridgeViewController.swift";

Deno.test("memoryWarning (iOS): a 3.2.0 bridge without the forwarder is upgraded in place", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_memory_warning_" });
  try {
    const files: Record<string, string> = {
      "capacitor.config.json": JSON.stringify({ appId: "dev.example", webDir: "out" }),
      "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "^8.0.0" } }),
      "ios/App/App.xcodeproj/project.pbxproj": PBXPROJ_FIXTURE,
      "ios/App/App/SceneDelegate.swift": "import UIKit\nimport Capacitor\n",
    };
    for (const [path, content] of Object.entries(files)) {
      await Deno.mkdir(join(dir, path, ".."), { recursive: true });
      await Deno.writeTextFile(join(dir, path), content);
    }
    await addSettingsToProject({ dir });
    const current = await Deno.readTextFile(join(dir, BRIDGE));
    const body = current.slice(current.indexOf("\n") + 1)
      .replace(MEMORY_WARNING_INSTALL, "")
      .replace(MEMORY_WARNING_SWIFT, "");
    assert(!body.includes("DenextMemoryWarning"));
    await Deno.writeTextFile(
      join(dir, BRIDGE),
      await renderMarkedTemplate("app-extension", V3_2_0_GENERATIONS["app-extension"], body),
    );
    const again = await addSettingsToProject({ dir });
    assertEquals(again.kept, []);
    assert(again.upgraded.includes(BRIDGE), again.upgraded.join());
    assertEquals(await Deno.readTextFile(join(dir, BRIDGE)), current);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---- Android: the composed MainActivity ----------------------------------------------------

Deno.test("memoryWarning (Android): every MainActivity overrides onTrimMemory and onLowMemory", async () => {
  const sets: AndroidFeature[][] = [[], ["ota"], ["settings", "context-menu"], ["back", "storage"]];
  for (const set of sets) {
    const label = set.join("+") || "(none)";
    const text = await mainActivitySource("com.example.app", new Set(set));
    // Generation 5: 3.2.0 (generation 4) keeps it instead of rewriting the forwarder away.
    assert(text.startsWith("// denext-main-activity-template: 5 "), label);
    for (
      const needle of [
        "public void onTrimMemory(int level) {\n        super.onTrimMemory(level);",
        "public void onLowMemory() {\n        super.onLowMemory();\n        memoryWarning();",
        "if (bridge != null) bridge.triggerWindowJSEvent(",
      ]
    ) assertStringIncludes(text, needle, label);
    // Inside the class, after the renderer recovery, before the export routes.
    const at = text.indexOf("public void onTrimMemory");
    assert(at > text.indexOf("class RendererRecovery"), label);
    assert(at < text.indexOf("class DenextExportRoutes"), label);
  }
});

/** The `isMemoryWarning` method, lifted out of the composed MainActivity. */
async function javaIsMemoryWarning(): Promise<string> {
  const java = await mainActivitySource("com.example.app", new Set());
  const start = java.indexOf("    static boolean isMemoryWarning(int level) {");
  const end = java.indexOf("    private void memoryWarning() {");
  assert(start > 0 && end > start, "no isMemoryWarning method in the MainActivity");
  return java.slice(start, end);
}

Deno.test({
  name: "memoryWarning (Android): the trim levels that warn (compiled)",
  ignore: IGNORE_WITHOUT_JDK,
  async fn() {
    requireJdk();
    const dir = await Deno.makeTempDir({ prefix: "denext_memory_warning_java_" });
    try {
      await Deno.writeTextFile(
        join(dir, "Harness.java"),
        `public final class Harness {
${await javaIsMemoryWarning()}
    public static void main(String[] args) {
        for (String a : args) System.out.println(isMemoryWarning(Integer.parseInt(a)));
    }
}
`,
      );
      const compile = await new Deno.Command("javac", {
        args: ["-d", dir, join(dir, "Harness.java")],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(compile.success, new TextDecoder().decode(compile.stderr));
      // RUNNING_MODERATE, RUNNING_LOW, RUNNING_CRITICAL, UI_HIDDEN, BACKGROUND, MODERATE, COMPLETE.
      const levels = [5, 10, 15, 20, 40, 60, 80];
      const run = await new Deno.Command("java", {
        args: ["-cp", dir, "Harness", ...levels.map(String)],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(run.success, new TextDecoder().decode(run.stderr));
      assertEquals(
        new TextDecoder().decode(run.stdout).trim().split("\n"),
        ["false", "true", "true", "false", "true", "true", "true"],
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
