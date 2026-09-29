// The installer shape the single-file denext native plugins share (`DenextSettings` from `mobile
// add permissions`, `DenextAccessibility` from `mobile add accessibility`): one Swift file in the
// Xcode app target, registered by `DenextBridgeViewController`, and one Java file in its own
// package, registered from `MainActivity`. Both compose with every other denext native feature
// in either order (see mobile-native-install.ts). Running it twice changes nothing.

import { join } from "@std/path";
import { addSourceFiles } from "./pbxproj.ts";
import {
  type AndroidFeature,
  BRIDGE_VC_FILE,
  hasAndroidApp,
  hasIosApp,
  installBridgeViewController,
  IOS_APP,
  type NativeFeature,
  NativeInstaller,
  type NativeInstallOptions,
  type NativeInstallReport,
  PBXPROJ,
  registerInMainActivity,
  type TemplateKind,
  wireBridgeViewController,
  writeTemplates,
} from "./mobile-native-install.ts";

/** One registered plugin: its templates and how it is registered on each platform. */
export interface RegisteredPluginSpec {
  /** The feature it registers as (on both platforms). */
  readonly feature: NativeFeature & AndroidFeature;
  /** Swift files for `ios/App/App/`. */
  readonly iosFiles: Readonly<Record<string, string>>;
  /** Java files for `androidDir`. */
  readonly androidFiles: Readonly<Record<string, string>>;
  /** Where the Java files go, relative to the project root. */
  readonly androidDir: string;
  /** The template family (marker line, pristine check). */
  readonly kind: TemplateKind;
  /** What the bridge view controller must call, and the manual step when it cannot. */
  readonly registration: { readonly needle: string; readonly step: string };
}

type Installer = NativeInstaller<NativeInstallOptions, NativeInstallReport>;

/** The iOS half: the Swift plugin in the app target, registered by the bridge view controller. */
async function installIos(inst: Installer, spec: RegisteredPluginSpec): Promise<void> {
  if (!(await hasIosApp(inst))) return;
  const appDir = join(inst.opts.dir, IOS_APP);
  await installBridgeViewController(inst, spec.feature, spec.registration);
  await writeTemplates(inst, appDir, spec.iosFiles, spec.kind);
  const sources = [BRIDGE_VC_FILE, ...Object.keys(spec.iosFiles)];
  const randomId = inst.opts.randomId;
  await inst.edit(
    join(inst.opts.dir, PBXPROJ),
    (text) => addSourceFiles(text, sources, { randomId }).text,
  );
  await wireBridgeViewController(inst);
}

/**
 * Install one registered plugin into the Capacitor project at `opts.dir` (see
 * {@linkcode RegisteredPluginSpec}). Idempotent; an unedited template from an earlier denext is
 * upgraded, and customised files are never rewritten without `force`, only reported under
 * `kept` and `manual`.
 *
 * @param opts The project directory and flags.
 * @param spec The plugin.
 * @returns What was written, what was already current, and what is left to do by hand.
 */
export async function installRegisteredPlugin(
  opts: NativeInstallOptions,
  spec: RegisteredPluginSpec,
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
  await installIos(inst, spec);
  if (await hasAndroidApp(inst)) {
    await writeTemplates(inst, join(opts.dir, spec.androidDir), spec.androidFiles, spec.kind);
    await registerInMainActivity(inst, spec.feature);
  }
  return report;
}
