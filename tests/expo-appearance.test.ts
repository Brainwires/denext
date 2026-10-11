// An Expo app's launch and background colours in its Capacitor shell, so no white frame shows
// before the app's first one: the app config read statically (`userInterfaceStyle`,
// `backgroundColor`, `splash`, the `expo-splash-screen` plugin and its `dark` colours), what
// `denext migrate --from expo` writes (capacitor.config.ts, the page's own background) and what
// `denext mobile add app-config` writes into Capacitor 8's real template files (Info.plist, the
// launch storyboard and its colour set, the placeholder splash, SceneDelegate.swift, Android's
// colour resources and themes).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { migrateProject } from "../src/build/migrate.ts";
import { readExpoAppConfig } from "../src/build/expo-app-config.ts";
import {
  capacitorAppearanceConfig,
  colorSetJson,
  pageBackgroundStyle,
  resolveAppearance,
  withLaunchStoryboardColor,
  withSceneBackground,
  withStyleItem,
} from "../src/build/expo-appearance.ts";
import { addExpoAppConfigToProject } from "../src/build/mobile-expo-app-config.ts";
import { capacitorPlaceholders } from "../src/build/mobile-icon-source.ts";
import { spaShellHtml } from "../src/build/spa/shared.ts";

const fixture = (rel: string) => new URL(`./fixtures/capacitor8/${rel}`, import.meta.url);
const STORYBOARD = await Deno.readTextFile(fixture("template/LaunchScreen.storyboard"));
const SCENE_DELEGATE = await Deno.readTextFile(fixture("template/SceneDelegate.swift"));
const STYLES = await Deno.readTextFile(fixture("template/styles.xml"));
const SPLASH_CONTENTS = await Deno.readTextFile(fixture("template/Splash.imageset.Contents.json"));
const PLACEHOLDER_SPLASH = await Deno.readFile(fixture("placeholder/splash-2732x2732.png"));

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>App</string>
</dict>
</plist>
`;

/** Write `files` (relative path → contents; plain objects are JSON) under a temp dir. */
async function withApp(
  files: Record<string, unknown>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_expo_appearance_" }));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const path = join(dir, rel);
      await Deno.mkdir(dirname(path), { recursive: true });
      if (body instanceof Uint8Array) await Deno.writeFile(path, body);
      else {
        await Deno.writeTextFile(path, typeof body === "string" ? body : JSON.stringify(body));
      }
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** T3 Code's shape: automatic appearance, the splash plugin with a white and a dark colour. */
const AUTOMATIC = {
  expo: {
    name: "Dusk",
    userInterfaceStyle: "automatic",
    ios: { bundleIdentifier: "dev.dusk.app" },
    plugins: [
      ["expo-splash-screen", {
        image: "./assets/splash.png",
        backgroundColor: "#FFFFFF",
        dark: { image: "./assets/splash.png", backgroundColor: "#0a0a0a" },
      }],
    ],
  },
};

/** The native projects `npx cap add` writes (the files this carries into). */
const SHELL: Record<string, unknown> = {
  "ios/App/App/Info.plist": INFO_PLIST,
  "ios/App/App/Base.lproj/LaunchScreen.storyboard": STORYBOARD,
  "ios/App/App/SceneDelegate.swift": SCENE_DELEGATE,
  "ios/App/App/Assets.xcassets/Splash.imageset/Contents.json": SPLASH_CONTENTS,
  "ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png": PLACEHOLDER_SPLASH,
  "ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-1.png": PLACEHOLDER_SPLASH,
  "ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-2.png": PLACEHOLDER_SPLASH,
  "android/app/src/main/res/values/styles.xml": STYLES,
};

Deno.test("readExpoAppConfig: the appearance per platform — plugin, its dark and platform options", async () => {
  await withApp({ "app.json": AUTOMATIC }, async (dir) => {
    const { appearance } = await readExpoAppConfig(dir);
    const both = {
      style: "automatic" as const,
      splash: "#ffffff",
      splashDark: "#0a0a0a",
    };
    assertEquals(appearance, { ios: both, android: both });
  });
  await withApp({
    "app.json": {
      expo: {
        userInterfaceStyle: "light",
        backgroundColor: "#123",
        splash: { backgroundColor: "#eeeeee", dark: { backgroundColor: "#111111" } },
        ios: { userInterfaceStyle: "dark", backgroundColor: "not a colour" },
        android: { backgroundColor: "#00ff00", splash: { backgroundColor: "#abcdef" } },
        plugins: [["expo-splash-screen", { ios: { backgroundColor: "#222222" } }]],
      },
    },
  }, async (dir) => {
    const { appearance } = await readExpoAppConfig(dir);
    assertEquals(appearance.ios, {
      style: "dark",
      background: "#112233",
      splash: "#222222",
      splashDark: "#111111",
    });
    assertEquals(appearance.android, {
      style: "light",
      background: "#00ff00",
      splash: "#abcdef",
      splashDark: "#111111",
    });
  });
});

Deno.test("resolveAppearance: root view from backgroundColor, else the splash; a fixed style keeps one", () => {
  const splashOnly = { splash: "#ffffff", splashDark: "#0a0a0a" };
  assertEquals(resolveAppearance(splashOnly), {
    app: { light: "#ffffff", dark: "#0a0a0a" },
    launch: { light: "#ffffff", dark: "#0a0a0a" },
  });
  assertEquals(resolveAppearance({ ...splashOnly, style: "automatic", background: "#202020" }), {
    app: { light: "#202020" },
    launch: { light: "#ffffff", dark: "#0a0a0a" },
  });
  assertEquals(resolveAppearance({ ...splashOnly, style: "dark" }), {
    style: "dark",
    app: { light: "#0a0a0a" },
    launch: { light: "#0a0a0a" },
  });
  assertEquals(resolveAppearance({ ...splashOnly, style: "light" }), {
    style: "light",
    app: { light: "#ffffff" },
    launch: { light: "#ffffff" },
  });
  assertEquals(resolveAppearance({ splash: "#fff000", splashDark: "#fff000" }).launch, {
    light: "#fff000",
  });
  assertEquals(resolveAppearance({ style: "dark" }), { style: "dark" });
  assertEquals(resolveAppearance({}), {});
});

Deno.test("capacitorAppearanceConfig: one WebView colour only when it does not change; the splash held", () => {
  const dynamic = resolveAppearance({ splash: "#ffffff", splashDark: "#0a0a0a" });
  assertEquals(capacitorAppearanceConfig(dynamic, dynamic), {
    plugins: { SplashScreen: { launchAutoHide: false } },
  });
  const fixed = resolveAppearance({ style: "dark", splash: "#ffffff", splashDark: "#0a0a0a" });
  assertEquals(capacitorAppearanceConfig(fixed, fixed), {
    backgroundColor: "#0a0a0a",
    plugins: { SplashScreen: { launchAutoHide: false, backgroundColor: "#0a0a0a" } },
  });
  assertEquals(
    capacitorAppearanceConfig(
      resolveAppearance({ background: "#111111" }),
      resolveAppearance({ background: "#222222" }),
    ),
    {
      ios: { backgroundColor: "#111111" },
      android: { backgroundColor: "#222222" },
      plugins: { SplashScreen: { launchAutoHide: false, backgroundColor: "#111111" } },
    },
  );
  assertEquals(capacitorAppearanceConfig({}, {}), {});
});

Deno.test("pageBackgroundStyle: the page's background before the first frame, dark-aware", async () => {
  assertEquals(pageBackgroundStyle(undefined), "");
  assertEquals(
    pageBackgroundStyle({ light: "#ffffff" }),
    "<style>html{background-color:#ffffff}</style>",
  );
  const style = pageBackgroundStyle({ light: "#ffffff", dark: "#0a0a0a" });
  assertEquals(
    style,
    "<style>html{background-color:#ffffff}" +
      "@media (prefers-color-scheme: dark){html{background-color:#0a0a0a}}</style>",
  );
  // In the shell's <head>, ahead of the body and every script.
  const html = await spaShellHtml({
    spa: { entry: "./index.ts", head: style },
    scriptSrc: "/_denext/client/index.js",
    reactNativeRootStyle: true,
  });
  assert(html.indexOf(style) > 0 && html.indexOf(style) < html.indexOf("<body>"));
});

Deno.test("migrate --from expo: the colours reach capacitor.config.ts and the page's background", async () => {
  const app = {
    "package.json": {
      name: "dusk",
      dependencies: { expo: "~57.0.18", react: "19.2.3", "react-native": "0.86.3" },
    },
    "App.tsx": "export default function App() { return null; }\n",
  };
  await withApp({ ...app, "app.json": AUTOMATIC }, async (dir) => {
    const r = await migrateProject(dir, { denextLocalPath: Deno.cwd() });
    const capacitor = await Deno.readTextFile(join(dir, "capacitor.config.ts"));
    assertStringIncludes(
      capacitor,
      `  webDir: "out",
  // The app config's launch and background colours (the native splash is held until the app's first frame).
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
    },
  },
};`,
    );
    assert(!capacitor.includes("backgroundColor"), "light and dark: the shell paints it");
    const config = await Deno.readTextFile(join(dir, "denext.config.ts"));
    assertStringIncludes(
      config,
      JSON.stringify(
        "<style>html{background-color:#ffffff}" +
          "@media (prefers-color-scheme: dark){html{background-color:#0a0a0a}}</style>",
      ).slice(1, -1),
    );
    assertStringIncludes(r.expo!.mobile.command ?? "", "app-config");
    const carried = r.expo!.mobile.capabilities.find((c) => c.capability === "app-config");
    assertStringIncludes(carried?.because ?? "", "launch and background colours");
  });
  await withApp({
    ...app,
    "app.json": { expo: { userInterfaceStyle: "dark", backgroundColor: "#101010" } },
  }, async (dir) => {
    await migrateProject(dir, { denextLocalPath: Deno.cwd() });
    const capacitor = await Deno.readTextFile(join(dir, "capacitor.config.ts"));
    assertStringIncludes(capacitor, `  backgroundColor: "#101010",\n`);
    assertStringIncludes(capacitor, `backgroundColor: "#101010",\n    },\n  },\n};`);
    const config = await Deno.readTextFile(join(dir, "denext.config.ts"));
    assertStringIncludes(config, "<style>html{background-color:#101010}</style>");
    assert(!config.includes("prefers-color-scheme"), "a fixed appearance needs no query");
  });
  await withApp({ ...app, "app.json": { expo: { name: "Plain" } } }, async (dir) => {
    await migrateProject(dir, { denextLocalPath: Deno.cwd() });
    const capacitor = await Deno.readTextFile(join(dir, "capacitor.config.ts"));
    assert(!capacitor.includes("SplashScreen"), "no colours: the config is as before");
    assert(!(await Deno.readTextFile(join(dir, "denext.config.ts"))).includes("<style>"));
  });
});

Deno.test("mobile add app-config: launch screen, placeholder splash, window and Android themes", async () => {
  await withApp({ "app.json": AUTOMATIC, ...SHELL }, async (dir) => {
    const read = (rel: string) => Deno.readTextFile(join(dir, rel));
    const first = await addExpoAppConfigToProject({ dir });
    assertEquals(first.manual, []);
    assertEquals(first.written.sort(), [
      "android/app/src/main/res/values-night/denext_background.xml",
      "android/app/src/main/res/values/denext_background.xml",
      "android/app/src/main/res/values/styles.xml",
      "ios/App/App/Assets.xcassets/DenextLaunchBackground.colorset/Contents.json",
      "ios/App/App/Assets.xcassets/Splash.imageset/Contents.json",
      "ios/App/App/Assets.xcassets/Splash.imageset/denext-launch-dark.png",
      "ios/App/App/Assets.xcassets/Splash.imageset/denext-launch.png",
      "ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-1.png (removed: Capacitor's placeholder)",
      "ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-2.png (removed: Capacitor's placeholder)",
      "ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png (removed: Capacitor's placeholder)",
      "ios/App/App/Base.lproj/LaunchScreen.storyboard",
      "ios/App/App/SceneDelegate.swift",
    ]);
    assertEquals(first.unchanged, [], "automatic: Info.plist gets no fixed style");
    assert(!(await read("ios/App/App/Info.plist")).includes("UIUserInterfaceStyle"));

    const storyboard = await read("ios/App/App/Base.lproj/LaunchScreen.storyboard");
    assertStringIncludes(
      storyboard,
      '<color key="backgroundColor" name="DenextLaunchBackground"/>',
    );
    assertStringIncludes(storyboard, '<namedColor name="DenextLaunchBackground">');
    assert(!storyboard.includes('key="backgroundColor" systemColor'));
    const colorSet = JSON.parse(
      await read("ios/App/App/Assets.xcassets/DenextLaunchBackground.colorset/Contents.json"),
    );
    assertEquals(colorSet.colors.length, 2);
    assertEquals(colorSet.colors[1].appearances, [{ appearance: "luminosity", value: "dark" }]);
    assertEquals(colorSet.colors[1].color.components, {
      alpha: "1.000",
      blue: "0x0A",
      green: "0x0A",
      red: "0x0A",
    });
    const splash = JSON.parse(
      await read("ios/App/App/Assets.xcassets/Splash.imageset/Contents.json"),
    );
    assertEquals(splash.images.map((i: { filename: string }) => i.filename), [
      "denext-launch.png",
      "denext-launch-dark.png",
    ]);
    // Still a placeholder to `denext mobile build`, which puts the logo splash in its place.
    assertEquals(await capacitorPlaceholders(dir, "ios", "splash"), [
      "ios/App/App/Assets.xcassets/Splash.imageset/Contents.json",
    ]);

    const scene = await read("ios/App/App/SceneDelegate.swift");
    assertStringIncludes(
      scene,
      `        window?.makeKeyAndVisible()
        // denext:app-background begin (from the app config; \`denext mobile add app-config\`)
        let denextBackground = UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 10 / 255, green: 10 / 255, blue: 10 / 255, alpha: 1)
                : UIColor(red: 255 / 255, green: 255 / 255, blue: 255 / 255, alpha: 1)
        }
        window?.backgroundColor = denextBackground
        if let webView = (window?.rootViewController as? CAPBridgeViewController)?.webView {
            webView.isOpaque = false
            webView.backgroundColor = denextBackground
            webView.scrollView.backgroundColor = denextBackground
        }
        // denext:app-background end

        SceneDelegateProxy.shared.scene(`,
    );

    assertEquals(
      await read("android/app/src/main/res/values-night/denext_background.xml"),
      `<?xml version="1.0" encoding="utf-8"?>
<!-- Written by \`denext mobile add app-config\` from the app config's colours. -->
<resources>
    <color name="denext_launch_background">#0A0A0A</color>
    <color name="denext_app_background">#0A0A0A</color>
</resources>
`,
    );
    const styles = await read("android/app/src/main/res/values/styles.xml");
    assertStringIncludes(
      styles,
      `        <item name="android:background">@null</item>
        <item name="android:windowBackground">@color/denext_app_background</item>
    </style>`,
    );
    assertStringIncludes(
      styles,
      `        <item name="android:background">@drawable/splash</item>
        <item name="windowSplashScreenBackground">@color/denext_launch_background</item>
    </style>`,
    );

    const again = await addExpoAppConfigToProject({ dir });
    assertEquals(again.written, [], "a second run changes nothing");
    assertEquals(again.manual, []);
  });
});

Deno.test("mobile add app-config: a fixed appearance, a changed colour, an edited launch screen", async () => {
  await withApp({
    "app.json": { expo: { userInterfaceStyle: "dark", backgroundColor: "#101010" } },
    ...SHELL,
  }, async (dir) => {
    await addExpoAppConfigToProject({ dir });
    const plist = await Deno.readTextFile(join(dir, "ios/App/App/Info.plist"));
    assertStringIncludes(plist, "<key>UIUserInterfaceStyle</key>\n\t<string>Dark</string>");
    const colorSet = JSON.parse(
      await Deno.readTextFile(
        join(dir, "ios/App/App/Assets.xcassets/DenextLaunchBackground.colorset/Contents.json"),
      ),
    );
    assertEquals(colorSet.colors.length, 1, "one appearance");
    // A new colour replaces the SceneDelegate block instead of adding a second one.
    await Deno.writeTextFile(
      join(dir, "app.json"),
      JSON.stringify({ expo: { userInterfaceStyle: "dark", backgroundColor: "#202020" } }),
    );
    const report = await addExpoAppConfigToProject({ dir });
    const scene = await Deno.readTextFile(join(dir, "ios/App/App/SceneDelegate.swift"));
    assertEquals(scene.match(/denext:app-background begin/g)?.length, 1);
    assertStringIncludes(scene, "UIColor(red: 32 / 255, green: 32 / 255, blue: 32 / 255");
    assert(report.written.includes("ios/App/App/SceneDelegate.swift"));
    assertStringIncludes(report.manual.join("\n"), "MODE_NIGHT_YES");
  });
  // The app's own launch screen and SceneDelegate are left alone, with what to set by hand.
  await withApp({
    "app.json": AUTOMATIC,
    ...SHELL,
    "ios/App/App/Base.lproj/LaunchScreen.storyboard": STORYBOARD.replace(
      'systemColor="systemBackgroundColor"/>\n                    </imageView>',
      'red="1" green="0" blue="0" alpha="1"/>\n                    </imageView>',
    ),
    "ios/App/App/SceneDelegate.swift": "class SceneDelegate {}\n",
  }, async (dir) => {
    const report = await addExpoAppConfigToProject({ dir });
    const manual = report.manual.join("\n");
    assertStringIncludes(manual, "LaunchScreen.storyboard: set the launch view's background");
    assertStringIncludes(manual, "SceneDelegate.swift: set the window and WebView background");
  });
});

Deno.test("expo-appearance writers: unchanged when done, null where they cannot place an edit", () => {
  const c = { light: "#ffffff", dark: "#000000" };
  const once = withLaunchStoryboardColor(STORYBOARD, c)!;
  assertEquals(withLaunchStoryboardColor(once, c), once);
  assertEquals(withLaunchStoryboardColor("<document/>", c), null);
  assertEquals(withSceneBackground("class SceneDelegate {}", c), null);
  assertEquals(withStyleItem(STYLES, "Missing.Style", "x", "y"), null);
  const styled = withStyleItem(STYLES, "AppTheme", "android:windowBackground", "@null")!;
  assertEquals(withStyleItem(styled, "AppTheme", "android:windowBackground", "@color/x"), styled);
  assertEquals(
    withStyleItem('<style name="A"><item name="b">c</item></style>', "A", "x", "y"),
    null,
    "a one-line style is not reflowed",
  );
  assertEquals(
    JSON.parse(colorSetJson({ light: "#ff8000" })).colors[0].color.components.red,
    "0xFF",
  );
});
