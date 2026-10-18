// `denext mobile add file-transfer`: install denext's native `DenextTransfer` plugin behind
// `downloadToFile()` / `uploadFile()` and the transfer controls (denext/mobile). iOS:
// `DenextTransferManager.swift` (the background `URLSession`) and `DenextTransferPlugin.swift`,
// added to the Xcode app target, the plugin registered by `DenextBridgeViewController` (the
// capability's AppDelegate edit forwards the background session's events). Android:
// `dev/denext/transfer/*.java`, the plugin registered from `MainActivity`, and WorkManager added
// to `android/app/build.gradle`. Both compose with every other denext native feature in either
// order (see mobile-native-install.ts). Running it twice changes nothing.

import {
  TRANSFER_ANDROID_FILES,
  TRANSFER_IOS_FILES,
  WORK_RUNTIME_DEPENDENCY,
} from "./transfer-native-templates.ts";
import {
  hasAndroidApp,
  NativeInstaller,
  type NativeInstallOptions,
  type NativeInstallReport,
  TRANSFER_TEMPLATES,
} from "./mobile-native-install.ts";
import { installRegisteredPlugin } from "./mobile-plugin-install.ts";
import { withGradleDependency } from "./mobile-native-views-install.ts";
import type { NativeInstallStep } from "./mobile-capabilities.ts";
import { nativeJoin } from "./capacitor-native-dirs.ts";

const APP_GRADLE = "android/app/build.gradle";

/**
 * Install the native `DenextTransfer` plugin into the Capacitor project at `opts.dir`: the two
 * Swift files in the Xcode app target, the plugin registered by `DenextBridgeViewController`
 * (the storyboard and SceneDelegate switched to it while they are stock), and the Java plugin,
 * worker, store and HTTP client, the plugin registered from `MainActivity`, with
 * `androidx.work:work-runtime` in the app's dependencies. Idempotent; an unedited template from
 * an earlier denext is upgraded, and customised files are never rewritten without `force`, only
 * reported under `kept` and `manual`.
 *
 * @param opts The project directory and flags.
 * @returns What was written, what was already current, and what is left to do by hand.
 */
async function addTransferToProject(
  opts: NativeInstallOptions,
): Promise<NativeInstallReport> {
  const report = await installRegisteredPlugin(opts, {
    feature: "file-transfer",
    iosFiles: TRANSFER_IOS_FILES,
    androidFiles: TRANSFER_ANDROID_FILES,
    androidDir: "android/app/src/main/java/dev/denext/transfer",
    kind: TRANSFER_TEMPLATES,
    registration: {
      needle: "DenextTransferPlugin()",
      step: "make capacitorDidLoad() call " +
        "`bridge?.registerPluginInstance(DenextTransferPlugin())` after super.capacitorDidLoad().",
    },
  });
  const inst = new NativeInstaller(opts, report);
  if (!(await hasAndroidApp(inst))) return report;
  const gradle = nativeJoin(opts.dir, APP_GRADLE);
  let missing = false;
  await inst.edit(gradle, (text) => {
    const next = withGradleDependency(text, WORK_RUNTIME_DEPENDENCY);
    missing = next === null;
    return next ?? text;
  });
  if (missing || (await inst.read(gradle)) === undefined) {
    report.manual.push(`${APP_GRADLE}: add \`${WORK_RUNTIME_DEPENDENCY}\` to its dependencies.`);
  }
  return report;
}

/** `file-transfer`'s native step: the DenextTransfer plugin, its registration and WorkManager. */
export const TRANSFER_INSTALL: NativeInstallStep = {
  label: "DenextTransfer plugin (background downloads and uploads with progress: URLSession / " +
    "WorkManager) + its registration in DenextBridgeViewController / MainActivity",
  run: addTransferToProject,
};
