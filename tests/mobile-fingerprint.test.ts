// `denext mobile fingerprint`: the native-layer hash (src/build/mobile-fingerprint.ts) — its
// pinned line format, what it ignores, CRLF normalisation, the `server` block exclusion, the
// `--diff` explanation and the `--write` embedding.

import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  computeNativeFingerprint,
  diffNativeFingerprints,
  formatFingerprintDiff,
  isIgnoredNativePath,
  NATIVE_FINGERPRINT_INFO_KEY,
  NATIVE_FINGERPRINT_META,
  writeNativeFingerprint,
} from "../src/build/mobile-fingerprint.ts";
import { withDevServerUrl } from "../src/build/mobile-dev.ts";
import { sha256Hex } from "../src/mobile/ota-manifest.ts";
import { buildRegistry } from "../src/cli/register.ts";

const encoder = new TextEncoder();

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleVersion</key>
	<string>1</string>
</dict>
</plist>
`;

const ANDROID_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="App">
        <activity android:name=".MainActivity" />
    </application>
</manifest>
`;

const CONFIG_TS = `import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.example.app",
  appName: "Example",
  webDir: "www",
};

export default config;
`;

/** A package directory under node_modules with `pkg` as its package.json. */
function pkgFile(name: string, pkg: Record<string, unknown>): Record<string, string> {
  return { [`node_modules/${name}/package.json`]: JSON.stringify({ name, ...pkg }) };
}

/** The files of a small Capacitor project. */
function baseFiles(): Record<string, string | Uint8Array> {
  return {
    "capacitor.config.ts": CONFIG_TS,
    "package.json": JSON.stringify({
      dependencies: {
        "@capacitor/core": "8.0.0",
        "@capacitor/ios": "8.0.0",
        "@capacitor/android": "8.0.0",
        "@capacitor/app": "8.0.0",
        "capacitor-community-thing": "^1.0.0",
        "cordova-plugin-old": "^2.0.0",
        "left-pad": "^1.0.0",
      },
      devDependencies: { "@capacitor/cli": "8.0.0" },
    }),
    ...pkgFile("@capacitor/core", { version: "8.0.0" }),
    ...pkgFile("@capacitor/ios", { version: "8.0.0" }),
    ...pkgFile("@capacitor/android", { version: "8.0.0" }),
    ...pkgFile("@capacitor/cli", { version: "8.0.0" }),
    ...pkgFile("@capacitor/app", { version: "8.0.1" }),
    ...pkgFile("capacitor-community-thing", {
      version: "1.2.3",
      capacitor: { ios: { src: "ios" }, android: { src: "android" } },
    }),
    ...pkgFile("cordova-plugin-old", { version: "2.0.0" }),
    "node_modules/cordova-plugin-old/plugin.xml": "<plugin />",
    ...pkgFile("left-pad", { version: "1.3.0" }),
    "ios/App/App/Info.plist": INFO_PLIST,
    "ios/App/App/AppDelegate.swift": "import UIKit\n\nclass AppDelegate {}\n",
    "ios/App/App.xcodeproj/project.pbxproj": "// !$*UTF8*$!\n{ objects = {}; }\n",
    "ios/App/App/icon.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x1a]),
    "android/app/src/main/AndroidManifest.xml": ANDROID_MANIFEST,
    "android/app/build.gradle": "android {\n    namespace 'com.example.app'\n}\n",
  };
}

/** Write `files` under `dir`. */
async function writeFiles(dir: string, files: Record<string, string | Uint8Array>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, ...path.split("/"));
    await Deno.mkdir(join(target, ".."), { recursive: true });
    if (typeof content === "string") await Deno.writeTextFile(target, content);
    else await Deno.writeFile(target, content);
  }
}

/** A temporary project with `files` (default: {@linkcode baseFiles}), removed after `fn`. */
async function withProject(
  fn: (dir: string) => Promise<void>,
  files: Record<string, string | Uint8Array> = baseFiles(),
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext_fingerprint_" });
  try {
    await writeFiles(dir, files);
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const fp = async (dir: string) => (await computeNativeFingerprint(dir)).fingerprint;

Deno.test("fingerprint: the pinned line format", async () => {
  await withProject(async (dir) => {
    // A JSON config is hashed canonically (sorted keys, two-space indent, trailing newline).
    const canonical = JSON.stringify({ appId: "a", webDir: "www" }, null, 2) + "\n";
    const configHash = await sha256Hex(encoder.encode(canonical));
    const expected = await sha256Hex(
      encoder.encode(
        "denext-native-fingerprint-v1\n" +
          `capacitor.config.json\t${configHash}\n` +
          `ios/App/App/AppDelegate.swift\t${await sha256Hex(encoder.encode("class A {}\n"))}\n` +
          `npm:@capacitor/core\t${await sha256Hex(encoder.encode("8.1.0"))}\n`,
      ),
    );
    const result = await computeNativeFingerprint(dir);
    assertEquals(result.fingerprint, expected);
    assertEquals(result.inputs, [
      { kind: "config", path: "capacitor.config.json", hash: configHash },
      {
        kind: "file",
        path: "ios/App/App/AppDelegate.swift",
        hash: await sha256Hex(encoder.encode("class A {}\n")),
      },
      { kind: "capacitor", name: "@capacitor/core", version: "8.1.0" },
    ]);
  }, {
    "capacitor.config.json": `{ "webDir": "www",\n    "appId": "a" }`,
    "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "^8.0.0" } }),
    ...pkgFile("@capacitor/core", { version: "8.1.0" }),
    "ios/App/App/AppDelegate.swift": "class A {}\r\n",
  });
});

Deno.test("fingerprint: deterministic, and independent of where the project lives", async () => {
  await withProject(async (a) => {
    await withProject(async (b) => {
      const first = await computeNativeFingerprint(a);
      assertEquals(first.fingerprint, await fp(a));
      assertEquals(first.fingerprint, await fp(b));
      assertEquals(first.warnings, []);
      // Plugins: @capacitor/*, a `capacitor` field, a Cordova plugin.xml; never an ordinary dep.
      assertEquals(
        first.inputs.filter((i) => i.kind === "capacitor" || i.kind === "plugin"),
        [
          { kind: "capacitor", name: "@capacitor/android", version: "8.0.0" },
          { kind: "plugin", name: "@capacitor/app", version: "8.0.1" },
          { kind: "capacitor", name: "@capacitor/cli", version: "8.0.0" },
          { kind: "capacitor", name: "@capacitor/core", version: "8.0.0" },
          { kind: "capacitor", name: "@capacitor/ios", version: "8.0.0" },
          { kind: "plugin", name: "capacitor-community-thing", version: "1.2.3" },
          { kind: "plugin", name: "cordova-plugin-old", version: "2.0.0" },
        ],
      );
    });
  });
});

Deno.test("fingerprint: build output, caches, machine-local files and cap-sync copies are ignored", async () => {
  await withProject(async (dir) => {
    const before = await fp(dir);
    await writeFiles(dir, {
      "ios/App/Pods/Manifest.lock": "x",
      "ios/App/build/Build/Products/App.app/App": "x",
      "ios/DerivedData/x": "x",
      "ios/App/App.xcodeproj/xcuserdata/me.xcuserdatad/xcschemes/x.plist": "x",
      "ios/App/App.xcodeproj/project.xcworkspace/xcuserdata/me.xcuserdatad/UserInterfaceState.xcuserstate":
        "x",
      "ios/App/App/public/index.html": "<p>ui</p>",
      "ios/App/App/capacitor.config.json": `{"server":{"url":"http://x"}}`,
      "ios/App/App/config.xml": "<widget/>",
      "ios/App/CapApp-SPM/.build/x": "x",
      "ios/.DS_Store": "x",
      "android/.gradle/8.0/x": "x",
      "android/app/build/outputs/apk/app.apk": "x",
      "android/local.properties": "sdk.dir=/Users/me/Android",
      "android/.idea/workspace.xml": "x",
      "android/app/app.iml": "x",
      "android/app/src/main/assets/public/index.html": "<p>ui</p>",
      "android/app/src/main/assets/capacitor.config.json": "{}",
      "android/app/src/main/assets/capacitor.plugins.json": "[]",
      "android/capacitor-cordova-android-plugins/build.gradle": "x",
      "android/app/release/app-release.aab": "x",
      "android/release.keystore": "x",
      "android/.gitignore": "build/",
    });
    assertEquals(await fp(dir), before);
    // …while a real native source is an input.
    await Deno.writeTextFile(
      join(dir, "ios/App/App/AppDelegate.swift"),
      "import UIKit\n\nclass AppDelegate { var x = 1 }\n",
    );
    assertNotEquals(await fp(dir), before);
  });
  assert(isIgnoredNativePath("ios/App/Pods"));
  assert(isIgnoredNativePath("android/app/src/main/assets/public"));
  assert(!isIgnoredNativePath("ios/App/App/Info.plist"));
  assert(!isIgnoredNativePath("android/app/build.gradle"));
});

Deno.test("fingerprint: plugin versions count; other dependencies do not", async () => {
  await withProject(async (dir) => {
    const before = await computeNativeFingerprint(dir);
    await writeFiles(dir, pkgFile("left-pad", { version: "9.9.9" }));
    assertEquals(await fp(dir), before.fingerprint);
    await writeFiles(dir, pkgFile("@capacitor/app", { version: "8.0.2" }));
    const bumped = await computeNativeFingerprint(dir);
    assertNotEquals(bumped.fingerprint, before.fingerprint);
    const diff = diffNativeFingerprints(before, bumped);
    assertEquals(diff.modified.length, 1);
    assertEquals(diff.modified[0].after, {
      kind: "plugin",
      name: "@capacitor/app",
      version: "8.0.2",
    });
    // A new Capacitor plugin (declared and installed) is an input too.
    const pkg = JSON.parse(await Deno.readTextFile(join(dir, "package.json")));
    pkg.dependencies["@capacitor/haptics"] = "8.0.0";
    await writeFiles(dir, {
      "package.json": JSON.stringify(pkg),
      ...pkgFile("@capacitor/haptics", { version: "8.0.0" }),
    });
    const added = diffNativeFingerprints(bumped, await computeNativeFingerprint(dir));
    assertEquals(added.added, [{ kind: "plugin", name: "@capacitor/haptics", version: "8.0.0" }]);
  });
});

Deno.test("fingerprint: packages resolve upwards (a hoisted workspace); missing ones warn", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext_fingerprint_ws_" });
  try {
    const files = baseFiles();
    const app: Record<string, string | Uint8Array> = {};
    for (const [path, content] of Object.entries(files)) {
      // node_modules at the workspace root, the app one level down.
      app[path.startsWith("node_modules/") ? path : `apps/mobile/${path}`] = content;
    }
    await writeFiles(root, app);
    const hoisted = await computeNativeFingerprint(join(root, "apps/mobile"));
    await withProject(async (flat) => {
      assertEquals(hoisted.fingerprint, await fp(flat));
    });
    await Deno.remove(join(root, "node_modules/@capacitor/app"), { recursive: true });
    await Deno.remove(join(root, "node_modules/capacitor-community-thing"), { recursive: true });
    const missing = await computeNativeFingerprint(join(root, "apps/mobile"));
    assertNotEquals(missing.fingerprint, hoisted.fingerprint);
    assert(
      missing.inputs.some((i) =>
        "name" in i && i.name === "@capacitor/app" && i.version === "not installed (8.0.0)"
      ),
    );
    assertEquals(missing.warnings.length, 2, missing.warnings.join("\n"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("fingerprint: CRLF text is normalised; binary files are hashed as they are", async () => {
  await withProject(async (dir) => {
    const before = await fp(dir);
    for (const path of ["ios/App/App/Info.plist", "android/app/build.gradle"]) {
      const text = await Deno.readTextFile(join(dir, path));
      await Deno.writeTextFile(join(dir, path), text.replaceAll("\n", "\r\n"));
    }
    await Deno.writeTextFile(
      join(dir, "capacitor.config.ts"),
      CONFIG_TS.replaceAll("\n", "\r\n"),
    );
    assertEquals(await fp(dir), before);
    // A binary file (it holds a NUL) keeps its CRLF bytes: changing them changes the hash.
    await Deno.writeFile(
      join(dir, "ios/App/App/icon.png"),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x00, 0x1a]),
    );
    assertNotEquals(await fp(dir), before);
  });
});

Deno.test("fingerprint: the config's server block (what `mobile dev` edits) is left out", async () => {
  await withProject(async (dir) => {
    const before = await fp(dir);
    const file = join(dir, "capacitor.config.ts");
    await Deno.writeTextFile(
      file,
      await withDevServerUrl(file, CONFIG_TS, "http://192.168.1.5:3000"),
    );
    assertEquals(await fp(dir), before);
    // Any other config key counts.
    await Deno.writeTextFile(file, CONFIG_TS.replace(`appName: "Example"`, `appName: "Other"`));
    assertNotEquals(await fp(dir), before);
  });
  // JSON: formatting and key order never matter; the server block is dropped.
  const json: Record<string, string | Uint8Array> = {
    ...baseFiles(),
    "capacitor.config.json": `{"appId":"a","webDir":"www"}`,
  };
  delete json["capacitor.config.ts"];
  await withProject(async (dir) => {
    const before = await fp(dir);
    const file = join(dir, "capacitor.config.json");
    await Deno.writeTextFile(
      file,
      `{\n    "webDir": "www",\n    "server": { "url": "http://x", "cleartext": true },\n    "appId": "a"\n}\n`,
    );
    assertEquals(await fp(dir), before);
  }, json);
});

Deno.test("fingerprint: no Capacitor project is an error", async () => {
  await withProject(async (dir) => {
    await assertRejects(() => computeNativeFingerprint(dir), Error, "capacitor.config");
  }, { "ios/App/App/Info.plist": INFO_PLIST });
});

/** Run `denext mobile <positionals>` with `flags`, returning stdout lines. */
async function mobile(
  positionals: string[],
  flags: Record<string, string | boolean>,
  json = false,
): Promise<string[]> {
  const log = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await buildRegistry().get("mobile")!.run({
      positionals,
      flags,
      global: { json, verbose: false, quiet: false },
      rest: [],
    });
  } finally {
    console.log = log;
  }
  return lines;
}

Deno.test("denext mobile fingerprint --json / --diff explain what changed", async () => {
  await withProject(async (dir) => {
    const [json] = await mobile(["fingerprint"], { dir }, true);
    const doc = JSON.parse(json);
    assertEquals(Object.keys(doc).sort(), ["fingerprint", "inputs"]);
    assertEquals(doc.fingerprint, await fp(dir));
    assertEquals((await mobile(["fingerprint", dir], {}))[0], doc.fingerprint);
    const old = join(dir, "..", `${dir.split("/").pop()}.json`);
    await Deno.writeTextFile(old, json);
    try {
      const same = await mobile(["fingerprint"], { dir, diff: old });
      assert(same[0].includes("unchanged"), same.join("\n"));
      await writeFiles(dir, {
        ...pkgFile("@capacitor/app", { version: "8.1.0" }),
        "ios/App/App/Extra.swift": "struct Extra {}\n",
        "android/app/build.gradle": "android {}\n",
      });
      await Deno.remove(join(dir, "ios/App/App/AppDelegate.swift"));
      const text = (await mobile(["fingerprint"], { dir, diff: old })).join("\n");
      assert(text.includes(`changed: ${doc.fingerprint} → `), text);
      assert(text.includes("needs a new app binary"), text);
      assert(text.includes("+ file ios/App/App/Extra.swift"), text);
      assert(text.includes("- file ios/App/App/AppDelegate.swift"), text);
      assert(text.includes("~ file android/app/build.gradle"), text);
      assert(text.includes("~ plugin @capacitor/app 8.0.1 → 8.1.0"), text);
      const [diffJson] = await mobile(["fingerprint"], { dir, diff: old }, true);
      const diff = JSON.parse(diffJson);
      assertEquals(diff.changed, true);
      assertEquals(diff.previous, doc.fingerprint);
      assertEquals(
        [diff.added.length, diff.removed.length, diff.modified.length],
        [1, 1, 2],
      );
    } finally {
      await Deno.remove(old);
    }
  });
  // The text rendering of an unchanged diff.
  const same = { fingerprint: "a".repeat(64), inputs: [] };
  assert(formatFingerprintDiff(diffNativeFingerprints(same, same)).includes("over the air"));
});

Deno.test("fingerprint --write embeds it in Info.plist and AndroidManifest, idempotently", async () => {
  await withProject(async (dir) => {
    const before = await fp(dir);
    const report = await writeNativeFingerprint(dir);
    assertEquals(report.fingerprint, before);
    assertEquals(report.written, [
      "ios/App/App/Info.plist",
      "android/app/src/main/AndroidManifest.xml",
    ]);
    const plist = await Deno.readTextFile(join(dir, "ios/App/App/Info.plist"));
    assert(
      plist.includes(`\t<key>${NATIVE_FINGERPRINT_INFO_KEY}</key>\n\t<string>${before}</string>\n`),
      plist,
    );
    const manifest = await Deno.readTextFile(join(dir, "android/app/src/main/AndroidManifest.xml"));
    assert(
      manifest.includes(
        `        <meta-data android:name="${NATIVE_FINGERPRINT_META}" android:value="${before}" />\n    </application>`,
      ),
      manifest,
    );
    // Writing never changes the fingerprint, so a second run changes nothing.
    assertEquals(await fp(dir), before);
    const again = await writeNativeFingerprint(dir);
    assertEquals(again.written, []);
    assertEquals(again.unchanged, [
      "ios/App/App/Info.plist",
      "android/app/src/main/AndroidManifest.xml",
    ]);
    assertEquals(await Deno.readTextFile(join(dir, "ios/App/App/Info.plist")), plist);
    // A native change moves the fingerprint; --write replaces the embedded one in place.
    await Deno.writeTextFile(join(dir, "android/app/build.gradle"), "android { }\n");
    const lines = await mobile(["fingerprint"], { dir, write: true });
    const next = await fp(dir);
    assertNotEquals(next, before);
    assert(lines.some((l) => l.includes(next)), lines.join("\n"));
    const replaced = await Deno.readTextFile(join(dir, "ios/App/App/Info.plist"));
    assertEquals(replaced.split(NATIVE_FINGERPRINT_INFO_KEY).length, 2);
    assert(replaced.includes(`<string>${next}</string>`));
    const replacedManifest = await Deno.readTextFile(
      join(dir, "android/app/src/main/AndroidManifest.xml"),
    );
    assertEquals(replacedManifest.split(NATIVE_FINGERPRINT_META).length, 2);
    assert(replacedManifest.includes(`android:value="${next}"`));
  });
  // A platform that is not there is skipped.
  const iosOnly = baseFiles();
  delete iosOnly["android/app/src/main/AndroidManifest.xml"];
  await withProject(async (dir) => {
    const report = await writeNativeFingerprint(dir);
    assertEquals(report.written, ["ios/App/App/Info.plist"]);
    assertEquals(report.skipped, ["android/app/src/main/AndroidManifest.xml (not found)"]);
  }, iosOnly);
});
