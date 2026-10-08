// The packages the React Native gap audit found breaking at import (expo-tracking-transparency,
// expo-maps, @expo/ui's SwiftUI / Jetpack Compose entry points) plus the new
// expo-application and expo-auth-session provider shims and the Expo SDK coverage round's: React Native mode's resolver sends
// each to its denext/expo shim, and a bundle of an app importing every one of their exports
// builds and evaluates without throwing. The shims are bundled from source in place of the
// prebuilt runtime.

import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import * as esbuild from "esbuild";
import { reactNativeBundleOptions } from "../src/build/react-native.ts";
import { expoShimName } from "../src/build/expo-shims.ts";
import { EXPO_SHIMS } from "../src/expo/manifest.ts";

/** The packages the gap work added, with names each must export. */
const NEW_SHIMS: Record<string, string[]> = {
  "expo-tracking-transparency": ["requestTrackingPermissionsAsync", "useTrackingPermissions"],
  "expo-maps": ["AppleMaps", "GoogleMaps", "useLocationPermissions"],
  "@expo/ui/swift-ui": ["Host", "VStack", "Text", "Button", "Chart"],
  "@expo/ui/swift-ui/modifiers": ["padding", "frame", "Animation"],
  "@expo/ui/jetpack-compose": ["Host", "Column", "Text", "Button", "Card"],
  "@expo/ui/jetpack-compose/modifiers": ["paddingAll", "fillMaxWidth", "Shapes"],
  "expo-application": ["applicationId", "nativeApplicationVersion", "getAndroidId"],
  "expo-auth-session/providers/google": ["useAuthRequest", "useIdTokenAuthRequest", "discovery"],
  "expo-auth-session/providers/facebook": ["useAuthRequest", "discovery"],
  // The Expo SDK coverage round: web-backed shims.
  "expo-system-ui": ["setBackgroundColorAsync", "getBackgroundColorAsync"],
  "expo-linear-gradient": ["LinearGradient"],
  "expo-localization": ["getLocales", "getCalendars", "useLocales", "CalendarIdentifier"],
  "expo-sensors": ["Accelerometer", "DeviceMotion", "Pedometer", "DeviceSensor"],
  "expo-speech": ["speak", "stop", "getAvailableVoicesAsync", "VoiceQuality"],
  "expo-battery": ["getBatteryLevelAsync", "useBatteryLevel", "BatteryState"],
  "expo-video-thumbnails": ["getThumbnailAsync"],
  "expo-gl": ["GLView", "getWorkletContext", "GLLoggingOption"],
  "expo-mail-composer": ["composeAsync", "MailComposerStatus"],
  "expo-checkbox": ["Checkbox", "default"],
  "expo-sms": ["sendSMSAsync", "isAvailableAsync"],
  "expo-mesh-gradient": ["MeshGradientView"],
  "expo-cellular": ["getCellularGenerationAsync", "CellularGeneration"],
};

const EXPO_DIR = new URL("../src/expo/", import.meta.url);

/** `denext/expo/<name>` → the shim's source file, as the prebuilt runtime would serve it. */
function shimSources(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, shim] of Object.entries(EXPO_SHIMS)) {
    map.set(`denext/expo/${expoShimName(key)}`, fromFileUrl(new URL(shim.module, EXPO_DIR)));
  }
  return map;
}

Deno.test("React Native mode: the gap shims resolve, build, and load without throwing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_expo_gap_" });
  try {
    const lines: string[] = [];
    const checks: string[] = [];
    Object.entries(NEW_SHIMS).forEach(([pkg, names], i) => {
      assert(Object.hasOwn(EXPO_SHIMS, pkg), `${pkg} is in the manifest`);
      lines.push(`import * as m${i} from ${JSON.stringify(pkg)};`);
      checks.push(`${JSON.stringify(pkg)}: ${JSON.stringify(names)}.filter((n) => !(n in m${i}))`);
    });
    // A real (unshimmed) package's module that throws at import must never be reached.
    const files: Record<string, string> = {
      "node_modules/react-native-web/package.json": JSON.stringify({
        name: "react-native-web",
        module: "i.js",
      }),
      "node_modules/react-native-web/i.js": "export const View = undefined;\n",
      "entry.js": `${lines.join("\n")}\nexport const missing = { ${checks.join(", ")} };\n`,
    };
    for (const pkg of Object.keys(NEW_SHIMS)) {
      const root = pkg.startsWith("@") ? pkg.split("/").slice(0, 2).join("/") : pkg.split("/")[0];
      files[`node_modules/${root}/package.json`] = JSON.stringify({ name: root, main: "i.js" });
      files[`node_modules/${root}/i.js`] = `throw new Error("the real ${root} was bundled");\n`;
    }
    for (const [rel, text] of Object.entries(files)) {
      await Deno.mkdir(dirname(join(dir, rel)), { recursive: true });
      await Deno.writeTextFile(join(dir, rel), text);
    }
    const options = reactNativeBundleOptions({ reactNative: true }, dir, false)!;
    const sources = shimSources();
    const fromSource: esbuild.Plugin = {
      name: "denext-expo-from-source",
      setup(build) {
        build.onResolve({ filter: /^denext\/expo\// }, (args) => {
          const path = sources.get(args.path);
          return path ? { path } : { errors: [{ text: `no shim for ${args.path}` }] };
        });
      },
    };
    const result = await esbuild.build({
      entryPoints: [join(dir, "entry.js")],
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      absWorkingDir: dir,
      plugins: [...options.plugins, fromSource],
    });
    const code = new TextDecoder().decode(result.outputFiles![0].contents);
    assert(!code.includes("was bundled"), "every package went to its shim");
    const url = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(code)))}`;
    const { missing } = await import(url);
    for (const [pkg, names] of Object.entries(missing as Record<string, string[]>)) {
      assertEquals(names, [], `${pkg} exports them`);
    }
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
