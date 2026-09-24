// `denext mobile add auth-session`: install the native `DenextAuthSession` plugin behind
// `openAuthSession()` (denext/mobile) into an existing Capacitor project, the way `add-ota`
// installs `DenextOta`. iOS: `DenextAuthSessionPlugin.swift` (ASWebAuthenticationSession), added
// to the Xcode app target and registered by `DenextBridgeViewController` (the OTA one when OTA is
// installed, else a registering-only one). Android: `dev/denext/authsession/*.java` (a Custom
// Tab), registered from `MainActivity`. Registration composes with OTA in either order (see
// mobile-native-install.ts). The callback scheme's Android intent filter is written by the
// `auth-session` capability's `--scheme`, not here. Running it twice changes nothing.

import { join } from "@std/path";
import { addSourceFiles } from "./pbxproj.ts";
import {
  AUTH_SESSION_ANDROID_FILES,
  AUTH_SESSION_IOS_FILES,
} from "./auth-session-native-templates.ts";
import {
  AUTH_SESSION_TEMPLATES,
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
  wireBridgeViewController,
  writeTemplates,
} from "./mobile-native-install.ts";

/** The Android package the plugin uses (kept apart from the app's own package). */
const ANDROID_AUTH_DIR = "android/app/src/main/java/dev/denext/authsession";

type Installer = NativeInstaller<NativeInstallOptions, NativeInstallReport>;

async function installIos(inst: Installer): Promise<void> {
  if (!(await hasIosApp(inst))) return;
  const root = inst.opts.dir;
  await installBridgeViewController(inst, "auth-session", {
    needle: "DenextAuthSessionPlugin()",
    step:
      "make capacitorDidLoad() call `bridge?.registerPluginInstance(DenextAuthSessionPlugin())` " +
      "after super.capacitorDidLoad().",
  });
  await writeTemplates(inst, join(root, IOS_APP), AUTH_SESSION_IOS_FILES, AUTH_SESSION_TEMPLATES);
  const files = [BRIDGE_VC_FILE, ...Object.keys(AUTH_SESSION_IOS_FILES)];
  await inst.edit(
    join(root, PBXPROJ),
    (t) => addSourceFiles(t, files, { randomId: inst.opts.randomId }).text,
  );
  await wireBridgeViewController(inst);
}

async function installAndroid(inst: Installer): Promise<void> {
  if (!(await hasAndroidApp(inst))) return;
  await writeTemplates(
    inst,
    join(inst.opts.dir, ANDROID_AUTH_DIR),
    AUTH_SESSION_ANDROID_FILES,
    AUTH_SESSION_TEMPLATES,
  );
  await registerInMainActivity(inst, "auth-session");
}

/**
 * Install the native `DenextAuthSession` plugin (behind `openAuthSession()` in
 * `denext/mobile`) into the Capacitor project at `opts.dir`: `DenextAuthSessionPlugin.swift`
 * in the Xcode app target, registered by `DenextBridgeViewController` (the storyboard and
 * SceneDelegate switched to it while they are stock), and `DenextAuthSessionPlugin.java`
 * registered from `MainActivity`. It coexists with `denext mobile add-ota` in either order: the
 * shared bridge view controller and MainActivity register every installed denext plugin.
 * Idempotent; an unedited template from an earlier denext is upgraded (`upgraded`), and
 * customised files are never rewritten without `force`, only reported under `kept` and `manual`.
 *
 * @param opts The project directory and flags.
 * @returns What was written, what was already current, and what is left to do by hand.
 */
export async function addAuthSessionToProject(
  opts: NativeInstallOptions,
): Promise<NativeInstallReport> {
  const inst: Installer = new NativeInstaller(opts, {
    written: [],
    upgraded: [],
    kept: [],
    unchanged: [],
    manual: [],
    skipped: [],
  });
  await installIos(inst);
  await installAndroid(inst);
  return inst.report;
}
