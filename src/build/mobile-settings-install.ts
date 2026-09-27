// `denext mobile add permissions` (and the capabilities that ask for a permission:
// local-notifications, biometrics, geolocation): install the native `DenextSettings` plugin
// behind `openAppSettings()` (denext/mobile). iOS: `DenextSettingsPlugin.swift`, added to the
// Xcode app target and registered by `DenextBridgeViewController` (the OTA one when OTA is
// installed, else a registering-only one). Android: `dev/denext/settings/DenextSettingsPlugin.java`,
// registered from `MainActivity`. Both compose with every other denext native feature in either
// order (see mobile-native-install.ts). Running it twice changes nothing.

import { join } from "@std/path";
import { addSourceFiles } from "./pbxproj.ts";
import { SETTINGS_ANDROID_FILES, SETTINGS_IOS_FILES } from "./settings-native-templates.ts";
import {
  BRIDGE_VC_FILE,
  hasAndroidApp,
  hasIosApp,
  installBridgeViewController,
  IOS_APP,
  NativeInstaller,
  type NativeInstallOptions,
  type NativeInstallReport,
  PBXPROJ,
  registerInMainActivity,
  SETTINGS_TEMPLATES,
  wireBridgeViewController,
  writeTemplates,
} from "./mobile-native-install.ts";

/** Where the Android plugin goes (its own package, apart from the app's). */
const ANDROID_SETTINGS_DIR = "android/app/src/main/java/dev/denext/settings";

type Installer = NativeInstaller<NativeInstallOptions, NativeInstallReport>;

/** The iOS half: the Swift plugin in the app target, registered by the bridge view controller. */
async function installIos(inst: Installer): Promise<void> {
  if (!(await hasIosApp(inst))) return;
  const appDir = join(inst.opts.dir, IOS_APP);
  await installBridgeViewController(inst, "settings", REGISTRATION);
  await writeTemplates(inst, appDir, SETTINGS_IOS_FILES, SETTINGS_TEMPLATES);
  const sources = [BRIDGE_VC_FILE, ...Object.keys(SETTINGS_IOS_FILES)];
  const randomId = inst.opts.randomId;
  await inst.edit(
    join(inst.opts.dir, PBXPROJ),
    (text) => addSourceFiles(text, sources, { randomId }).text,
  );
  await wireBridgeViewController(inst);
}

/** What the bridge view controller must call, and the manual step when it cannot be written. */
const REGISTRATION = {
  needle: "DenextSettingsPlugin()",
  step: "make capacitorDidLoad() call `bridge?.registerPluginInstance(DenextSettingsPlugin())` " +
    "after super.capacitorDidLoad().",
};

/**
 * Install the native `DenextSettings` plugin (behind `openAppSettings()` in `denext/mobile`)
 * into the Capacitor project at `opts.dir`: `DenextSettingsPlugin.swift` in the Xcode app
 * target, registered by `DenextBridgeViewController` (the storyboard and SceneDelegate switched
 * to it while they are stock), and `DenextSettingsPlugin.java` registered from `MainActivity`.
 * Idempotent; an unedited template from an earlier denext is upgraded, and customised files are
 * never rewritten without `force`, only reported under `kept` and `manual`.
 *
 * @param opts The project directory and flags.
 * @returns What was written, what was already current, and what is left to do by hand.
 */
export async function addSettingsToProject(
  opts: NativeInstallOptions,
): Promise<NativeInstallReport> {
  const report: NativeInstallReport = {
    written: [],
    upgraded: [],
    kept: [],
    unchanged: [],
    manual: [],
    skipped: [],
  };
  const inst: Installer = new NativeInstaller(opts, report);
  await installIos(inst);
  if (await hasAndroidApp(inst)) {
    const dir = join(opts.dir, ANDROID_SETTINGS_DIR);
    await writeTemplates(inst, dir, SETTINGS_ANDROID_FILES, SETTINGS_TEMPLATES);
    await registerInMainActivity(inst, "settings");
  }
  return report;
}
