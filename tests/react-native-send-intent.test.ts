// React Native mode's `Linking.sendIntent(action, extras?)` (src/react-native/linking.ts) and
// expo-linking's `sendIntent` (src/expo/linking.ts): inside the Android shell, denext's
// `DenextSettings` plugin (`denext mobile add permissions`, src/build/settings-native-templates.ts)
// starts an activity for the action with React Native's `{ key, value }` extras; on iOS, the web
// and a Deno Desktop window they reject as React Native (`Error("Unsupported")`) and Expo
// (`UnavailabilityError`) do off Android. The plugin's extras code is compiled where javac exists.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { Linking } from "../src/react-native/mod.ts";
import { sendIntent as expoSendIntent } from "../src/expo/linking.ts";
import { addSettingsToProject } from "../src/build/mobile-settings-install.ts";
import {
  SETTINGS_ANDROID_FILES,
  SETTINGS_TEMPLATE_VERSION,
} from "../src/build/settings-native-templates.ts";
import { renderMarkedTemplate } from "../src/build/native-template-marker.ts";
import { fakePlugin, inShell, withGlobals } from "./helpers/mobile-fakes.ts";
import { IGNORE_WITHOUT_JDK, requireJdk } from "./_jdk.ts";

const WIFI = "android.settings.WIFI_SETTINGS";

// ---- the JS surface ------------------------------------------------------------------------

Deno.test("Linking.sendIntent (Android): the DenextSettings plugin starts the intent", async () => {
  const settings = fakePlugin(["open", "sendIntent"], { sendIntent: {} });
  await inShell("android", { DenextSettings: settings.plugin }, async () => {
    assertEquals(await Linking.sendIntent(WIFI), undefined);
    await Linking.sendIntent("android.intent.action.VIEW", [
      { key: "s", value: "text" },
      { key: "n", value: 2.5 },
      { key: "b", value: true },
    ]);
  });
  assertEquals(settings.calls, [
    ["sendIntent", { action: WIFI }],
    ["sendIntent", {
      action: "android.intent.action.VIEW",
      extras: [{ key: "s", value: "text" }, { key: "n", value: 2.5 }, { key: "b", value: true }],
    }],
  ]);
});

Deno.test("Linking.sendIntent (Android): the plugin's rejection, a missing plugin, a bad action", async () => {
  const failing = fakePlugin(["sendIntent"], {
    sendIntent: new Error("Could not launch Intent with action x."),
  });
  await inShell("android", { DenextSettings: failing.plugin }, async () => {
    await assertRejects(() => Linking.sendIntent("x"), Error, "Could not launch Intent");
    await assertRejects(() => Linking.sendIntent(""), TypeError, "invalid action");
  });
  assertEquals(failing.calls.length, 1, "an empty action never reaches the plugin");
  // generation 1 of the plugin (open only), or none at all
  const old = fakePlugin(["open"]);
  for (const plugins of [{ DenextSettings: old.plugin }, {}]) {
    await inShell("android", plugins, async () => {
      await assertRejects(() => Linking.sendIntent(WIFI), Error, "denext mobile add permissions");
    });
  }
});

Deno.test("Linking.sendIntent: rejects with React Native's Unsupported off Android", async () => {
  const settings = fakePlugin(["open", "sendIntent"]);
  await inShell("ios", { DenextSettings: settings.plugin }, async () => {
    await assertRejects(() => Linking.sendIntent(WIFI), Error, "Unsupported");
  });
  for (const globals of [{}, { __denext: { desktop: true } }]) {
    await withGlobals(globals, async () => {
      await assertRejects(() => Linking.sendIntent(WIFI), Error, "Unsupported");
    });
  }
  assertEquals(settings.calls, [], "the plugin is never called off Android");
});

Deno.test("expo-linking sendIntent: React Native's Linking on Android, UnavailabilityError elsewhere", async () => {
  const settings = fakePlugin(["sendIntent"], { sendIntent: {} });
  await inShell("android", { DenextSettings: settings.plugin }, async () => {
    await expoSendIntent(WIFI, [{ key: "k", value: 1 }]);
  });
  assertEquals(settings.calls, [["sendIntent", {
    action: WIFI,
    extras: [{ key: "k", value: 1 }],
  }]]);
  for (
    const run of [
      (fn: () => Promise<void>) => inShell("ios", {}, fn),
      (fn: () => Promise<void>) => withGlobals({}, fn),
    ]
  ) {
    await run(async () => {
      const err = await assertRejects(() => expoSendIntent(WIFI));
      assertEquals((err as { code?: string }).code, "ERR_UNAVAILABLE");
      assertStringIncludes((err as Error).message, "Linking.sendIntent");
    });
  }
});

// ---- the native half -------------------------------------------------------------------------

const ANDROID_FILE = "DenextSettingsPlugin.java";
const ANDROID_SETTINGS = `android/app/src/main/java/dev/denext/settings/${ANDROID_FILE}`;

Deno.test("DenextSettings (Android): sendIntent is a plugin method; the generation is 2", () => {
  const java = SETTINGS_ANDROID_FILES[ANDROID_FILE];
  assertStringIncludes(java, "    @PluginMethod\n    public void sendIntent(PluginCall call) {");
  // React Native's messages for an empty action and an action nothing handles.
  assertStringIncludes(java, '"Invalid Action: " + action + "."');
  assertStringIncludes(java, '"Could not launch Intent with action " + action + "."');
  assertStringIncludes(java, "catch (ActivityNotFoundException e)");
  // 3.2.0 wrote generation 1, which an older denext would otherwise rewrite without sendIntent.
  assert(SETTINGS_TEMPLATE_VERSION > 1);
});

Deno.test("DenextSettings (Android): a generation-1 plugin is upgraded to the one with sendIntent", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_send_intent_" });
  try {
    const activity = "android/app/src/main/java/com/example/app/MainActivity.java";
    await Deno.mkdir(join(dir, activity, ".."), { recursive: true });
    await Deno.writeTextFile(
      join(dir, activity),
      "package com.example.app;\n\nimport com.getcapacitor.BridgeActivity;\n\n" +
        "public class MainActivity extends BridgeActivity {}\n",
    );
    await addSettingsToProject({ dir });
    const current = await Deno.readTextFile(join(dir, ANDROID_SETTINGS));
    const body = current.slice(current.indexOf("\n") + 1);
    const start = body.indexOf("\n    @PluginMethod\n    public void sendIntent(");
    const end = body.lastIndexOf("}\n");
    assert(start > 0 && end > start);
    // Generation 1's body: the same plugin without sendIntent (its imports are harmless here).
    await Deno.writeTextFile(
      join(dir, ANDROID_SETTINGS),
      await renderMarkedTemplate("settings", 1, body.slice(0, start) + "}\n"),
    );
    const again = await addSettingsToProject({ dir });
    assertEquals(again.kept, []);
    assert(again.upgraded.includes(ANDROID_SETTINGS), again.upgraded.join());
    assertEquals(await Deno.readTextFile(join(dir, ANDROID_SETTINGS)), current);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** The plugin's `putExtras`, lifted out of the template. */
function javaPutExtras(): string {
  const java = SETTINGS_ANDROID_FILES[ANDROID_FILE];
  const start = java.indexOf("    static String putExtras(Intent intent, JSONArray extras) {");
  const end = java.lastIndexOf("}\n");
  assert(start > 0 && end > start, "no putExtras in the plugin");
  return java.slice(start, end);
}

/** Minimal org.json and android.content.Intent: enough for putExtras, recording each put. */
const STUBS: Record<string, string> = {
  "org/json/JSONObject.java": `package org.json;
public class JSONObject {
    private final java.util.Map<String, Object> map;
    public JSONObject(java.util.Map<String, Object> map) { this.map = map; }
    public Object opt(String key) { return map.get(key); }
    public String optString(String key, String fallback) {
        Object v = map.get(key);
        return v == null ? fallback : v.toString();
    }
}
`,
  "org/json/JSONArray.java": `package org.json;
public class JSONArray {
    private final java.util.List<Object> list;
    public JSONArray(java.util.List<Object> list) { this.list = list; }
    public int length() { return list.size(); }
    public JSONObject optJSONObject(int i) {
        Object v = list.get(i);
        return v instanceof JSONObject ? (JSONObject) v : null;
    }
}
`,
  "android/content/Intent.java": `package android.content;
public class Intent {
    public final java.util.List<String> puts = new java.util.ArrayList<>();
    public Intent putExtra(String k, String v) { puts.add("String " + k + "=" + v); return this; }
    public Intent putExtra(String k, boolean v) { puts.add("boolean " + k + "=" + v); return this; }
    public Intent putExtra(String k, double v) { puts.add("double " + k + "=" + v); return this; }
    public Intent putExtra(String k, int v) { puts.add("int " + k + "=" + v); return this; }
}
`,
};

Deno.test({
  name: "DenextSettings (Android): sendIntent's extras as React Native puts them (compiled)",
  ignore: IGNORE_WITHOUT_JDK,
  async fn() {
    requireJdk();
    const dir = await Deno.makeTempDir({ prefix: "denext_send_intent_java_" });
    try {
      for (const [path, text] of Object.entries(STUBS)) {
        await Deno.mkdir(join(dir, path, ".."), { recursive: true });
        await Deno.writeTextFile(join(dir, path), text);
      }
      await Deno.writeTextFile(
        join(dir, "Harness.java"),
        `import android.content.Intent;
import org.json.JSONArray;
import org.json.JSONObject;
public final class Harness {
${javaPutExtras()}
    static JSONObject extra(String key, Object value) {
        java.util.Map<String, Object> m = new java.util.HashMap<>();
        if (key != null) m.put("key", key);
        m.put("value", value);
        return new JSONObject(m);
    }
    static void run(String label, Object... extras) {
        Intent intent = new Intent();
        String error = putExtras(intent, new JSONArray(java.util.Arrays.asList(extras)));
        System.out.println(label + ": " + (error != null ? "error " + error : intent.puts));
    }
    public static void main(String[] args) {
        System.out.println("none: " + putExtras(new Intent(), null));
        run("types", extra("s", "x"), extra("b", Boolean.TRUE), extra("i", 3), extra("d", 2.5));
        run("nested", extra("o", new JSONObject(new java.util.HashMap<>())));
        run("null", extra("z", null));
        run("keyless", extra(null, "x"));
    }
}
`,
      );
      const sources = [...Object.keys(STUBS), "Harness.java"].map((p) => join(dir, p));
      const compile = await new Deno.Command("javac", {
        args: ["-d", join(dir, "classes"), ...sources],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(compile.success, new TextDecoder().decode(compile.stderr));
      const run = await new Deno.Command("java", {
        args: ["-cp", join(dir, "classes"), "Harness"],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(run.success, new TextDecoder().decode(run.stderr));
      assertEquals(new TextDecoder().decode(run.stdout).trim().split("\n"), [
        "none: null",
        // A number is a double, whether JavaScript wrote 3 or 2.5 (React Native's rule).
        "types: [String s=x, boolean b=true, double i=3.0, double d=2.5]",
        "nested: error Extra type for o not supported.",
        "null: error Extra type for z not supported.",
        "keyless: error Extra 0 has no key.",
      ]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
