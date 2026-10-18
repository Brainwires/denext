// `denext mobile add storage`: install the native `DenextStorage` plugin behind
// `openKeyValueStore()` (denext/mobile) and React Native mode's AsyncStorage / MMKV stand-ins.
// iOS: `DenextStoragePlugin.swift`, added to the Xcode app target and registered by
// `DenextBridgeViewController` (the OTA one when OTA is installed, else a registering-only one).
// Android: `dev/denext/storage/DenextStoragePlugin.java`, registered from `MainActivity`. Both
// compose with every other denext native feature in either order (see mobile-native-install.ts).
// `--encrypted` also links SQLCipher (`openKeyValueStore(name, { encrypted: true })`): the
// SQLCipher Swift package in the Xcode app target, and on Android `DenextStorageCipher.java` with
// `net.zetetic:sqlcipher-android` in `android/app/build.gradle`. Running it twice changes nothing.

import {
  SQLCIPHER_ANDROID_DEPENDENCIES,
  SQLCIPHER_SWIFT_PACKAGE,
  STORAGE_ANDROID_FILES,
  STORAGE_CIPHER_ANDROID_FILES,
  STORAGE_IOS_FILES,
} from "./storage-native-templates.ts";
import {
  hasAndroidApp,
  hasIosApp,
  NativeInstaller,
  type NativeInstallOptions,
  type NativeInstallReport,
  PBXPROJ,
  STORAGE_TEMPLATES,
} from "./mobile-native-install.ts";
import { installRegisteredPlugin } from "./mobile-plugin-install.ts";
import { withGradleDependency } from "./mobile-native-views-install.ts";
import { addSwiftPackageProduct } from "./pbxproj.ts";
import { nativeJoin } from "./capacitor-native-dirs.ts";
import type { NativeInstallStep } from "./mobile-capabilities.ts";

const APP_GRADLE = "android/app/build.gradle";

/**
 * Install the native `DenextStorage` plugin (behind `openKeyValueStore()` in `denext/mobile`)
 * into the Capacitor project at `opts.dir`: `DenextStoragePlugin.swift` in the Xcode app target,
 * registered by `DenextBridgeViewController` (the storyboard and SceneDelegate switched to it
 * while they are stock), and `DenextStoragePlugin.java` registered from `MainActivity`.
 * Idempotent; an unedited template from an earlier denext is upgraded, and customised files are
 * never rewritten without `force`, only reported under `kept` and `manual`.
 *
 * @param opts The project directory and flags.
 * @returns What was written, what was already current, and what is left to do by hand.
 */
export function addStorageToProject(
  opts: NativeInstallOptions,
  encrypted = false,
): Promise<NativeInstallReport> {
  return installRegisteredPlugin(opts, {
    feature: "storage",
    iosFiles: STORAGE_IOS_FILES,
    androidFiles: encrypted
      ? { ...STORAGE_ANDROID_FILES, ...STORAGE_CIPHER_ANDROID_FILES }
      : STORAGE_ANDROID_FILES,
    androidDir: "android/app/src/main/java/dev/denext/storage",
    kind: STORAGE_TEMPLATES,
    registration: {
      needle: "DenextStoragePlugin()",
      step: "make capacitorDidLoad() call " +
        "`bridge?.registerPluginInstance(DenextStoragePlugin())` after super.capacitorDidLoad().",
    },
  });
}

/**
 * {@linkcode addStorageToProject} with SQLCipher: `DenextStorageCipher.java` beside the plugin,
 * `net.zetetic:sqlcipher-android` in the app's Gradle dependencies, and the SQLCipher Swift package
 * linked into the Xcode app target. A dependency that has no place to go is left as a manual step.
 *
 * @param opts The project directory and flags.
 * @returns What was written, what was already current, and what is left to do by hand.
 */
export async function addEncryptedStorageToProject(
  opts: NativeInstallOptions,
): Promise<NativeInstallReport> {
  const report = await addStorageToProject(opts, true);
  const inst = new NativeInstaller(opts, report);
  if (await hasIosApp(inst)) {
    const randomId = opts.randomId;
    await inst.edit(
      nativeJoin(opts.dir, PBXPROJ),
      (text) => addSwiftPackageProduct(text, SQLCIPHER_SWIFT_PACKAGE, { randomId }).text,
    );
  }
  if (await hasAndroidApp(inst)) {
    const gradle = nativeJoin(opts.dir, APP_GRADLE);
    let missing = (await inst.read(gradle)) === undefined;
    await inst.edit(gradle, (text) => {
      let out: string | null = text;
      for (const dep of SQLCIPHER_ANDROID_DEPENDENCIES) out = out && withGradleDependency(out, dep);
      missing = out === null;
      return out ?? text;
    });
    if (missing) {
      const deps = SQLCIPHER_ANDROID_DEPENDENCIES.map((d) => `\`${d}\``).join(" and ");
      report.manual.push(`${APP_GRADLE}: add ${deps} to its dependencies.`);
    }
  }
  return report;
}

/** `storage`'s native step: the DenextStorage plugin and its registration. */
export const STORAGE_INSTALL: NativeInstallStep = {
  label: "DenextStorage plugin (durable key-value storage in the app's data folder) + its " +
    "registration in DenextBridgeViewController / MainActivity",
  run: (opts) => addStorageToProject(opts),
};

/** `storage --encrypted`'s native step: the plugin, its registration and SQLCipher. */
export const ENCRYPTED_STORAGE_INSTALL: NativeInstallStep = {
  label: "DenextStorage plugin with SQLCipher (encrypted stores: the SQLCipher Swift package, " +
    "net.zetetic:sqlcipher-android) + its registration in DenextBridgeViewController / MainActivity",
  run: addEncryptedStorageToProject,
};
