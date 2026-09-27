// `denext mobile add keyboard | back | system-bars` (src/build/mobile-capabilities.ts +
// mobile-system-ui-install.ts): the npm packages (none for system-bars, whose SystemBars
// plugin ships in @capacitor/core 8), the manifest attribute predictive back needs, the
// Info.plist key SystemBars needs, denext's DenextBack template, and the shared MainActivity
// registering DenextBack / calling EdgeToEdge.enable. No test spawns a real process.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  addMobileCapabilities,
  type CommandRunner,
  formatCapabilityPlan,
  planMobileCapabilities,
  type PlannedCommand,
} from "../src/build/mobile-capabilities.ts";
import { withManifestApplicationAttribute } from "../src/build/mobile-native-config.ts";
import { mainActivitySource } from "../src/build/mobile-native-install.ts";
import { markedTemplateIntact, renderMarkedTemplate } from "../src/build/native-template-marker.ts";
import { BACK_ANDROID_FILES, renderBackTemplate } from "../src/build/back-native-templates.ts";

const PLIST_PATH = "ios/App/App/Info.plist";
const MANIFEST_PATH = "android/app/src/main/AndroidManifest.xml";
const ACTIVITY_PATH = "android/app/src/main/java/com/example/app/MainActivity.java";
const BACK_PLUGIN_PATH = "android/app/src/main/java/dev/denext/back/DenextBackPlugin.java";

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>App</string>
	<key>UIViewControllerBasedStatusBarAppearance</key>
	<false/>
</dict>
</plist>
`;

/** Capacitor 8's manifest (trimmed): a multi-line `<application>` open tag. */
const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application
        android:allowBackup="true"
        android:label="@string/app_name"
        android:theme="@style/AppTheme">

        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`;

const STOCK_ACTIVITY = `package com.example.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {}
`;

/** A fake Capacitor 8 project in a temp dir; `files` overrides (null leaves a file out). */
async function inProject(
  files: Record<string, string | null>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext_mobile_system_ui_" });
  const all: Record<string, string | null> = {
    "capacitor.config.ts": "export default { appId: 'com.example.app', webDir: 'out' };\n",
    "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "^8.0.0" } }),
    "node_modules/@capacitor/core/package.json": JSON.stringify({ version: "8.5.2" }),
    // The web export `cap sync` copies (without it the run falls back to `cap update`).
    "out/index.html": "<!doctype html>\n",
    ".git/HEAD": "ref: refs/heads/main\n",
    [PLIST_PATH]: INFO_PLIST,
    [MANIFEST_PATH]: MANIFEST,
    [ACTIVITY_PATH]: STOCK_ACTIVITY,
    ...files,
  };
  try {
    for (const [path, content] of Object.entries(all)) {
      if (content === null) continue;
      await Deno.mkdir(join(dir, path, ".."), { recursive: true });
      await Deno.writeTextFile(join(dir, path), content);
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** A runner recording every command (all exit 0). */
function fakeRunner() {
  const calls: PlannedCommand[] = [];
  const run: CommandRunner = (command) => {
    calls.push(command);
    return Promise.resolve({ code: 0 });
  };
  return { run, calls, lines: () => calls.map((c) => [c.cmd, ...c.args].join(" ")) };
}

const read = (dir: string, path: string) => Deno.readTextFile(join(dir, path));

Deno.test("mobile add keyboard: installs @capacitor/keyboard, no native edits", async () => {
  await inProject({}, async (dir) => {
    const { run, lines } = fakeRunner();
    const report = await addMobileCapabilities({ capabilities: ["keyboard"], cwd: dir, run });
    assertEquals(lines(), ["npm install @capacitor/keyboard@^8.0.5", "npx cap sync"]);
    assertEquals(report.written, []);
    assertStringIncludes(report.plan.notes.join("\n"), "useKeyboard()");
    assertEquals(await read(dir, MANIFEST_PATH), MANIFEST);
  });
});

Deno.test("mobile add back: @capacitor/app, the manifest attribute, DenextBack + MainActivity", async () => {
  await inProject({}, async (dir) => {
    const { run, lines } = fakeRunner();
    const report = await addMobileCapabilities({ capabilities: ["back"], cwd: dir, run });
    assertEquals(lines(), ["npm install @capacitor/app@^8.1.1", "npx cap sync"]);
    assertEquals(report.written.sort(), [ACTIVITY_PATH, BACK_PLUGIN_PATH, MANIFEST_PATH].sort());

    const manifest = await read(dir, MANIFEST_PATH);
    assertStringIncludes(
      manifest,
      '    <application\n        android:enableOnBackInvokedCallback="true"\n        android:allowBackup="true"',
    );
    const plugin = await read(dir, BACK_PLUGIN_PATH);
    assert(plugin.startsWith("// denext-back-template: 1 sha256="));
    assertEquals(await markedTemplateIntact("back", plugin), true);
    assertEquals(plugin, await renderBackTemplate(BACK_ANDROID_FILES["DenextBackPlugin.java"]));
    assertStringIncludes(plugin, '@CapacitorPlugin(name = "DenextBack")');
    assertEquals(
      await read(dir, ACTIVITY_PATH),
      await mainActivitySource("com.example.app", new Set(["back"])),
    );

    // Again: nothing changes.
    const again = await addMobileCapabilities({ capabilities: ["back"], cwd: dir, run });
    assertEquals(again.written, []);
    assertEquals(again.manual, []);
    assertEquals(await read(dir, MANIFEST_PATH), manifest);
  });
});

Deno.test("mobile add back: an edited DenextBackPlugin and an app's own attribute are kept", async () => {
  const edited = `${await renderBackTemplate(
    BACK_ANDROID_FILES["DenextBackPlugin.java"],
  )}// mine\n`;
  const optedOut = MANIFEST.replace(
    "<application\n",
    '<application android:enableOnBackInvokedCallback="false"\n',
  );
  await inProject({ [BACK_PLUGIN_PATH]: edited, [MANIFEST_PATH]: optedOut }, async (dir) => {
    const { run } = fakeRunner();
    const report = await addMobileCapabilities({ capabilities: ["back"], cwd: dir, run });
    assertEquals(await read(dir, BACK_PLUGIN_PATH), edited);
    assertStringIncludes(report.manual.join("\n"), "DenextBackPlugin.java differs from denext's");
    assertEquals(await read(dir, MANIFEST_PATH), optedOut, "the app's own value wins");
  });
  // A newer denext's template is never downgraded.
  const newer = await renderMarkedTemplate("back", 99, "// from the future\n");
  await inProject({ [BACK_PLUGIN_PATH]: newer }, async (dir) => {
    const { run } = fakeRunner();
    const report = await addMobileCapabilities({ capabilities: ["back"], cwd: dir, run });
    assertEquals(await read(dir, BACK_PLUGIN_PATH), newer);
    assertStringIncludes(report.manual.join("\n"), "written by a newer denext");
  });
});

Deno.test("mobile add system-bars: no package; Info.plist key and EdgeToEdge in MainActivity", async () => {
  await inProject({}, async (dir) => {
    const plan = await planMobileCapabilities({ capabilities: ["system-bars"], cwd: dir });
    assertEquals([plan.install, plan.sync], [undefined, undefined], "SystemBars is in core");
    const printed = formatCapabilityPlan(plan);
    assertStringIncludes(printed, "(no npm package)");
    assertStringIncludes(printed, "Info.plist     UIViewControllerBasedStatusBarAppearance: true");
    assertStringIncludes(printed, "native         EdgeToEdge.enable(this) in MainActivity");

    const { run, calls } = fakeRunner();
    const report = await addMobileCapabilities({ capabilities: ["system-bars"], cwd: dir, run });
    assertEquals(calls, []);
    assertEquals(report.written.sort(), [ACTIVITY_PATH, PLIST_PATH].sort());
    const plist = await read(dir, PLIST_PATH);
    assertStringIncludes(plist, "<key>UIViewControllerBasedStatusBarAppearance</key>\n\t<true/>");
    const activity = await read(dir, ACTIVITY_PATH);
    assertEquals(activity, await mainActivitySource("com.example.app", new Set(["edge-to-edge"])));
    assertStringIncludes(activity, "EdgeToEdge.enable(this);\n        super.onCreate(");
  });
});

Deno.test("mobile add back system-bars: one MainActivity composing both; no android/ skipped", async () => {
  await inProject({}, async (dir) => {
    const { run } = fakeRunner();
    await addMobileCapabilities({ capabilities: ["back", "system-bars"], cwd: dir, run });
    assertEquals(
      await read(dir, ACTIVITY_PATH),
      await mainActivitySource("com.example.app", new Set(["back", "edge-to-edge"])),
    );
  });
  await inProject({ [MANIFEST_PATH]: null, [ACTIVITY_PATH]: null }, async (dir) => {
    const { run } = fakeRunner();
    const report = await addMobileCapabilities({ capabilities: ["back"], cwd: dir, run });
    assertStringIncludes(report.skipped.join("\n"), "Android: no android/app/src/main");
  });
});

Deno.test("native config: withManifestApplicationAttribute", () => {
  const attr = "android:enableOnBackInvokedCallback";
  assertEquals(
    withManifestApplicationAttribute(
      "<manifest><application></application></manifest>",
      attr,
      "true",
    ),
    `<manifest><application ${attr}="true"></application></manifest>`,
  );
  assertEquals(
    withManifestApplicationAttribute(
      '<manifest><application android:label="a > b"/></manifest>',
      attr,
      "true",
    ),
    `<manifest><application ${attr}="true" android:label="a > b"/></manifest>`,
  );
  const present = `<manifest><application ${attr}="false"></application></manifest>`;
  assertEquals(withManifestApplicationAttribute(present, attr, "true"), present);
  assertEquals(withManifestApplicationAttribute("<manifest/>", attr, "true"), null);
  // Only <application>'s own attributes count, not an activity's.
  const onActivity = `<manifest><application>\n<activity ${attr}="true"/></application></manifest>`;
  assertStringIncludes(
    withManifestApplicationAttribute(onActivity, attr, "true")!,
    `<application ${attr}="true">`,
  );
});
