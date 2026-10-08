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

/**
 * The slice of Android and Capacitor 8 the whole plugin compiles against, as plain-JDK stand-ins:
 * the activity's `startActivity` throws whatever the harness sets, as Android does for an action
 * nothing handles (`ActivityNotFoundException`) or one the app may not start (`SecurityException`,
 * e.g. `ACTION_CALL` without `CALL_PHONE`).
 */
const PLUGIN_STUBS: Record<string, string> = {
  "org/json/JSONObject.java": STUBS["org/json/JSONObject.java"],
  "org/json/JSONArray.java": STUBS["org/json/JSONArray.java"],
  "android/content/ActivityNotFoundException.java": `package android.content;
public class ActivityNotFoundException extends RuntimeException {
    public ActivityNotFoundException(String message) { super(message); }
}
`,
  "android/content/Intent.java": `package android.content;
public class Intent {
    public static final int FLAG_ACTIVITY_NEW_TASK = 0x10000000;
    public final String action;
    public Intent(String action) { this.action = action; }
    public Intent setData(android.net.Uri uri) { return this; }
    public Intent addFlags(int flags) { return this; }
    public Intent putExtra(String k, String v) { return this; }
    public Intent putExtra(String k, boolean v) { return this; }
    public Intent putExtra(String k, double v) { return this; }
}
`,
  "android/content/Context.java": `package android.content;
public class Context {
    public static RuntimeException failure;
    public final java.util.List<String> started = new java.util.ArrayList<>();
    public String getPackageName() { return "com.example.app"; }
    public void startActivity(Intent intent) {
        if (failure != null) throw failure;
        started.add(intent.action);
    }
}
`,
  "android/app/Activity.java": `package android.app;
public class Activity extends android.content.Context {}
`,
  "android/net/Uri.java": `package android.net;
public class Uri {
    public static Uri fromParts(String scheme, String part, String fragment) { return new Uri(); }
}
`,
  "android/provider/Settings.java": `package android.provider;
public final class Settings {
    public static final String ACTION_APPLICATION_DETAILS_SETTINGS = "android.settings.APPLICATION_DETAILS_SETTINGS";
}
`,
  "com/getcapacitor/JSArray.java": `package com.getcapacitor;
public class JSArray extends org.json.JSONArray {
    public JSArray() { super(new java.util.ArrayList<>()); }
}
`,
  "com/getcapacitor/Plugin.java": `package com.getcapacitor;
public class Plugin {
    public android.app.Activity activity = new android.app.Activity();
    public android.content.Context getContext() { return activity; }
    public android.app.Activity getActivity() { return activity; }
}
`,
  "com/getcapacitor/PluginCall.java": `package com.getcapacitor;
public class PluginCall {
    public final String action;
    public String outcome = "pending";
    public PluginCall(String action) { this.action = action; }
    public String getString(String key) { return "action".equals(key) ? action : null; }
    public JSArray getArray(String key, JSArray fallback) { return fallback; }
    public void resolve() { outcome = "resolved"; }
    public void reject(String message, String code) { outcome = "rejected " + code + ": " + message; }
}
`,
  "com/getcapacitor/PluginMethod.java": `package com.getcapacitor;
public @interface PluginMethod {}
`,
  "com/getcapacitor/annotation/CapacitorPlugin.java": `package com.getcapacitor.annotation;
public @interface CapacitorPlugin { String name(); }
`,
};

Deno.test({
  name:
    "DenextSettings (Android): sendIntent rejects, never throws, when Android refuses the activity (compiled)",
  ignore: IGNORE_WITHOUT_JDK,
  async fn() {
    requireJdk();
    const dir = await Deno.makeTempDir({ prefix: "denext_send_intent_plugin_" });
    try {
      for (const [path, text] of Object.entries(PLUGIN_STUBS)) {
        await Deno.mkdir(join(dir, path, ".."), { recursive: true });
        await Deno.writeTextFile(join(dir, path), text);
      }
      const plugin = join(dir, "dev/denext/settings", ANDROID_FILE);
      await Deno.mkdir(join(plugin, ".."), { recursive: true });
      await Deno.writeTextFile(plugin, SETTINGS_ANDROID_FILES[ANDROID_FILE]);
      await Deno.writeTextFile(
        join(dir, "dev/denext/settings/Harness.java"),
        `package dev.denext.settings;
import android.content.ActivityNotFoundException;
import android.content.Context;
import com.getcapacitor.PluginCall;
public final class Harness {
    static void run(String label, RuntimeException failure, boolean open) {
        Context.failure = failure;
        PluginCall call = new PluginCall("android.intent.action.CALL");
        try {
            if (open) new DenextSettingsPlugin().open(call);
            else new DenextSettingsPlugin().sendIntent(call);
            System.out.println(label + ": " + call.outcome);
        } catch (RuntimeException e) {
            // Capacitor's Bridge turns an exception escaping a plugin method into a crash.
            System.out.println(label + ": threw " + e.getClass().getSimpleName());
        }
    }
    public static void main(String[] args) {
        run("started", null, false);
        run("nothing handles it", new ActivityNotFoundException("none"), false);
        run("not permitted", new SecurityException("Permission Denial"), false);
        run("open, not permitted", new SecurityException("Permission Denial"), true);
    }
}
`,
      );
      const sources = [...Object.keys(PLUGIN_STUBS), `dev/denext/settings/${ANDROID_FILE}`]
        .map((p) => join(dir, p));
      sources.push(join(dir, "dev/denext/settings/Harness.java"));
      const compile = await new Deno.Command("javac", {
        args: ["-nowarn", "-d", join(dir, "classes"), ...sources],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(compile.success, new TextDecoder().decode(compile.stderr));
      const run = await new Deno.Command("java", {
        args: ["-cp", join(dir, "classes"), "dev.denext.settings.Harness"],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(run.success, new TextDecoder().decode(run.stderr));
      assertEquals(new TextDecoder().decode(run.stdout).trim().split("\n"), [
        "started: resolved",
        "nothing handles it: rejected unavailable: Could not launch Intent with action android.intent.action.CALL.",
        // React Native's IntentModule catches every exception and rejects with the same message.
        "not permitted: rejected failed: Could not launch Intent with action android.intent.action.CALL.",
        "open, not permitted: rejected failed: The app's settings page could not be opened.",
      ]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
