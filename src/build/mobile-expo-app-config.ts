// `denext mobile add app-config`: carry an Expo app's native config into its Capacitor shell —
// what Expo's prebuild would have written from `app.json` / `app.config.*`:
//
//   - `ios.infoPlist` usage strings, and the ones config plugins set from their options
//     (`["expo-camera", { cameraPermission: "…" }]`), into ios/App/App/Info.plist — each only
//     when the key is absent (an edited Info.plist keeps its text);
//   - `android.permissions` into AndroidManifest.xml;
//   - `expo-build-properties`: `ios.deploymentTarget` into the Xcode project's
//     IPHONEOS_DEPLOYMENT_TARGET, `android.minSdkVersion` / `compileSdkVersion` /
//     `targetSdkVersion` into android/variables.gradle (each only ever raised), and
//     `android.usesCleartextTraffic` onto `<application>`;
//   - the launch and root-view colours (`userInterfaceStyle`, `backgroundColor`, `splash`, the
//     `expo-splash-screen` plugin with its `dark` colours; ./expo-appearance.ts), so no white
//     frame shows before the app's first one: a fixed `UIUserInterfaceStyle` in Info.plist,
//     the launch storyboard painted with a light / dark asset-catalog colour (and Capacitor's
//     white placeholder splash image replaced by that colour), the window and WebView painted
//     from SceneDelegate.swift (a dynamic `UIColor`), and on Android the colours as resources
//     (`values-night/` for dark) behind the launch theme's `windowSplashScreenBackground` and
//     the app theme's `android:windowBackground`.
//
// The app config is read statically (`readExpoAppConfig`: project code never runs). What it
// cannot carry is reported: computed values, build properties without a Capacitor
// counterpart. The config may come from someone else's repository, so nothing in it reaches a
// native file as markup or build settings: values are XML-escaped, and the plist keys, Android
// permissions and the deployment target are validated first. One that fails is a `manual` item
// with the reason, never written (the shared writers refuse it too). `denext migrate --from expo` suggests this capability when there is something
// to carry.

import type { NativeInstallOptions, NativeInstallReport } from "./mobile-native-install.ts";
import { type ExpoAppConfig, readExpoAppConfig } from "./expo-app-config.ts";
import {
  ANDROID_APP_COLOR,
  ANDROID_LAUNCH_COLOR,
  androidColorsXml,
  type AppearanceColors,
  colorSetJson,
  LAUNCH_COLOR_NAME,
  LAUNCH_SPLASH_FILE,
  resolveAppearance,
  type ResolvedAppearance,
  withLaunchStoryboardColor,
  withSceneBackground,
  withStyleItem,
} from "./expo-appearance.ts";
import { capacitorPlaceholders } from "./mobile-icon-source.ts";
import { encodePng, parseHexColor, solid } from "./png-raster.ts";
import {
  isAndroidName,
  isPlistKey,
  withManifestApplicationAttribute,
  withManifestPermission,
  withPlistDefault,
} from "./mobile-native-config.ts";
import { loadNativeDirs, nativeJoin } from "./capacitor-native-dirs.ts";
import { dirname } from "@std/path";
import { assertInsideProject } from "./project-confine.ts";

const INFO_PLIST = "ios/App/App/Info.plist";
const ANDROID_MANIFEST = "android/app/src/main/AndroidManifest.xml";
const VARIABLES_GRADLE = "android/variables.gradle";
const PBXPROJ = "ios/App/App.xcodeproj/project.pbxproj";
const LAUNCH_STORYBOARD = "ios/App/App/Base.lproj/LaunchScreen.storyboard";
const SCENE_DELEGATE = "ios/App/App/SceneDelegate.swift";
const ASSET_CATALOG = "ios/App/App/Assets.xcassets";
const ANDROID_RES = "android/app/src/main/res";

/** Android permissions every Capacitor app declares already. */
const IMPLIED_PERMISSIONS = new Set(["android.permission.INTERNET"]);

/**
 * `android/variables.gradle` with `key` (`minSdkVersion`, …) raised to at least `min`.
 * Unchanged when it is already that or higher; null when it declares no numeric `key`.
 *
 * @param gradle The file.
 * @param key The SDK setting.
 * @param min The lowest value it may have.
 */
export function withGradleSdkAtLeast(gradle: string, key: string, min: number): string | null {
  if (!/^\w+$/.test(key) || !Number.isSafeInteger(min)) return null;
  const m = new RegExp(`(\\b${key}\\s*=\\s*)(\\d+)`).exec(gradle);
  if (!m) return null;
  if (Number(m[2]) >= min) return gradle;
  return gradle.slice(0, m.index) + m[1] + String(min) + gradle.slice(m.index + m[0].length);
}

/** A deployment target as Xcode writes one: `16`, `16.4`, `16.4.1`. */
const DEPLOYMENT_TARGET = /^\d+(\.\d+){0,2}$/;

/** Compare dotted versions (`"15.0"` < `"16.4"`). */
function versionBelow(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * `project.pbxproj` with every `IPHONEOS_DEPLOYMENT_TARGET` below `target` raised to it (the
 * project's and its targets' configurations). Null when it sets none, or when `target` is not a
 * version (`16`, `16.4`, `16.4.1`): anything else could end the setting and add another.
 *
 * @param pbxproj The project file.
 * @param target The deployment target (`"16.0"`).
 */
export function withDeploymentTargetAtLeast(pbxproj: string, target: string): string | null {
  if (!DEPLOYMENT_TARGET.test(target)) return null;
  const re = /(IPHONEOS_DEPLOYMENT_TARGET\s*=\s*)"?([\d.]+)"?;/g;
  if (!re.test(pbxproj)) return null;
  re.lastIndex = 0;
  return pbxproj.replace(
    re,
    (all, lead: string, version: string) =>
      versionBelow(version, target) ? `${lead}${target};` : all,
  );
}

/** Read a file, or undefined when it does not exist. */
async function readText(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
}

/** Apply `edits` to the project file `rel`, recording the outcome in `report`. */
async function edit(
  dir: string,
  rel: string,
  edits: readonly { label: string; apply: (text: string) => string | null }[],
  report: NativeInstallReport,
): Promise<void> {
  if (edits.length === 0) return;
  const text = await readText(nativeJoin(dir, rel));
  if (text === undefined) {
    const platform = rel.split("/")[0];
    report.skipped.push(
      `${platform === "ios" ? "iOS" : "Android"}: no ${rel} (run \`npx cap add ${platform}\` ` +
        "first, then run this again).",
    );
    return;
  }
  let next = text;
  for (const e of edits) {
    const out = e.apply(next);
    if (out === null) report.manual.push(`${rel}: set ${e.label} by hand`);
    else next = out;
  }
  if (next === text) report.unchanged.push(rel);
  else {
    await assertInsideProject(dir, nativeJoin(dir, rel));
    await Deno.writeTextFile(nativeJoin(dir, rel), next);
    report.written.push(rel);
  }
}

/** A text edit of one native file, named for the report. */
type TextEdit = { label: string; apply: (text: string) => string | null };

/**
 * The Info.plist edits: the usage strings (a key that is not one, or a computed text, is a
 * manual item instead), and `UIUserInterfaceStyle` for a fixed appearance.
 */
function infoPlistEdits(
  config: ExpoAppConfig,
  ios: ResolvedAppearance,
  report: NativeInstallReport,
): TextEdit[] {
  const usage = Object.entries(config.infoPlist).filter(([key]) => /UsageDescription$/.test(key));
  const edits: TextEdit[] = [];
  for (const [key, value] of usage) {
    if (!isPlistKey(key)) {
      report.manual.push(
        `Info.plist key ${JSON.stringify(key)}: not a valid Info.plist key (letters, digits, ` +
          "`_`, `.`, `-`); not written",
      );
    } else if (value === null) {
      report.manual.push(`Info.plist ${key}: its text is computed in code; set it by hand`);
    } else edits.push({ label: key, apply: (text) => withPlistDefault(text, key, value) });
  }
  if (ios.style) {
    const style = ios.style === "dark" ? "Dark" : "Light";
    edits.push({
      label: `UIUserInterfaceStyle ${style}`,
      apply: (text) => withPlistDefault(text, "UIUserInterfaceStyle", style),
    });
  }
  return edits;
}

/**
 * Carry the Expo app config at `dir` into its Capacitor shell's native projects (see the module
 * comment). Running it again changes nothing.
 *
 * @param opts The project root (the Expo app, holding `capacitor.config.*`, `ios/`, `android/`).
 * @returns What it wrote, kept, and could not carry.
 */
export async function addExpoAppConfigToProject(
  { dir }: NativeInstallOptions,
): Promise<NativeInstallReport> {
  await loadNativeDirs(dir);
  const report: NativeInstallReport = {
    written: [],
    upgraded: [],
    kept: [],
    unchanged: [],
    manual: [],
    skipped: [],
  };
  const config = await readExpoAppConfig(dir);
  if (config.source === null) {
    report.skipped.push("no app.json or app.config.* here: nothing to carry over.");
    return report;
  }
  const ios = resolveAppearance(config.appearance.ios);
  await edit(dir, INFO_PLIST, infoPlistEdits(config, ios, report), report);
  await carryIosAppearance(dir, ios, report);
  await carryAndroidAppearance(dir, config, report);
  const build = config.buildProperties;
  const permissions = config.androidPermissions.filter((p) => {
    if (isAndroidName(p)) return !IMPLIED_PERMISSIONS.has(p);
    report.manual.push(
      `android.permissions ${JSON.stringify(p)}: not a valid Android permission name (letters, ` +
        "digits, `_`, `.`); not written",
    );
    return false;
  });
  const manifest = permissions.map((permission) => ({
    label: `<uses-permission ${permission}>`,
    apply: (text: string) => withManifestPermission(text, permission),
  }));
  if (build?.usesCleartextTraffic !== undefined) {
    manifest.push({
      label: `android:usesCleartextTraffic="${build.usesCleartextTraffic}" on <application>`,
      apply: (text: string) =>
        withManifestApplicationAttribute(
          text,
          "android:usesCleartextTraffic",
          String(build.usesCleartextTraffic),
        ),
    });
  }
  await edit(dir, ANDROID_MANIFEST, manifest, report);
  const sdks: [string, number][] = [];
  if (build?.androidMinSdk) sdks.push(["minSdkVersion", build.androidMinSdk]);
  if (build?.androidCompileSdk) sdks.push(["compileSdkVersion", build.androidCompileSdk]);
  if (build?.androidTargetSdk) sdks.push(["targetSdkVersion", build.androidTargetSdk]);
  await edit(
    dir,
    VARIABLES_GRADLE,
    sdks.map(([key, value]) => ({
      label: `${key} ${value} (raised only)`,
      apply: (text: string) => withGradleSdkAtLeast(text, key, value),
    })),
    report,
  );
  let target = build?.iosDeploymentTarget;
  if (target && !DEPLOYMENT_TARGET.test(target)) {
    report.manual.push(
      `expo-build-properties ios.deploymentTarget ${JSON.stringify(target)}: not a version ` +
        "(`16`, `16.4`, `16.4.1`); not written",
    );
    target = undefined;
  }
  if (target) {
    await edit(dir, PBXPROJ, [{
      label: `IPHONEOS_DEPLOYMENT_TARGET ${target} (raised only)`,
      apply: (text: string) => withDeploymentTargetAtLeast(text, target),
    }], report);
  }
  for (const option of build?.unmapped ?? []) {
    report.manual.push(
      `expo-build-properties ${option}: no Capacitor counterpart is set; apply it in ios/ or ` +
        "android/ by hand if the shell needs it",
    );
  }
  return report;
}

/** Whether `path` exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Write the project file `rel` (creating its folder), recording written / unchanged. */
async function writeFile(
  dir: string,
  rel: string,
  content: string | Uint8Array,
  report: NativeInstallReport,
): Promise<void> {
  const path = nativeJoin(dir, rel);
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  try {
    const current = await Deno.readFile(path);
    if (current.length === bytes.length && current.every((b, i) => b === bytes[i])) {
      report.unchanged.push(rel);
      return;
    }
  } catch { /* new */ }
  await assertInsideProject(dir, path);
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeFile(path, bytes);
  report.written.push(rel);
}

/** A small PNG of one colour (`#rrggbb`): the launch screen scales it to fill. */
async function colorPng(hex: string): Promise<Uint8Array> {
  return await encodePng(solid(16, 16, parseHexColor(hex)!), { alpha: false });
}

/**
 * Replace Capacitor's white placeholder in `Splash.imageset` (which covers the launch screen)
 * with the launch colour, light and dark. Nothing when the set holds anything else.
 */
async function replacePlaceholderSplash(
  dir: string,
  launch: AppearanceColors,
  report: NativeInstallReport,
): Promise<void> {
  const placeholder = await capacitorPlaceholders(dir, "ios", "splash");
  const set = `${ASSET_CATALOG}/Splash.imageset`;
  const ours = placeholder.some((p) => p.endsWith("Contents.json"));
  if (placeholder.length === 0) return;
  const dark = LAUNCH_SPLASH_FILE.replace(/\.png$/, "-dark.png");
  const images: Record<string, unknown>[] = [
    { idiom: "universal", filename: LAUNCH_SPLASH_FILE },
  ];
  await writeFile(dir, `${set}/${LAUNCH_SPLASH_FILE}`, await colorPng(launch.light), report);
  if (launch.dark) {
    await writeFile(dir, `${set}/${dark}`, await colorPng(launch.dark), report);
    images.push({
      idiom: "universal",
      filename: dark,
      appearances: [{ appearance: "luminosity", value: "dark" }],
    });
  }
  const contents = JSON.stringify({ images, info: { author: "xcode", version: 1 } }, null, 2);
  await writeFile(dir, `${set}/Contents.json`, contents + "\n", report);
  if (ours) return;
  // The placeholder's own images (three scales of the same white square) go with it.
  for await (const entry of Deno.readDir(nativeJoin(dir, set))) {
    if (entry.isFile && /^splash-2732x2732(-\d)?\.png$/.test(entry.name)) {
      await assertInsideProject(dir, nativeJoin(dir, set, entry.name), { entry: true });
      await Deno.remove(nativeJoin(dir, set, entry.name));
      report.written.push(`${set}/${entry.name} (removed: Capacitor's placeholder)`);
    }
  }
}

/** The iOS launch screen, window and WebView colours, and the fixed appearance (Info.plist). */
async function carryIosAppearance(
  dir: string,
  ios: ResolvedAppearance,
  report: NativeInstallReport,
): Promise<void> {
  if (!(await exists(nativeJoin(dir, INFO_PLIST)))) return; // reported with Info.plist
  if (ios.launch) {
    const launch = ios.launch;
    await writeFile(
      dir,
      `${ASSET_CATALOG}/${LAUNCH_COLOR_NAME}.colorset/Contents.json`,
      colorSetJson(launch),
      report,
    );
    await edit(dir, LAUNCH_STORYBOARD, [{
      label: `the launch view's background to the colour ${LAUNCH_COLOR_NAME} (${
        describe(launch)
      })`,
      apply: (text) => withLaunchStoryboardColor(text, launch),
    }], report);
    await replacePlaceholderSplash(dir, launch, report);
  }
  if (!ios.app) return;
  const app = ios.app;
  if (!(await exists(nativeJoin(dir, SCENE_DELEGATE)))) {
    report.manual.push(
      `${SCENE_DELEGATE} is missing: paint the window and the WebView with ${describe(app)} ` +
        "where the app creates its window",
    );
    return;
  }
  await edit(dir, SCENE_DELEGATE, [{
    label: `the window and WebView background (${describe(app)}) after ` +
      "`window?.makeKeyAndVisible()`",
    apply: (text) => withSceneBackground(text, app),
  }], report);
}

/** `#fff` or `#fff / dark #000`, for a report line. */
function describe(c: AppearanceColors): string {
  return c.dark ? `${c.light}, dark ${c.dark}` : c.light;
}

/** Android's launch and window colours as resources, set on the launch and app themes. */
async function carryAndroidAppearance(
  dir: string,
  config: ExpoAppConfig,
  report: NativeInstallReport,
): Promise<void> {
  const android = resolveAppearance(config.appearance.android);
  const launch = android.launch ?? android.app;
  const app = android.app ?? android.launch;
  if (!launch || !app || !(await exists(nativeJoin(dir, ANDROID_RES)))) return;
  await writeAndroidColors(dir, launch, app, report);
  await edit(dir, `${ANDROID_RES}/values/styles.xml`, androidThemeEdits(), report);
  await androidAppearanceNotes(dir, android, report);
}

/** `values/denext_background.xml`, and `values-night/` when a colour has a dark variant. */
async function writeAndroidColors(
  dir: string,
  launch: AppearanceColors,
  app: AppearanceColors,
  report: NativeInstallReport,
): Promise<void> {
  await writeFile(
    dir,
    `${ANDROID_RES}/values/denext_background.xml`,
    androidColorsXml(launch.light, app.light),
    report,
  );
  if (!launch.dark && !app.dark) return;
  await writeFile(
    dir,
    `${ANDROID_RES}/values-night/denext_background.xml`,
    androidColorsXml(launch.dark ?? launch.light, app.dark ?? app.light),
    report,
  );
}

/** The launch theme's splash background and the app theme's window background. */
function androidThemeEdits(): TextEdit[] {
  const item = (style: string, name: string, color: string): TextEdit => ({
    label: `${name} @color/${color} in ${style}`,
    apply: (text) => withStyleItem(text, style, name, `@color/${color}`),
  });
  return [
    item("AppTheme.NoActionBarLaunch", "windowSplashScreenBackground", ANDROID_LAUNCH_COLOR),
    item("AppTheme.NoActionBar", "android:windowBackground", ANDROID_APP_COLOR),
  ];
}

/** What Android cannot take from the colours alone: a fixed appearance, the placeholder splash. */
async function androidAppearanceNotes(
  dir: string,
  android: ResolvedAppearance,
  report: NativeInstallReport,
): Promise<void> {
  if (android.style) {
    const mode = android.style === "dark" ? "YES" : "NO";
    report.manual.push(
      `userInterfaceStyle "${android.style}": Android follows the system appearance; to fix it, ` +
        `call AppCompatDelegate.setDefaultNightMode(MODE_NIGHT_${mode}) in MainActivity.onCreate`,
    );
  }
  if ((await capacitorPlaceholders(dir, "android", "splash")).length > 0) {
    report.manual.push(
      "android: the splash image is still Capacitor's placeholder; `denext mobile assets` " +
        "writes the app's own (light and dark)",
    );
  }
}
