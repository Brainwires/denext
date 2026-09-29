// The native steps of `denext mobile add back` and `denext mobile add system-bars`, both
// Android only. `back`: denext's `DenextBack` plugin (`dev/denext/back/DenextBackPlugin.java`,
// see back-native-templates.ts), registered from `MainActivity`. `system-bars`:
// `EdgeToEdge.enable(this)` in `MainActivity.onCreate`, which Capacitor 8's SystemBars docs
// recommend (Capacitor 9 will do it itself). Both compose with every other denext feature in
// the shared MainActivity (see mobile-native-install.ts). Running either twice changes nothing.

import { join } from "@std/path";
import { BACK_ANDROID_FILES } from "./back-native-templates.ts";
import {
  BACK_TEMPLATES,
  hasAndroidApp,
  NativeInstaller,
  type NativeInstallOptions,
  type NativeInstallReport,
  registerInMainActivity,
  writeTemplates,
} from "./mobile-native-install.ts";

/** Where the plugin goes (its own package, apart from the app's). */
const ANDROID_BACK_DIR = "android/app/src/main/java/dev/denext/back";

type Installer = NativeInstaller<NativeInstallOptions, NativeInstallReport>;

/** A fresh installer for `opts`. */
function installer(opts: NativeInstallOptions): Installer {
  return new NativeInstaller(opts, {
    written: [],
    upgraded: [],
    kept: [],
    unchanged: [],
    manual: [],
    skipped: [],
  });
}

/**
 * Install the native `DenextBack` plugin (behind `onBack()` / `useBackProgress()` in
 * `denext/mobile`) into the Capacitor project at `opts.dir`: `DenextBackPlugin.java`, registered
 * from `MainActivity`. Android only; a project without `android/` is reported as skipped.
 * Idempotent; an unedited template from an earlier denext is upgraded, an edited one kept.
 *
 * @param opts The project directory and flags.
 * @returns What was written, what was already current, and what is left to do by hand.
 */
export async function addBackToProject(opts: NativeInstallOptions): Promise<NativeInstallReport> {
  const inst = installer(opts);
  if (!(await hasAndroidApp(inst))) return inst.report;
  await writeTemplates(inst, join(opts.dir, ANDROID_BACK_DIR), BACK_ANDROID_FILES, BACK_TEMPLATES);
  await registerInMainActivity(inst, "back");
  return inst.report;
}

/**
 * Make `MainActivity` call `EdgeToEdge.enable(this)` before `super.onCreate`, so the app draws
 * edge to edge with transparent system bars on every Android version (Android 15+ enforce it
 * for apps targeting SDK 35+). Android only; idempotent.
 *
 * @param opts The project directory and flags.
 * @returns What was written, what was already current, and what is left to do by hand.
 */
export async function addEdgeToEdgeToProject(
  opts: NativeInstallOptions,
): Promise<NativeInstallReport> {
  const inst = installer(opts);
  if (!(await hasAndroidApp(inst))) return inst.report;
  await registerInMainActivity(inst, "edge-to-edge");
  return inst.report;
}
