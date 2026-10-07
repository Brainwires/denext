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
//     `android.usesCleartextTraffic` onto `<application>`.
//
// The app config is read statically (`readExpoAppConfig`: project code never runs). What it
// cannot carry is reported: computed values, build properties without a Capacitor
// counterpart. The config may come from someone else's repository, so nothing in it reaches a
// native file as markup or build settings: values are XML-escaped, and the plist keys, Android
// permissions and the deployment target are validated first. One that fails is a `manual` item
// with the reason, never written (the shared writers refuse it too). `denext migrate --from expo` suggests this capability when there is something
// to carry.

import { join } from "@std/path";
import type { NativeInstallOptions, NativeInstallReport } from "./mobile-native-install.ts";
import { readExpoAppConfig } from "./expo-app-config.ts";
import {
  isAndroidName,
  isPlistKey,
  withManifestApplicationAttribute,
  withManifestPermission,
  withPlistDefault,
} from "./mobile-native-config.ts";

const INFO_PLIST = "ios/App/App/Info.plist";
const ANDROID_MANIFEST = "android/app/src/main/AndroidManifest.xml";
const VARIABLES_GRADLE = "android/variables.gradle";
const PBXPROJ = "ios/App/App.xcodeproj/project.pbxproj";

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
  const text = await readText(join(dir, rel));
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
    await Deno.writeTextFile(join(dir, rel), next);
    report.written.push(rel);
  }
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
  const usage = Object.entries(config.infoPlist).filter(([key]) => /UsageDescription$/.test(key));
  const plist = usage.filter(([key]) => {
    if (isPlistKey(key)) return true;
    report.manual.push(
      `Info.plist key ${JSON.stringify(key)}: not a valid Info.plist key (letters, digits, ` +
        "`_`, `.`, `-`); not written",
    );
    return false;
  });
  for (const [key, value] of plist) {
    if (value === null) {
      report.manual.push(`Info.plist ${key}: its text is computed in code; set it by hand`);
    }
  }
  await edit(
    dir,
    INFO_PLIST,
    plist.filter(([, v]) => v !== null).map(([key, value]) => ({
      label: key,
      apply: (text: string) => withPlistDefault(text, key, value!),
    })),
    report,
  );
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
