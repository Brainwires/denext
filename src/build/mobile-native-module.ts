// `denext mobile add native-module --name <Name>`: scaffold the app's own native module — a
// Capacitor plugin with one sample async method and one event — into an existing Capacitor
// project, registered with the bridge, plus its typed TypeScript client.
//
// - iOS: `ios/App/App/<Name>Plugin.swift` (a CAPBridgedPlugin), compiled into the App target,
//   and registered from `DenextNativeModules.swift`, which `DenextBridgeViewController` calls in
//   `capacitorDidLoad()` (the bridge the other denext installers share: the storyboard and
//   SceneDelegate are switched to it while they are stock).
// - Android: `dev/denext/nativemodules/<Name>Plugin.kt`, registered from
//   `DenextNativeModules.java`, which `MainActivity.onCreate` calls before `super.onCreate`.
//   The app module gets the Kotlin Gradle plugin (Capacitor 8's app template is Java only),
//   compiling to the app's own JVM target.
// - The app: `native/Native<Name>.ts`, a `nativeModule<Spec, Events>("<Name>", { calls:
//   "positional" })` client. The `Native<Name>` file name is React Native's codegen convention,
//   so React Native mode's sync-use scan also checks its callers.
//
// Several modules share the registrars: each run inserts its module's line above the anchor
// comment. Running it twice changes nothing.

import { join } from "@std/path";
import type { CapabilityConfig, MobileCapability } from "./mobile-capabilities.ts";
import {
  BRIDGE_VC_FILE,
  compileIntoAppAndWireBridge,
  hasAndroidApp,
  hasIosApp,
  installBridgeViewController,
  IOS_APP,
  NativeInstaller,
  type NativeInstallOptions,
  type NativeInstallReport,
  registerInMainActivity,
} from "./mobile-native-install.ts";
import {
  isPristineNativeModuleTemplate,
  javaRegistrar,
  javaRegistration,
  KOTLIN_JVM_TARGET_BLOCK,
  KOTLIN_VERSION,
  kotlinPlugin,
  NATIVE_MODULES_PACKAGE,
  REGISTRAR_ANCHOR,
  renderNativeModuleTemplate,
  swiftPlugin,
  swiftRegistrar,
  swiftRegistration,
  typescriptClient,
} from "./native-module-native-templates.ts";

/** Options for {@linkcode addNativeModulesToProject}. */
export interface NativeModuleOptions extends NativeInstallOptions {
  /** The module names (`--name`, PascalCase), at least one. */
  names: readonly string[];
}

type Installer = NativeInstaller<NativeModuleOptions, NativeInstallReport>;

/** The folder of the generated Android sources, relative to the project root. */
const ANDROID_DIR = `android/app/src/main/java/${NATIVE_MODULES_PACKAGE.replaceAll(".", "/")}`;
/** The registrar files. */
const SWIFT_REGISTRAR = "DenextNativeModules.swift";
const JAVA_REGISTRAR = "DenextNativeModules.java";
/** The Gradle files the Kotlin setup edits. */
const ROOT_GRADLE = "android/build.gradle";
const APP_GRADLE = "android/app/build.gradle";
/** Where the TypeScript clients go, relative to the project root. */
const CLIENT_DIR = "native";

/** A module name: PascalCase, not one of denext's own (`Denext…`). */
const MODULE_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;

/**
 * `--name` values for `native-module`, deduplicated and checked; throws without any.
 *
 * @param names The names.
 * @returns The names.
 */
export function checkNativeModuleNames(names: readonly string[] | undefined): string[] {
  const list = [...new Set(names ?? [])];
  if (list.length === 0) {
    throw new Error(
      "native-module needs --name <Name> (a PascalCase name such as Scanner; several comma-separated).",
    );
  }
  for (const name of list) {
    if (!MODULE_NAME.test(name)) {
      throw new Error(
        `--name ${name}: a native-module name is a PascalCase identifier (letters and digits, ` +
          "starting with an upper-case letter), e.g. Scanner or PaymentTerminal.",
      );
    }
    if (name.startsWith("Denext")) {
      throw new Error(`--name ${name}: names starting with "Denext" are denext's own plugins.`);
    }
  }
  return list;
}

/** Write a marked template, keeping an edited copy. */
async function writeMarked(inst: Installer, path: string, template: string): Promise<void> {
  await inst.write(
    path,
    await renderNativeModuleTemplate(template),
    isPristineNativeModuleTemplate,
  );
}

/**
 * Make the registrar at `path` register every one of `names`: write it when absent, else insert
 * each missing line above the anchor (a registrar without the anchor that lacks a line becomes
 * a manual step).
 */
async function writeRegistrar(
  inst: Installer,
  path: string,
  names: readonly string[],
  source: (names: readonly string[]) => string,
  line: (name: string) => string,
): Promise<void> {
  const existing = await inst.read(path);
  if (existing === undefined) {
    await inst.write(path, source(names), () => Promise.resolve(false));
    return;
  }
  const missing = names.filter((n) => !existing.includes(line(n).trim()));
  if (missing.length === 0) return void inst.report.unchanged.push(inst.rel(path));
  const anchor = existing.search(new RegExp(`^[ \\t]*// ${escapeRegExp(REGISTRAR_ANCHOR)}`, "m"));
  if (anchor < 0) {
    for (const name of missing) {
      inst.report.manual.push(`${inst.rel(path)}: add \`${line(name).trim()}\` to register().`);
    }
    return;
  }
  await inst.edit(
    path,
    (t) => t.slice(0, anchor) + missing.map(line).join("") + t.slice(anchor),
  );
}

/** `text` with regular-expression metacharacters escaped. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function installIos(inst: Installer): Promise<void> {
  if (!(await hasIosApp(inst))) return;
  const root = inst.opts.dir;
  const names = inst.opts.names;
  await installBridgeViewController(inst, "native-modules", {
    needle: "DenextNativeModules.register(bridge)",
    step: "make capacitorDidLoad() call `DenextNativeModules.register(bridge)` after " +
      "super.capacitorDidLoad().",
  });
  const app = join(root, IOS_APP);
  for (const name of names) {
    await writeMarked(inst, join(app, `${name}Plugin.swift`), swiftPlugin(name));
  }
  await writeRegistrar(inst, join(app, SWIFT_REGISTRAR), names, swiftRegistrar, swiftRegistration);
  const files = [BRIDGE_VC_FILE, SWIFT_REGISTRAR, ...names.map((n) => `${n}Plugin.swift`)];
  await compileIntoAppAndWireBridge(inst, files);
}

/** `android/build.gradle` with the Kotlin Gradle plugin on the buildscript classpath. */
export function withKotlinClasspath(text: string): string | null {
  if (/kotlin-gradle-plugin/.test(text)) return text;
  const agp = /^([ \t]*)classpath\s+['"]com\.android\.tools\.build:gradle:[^'"]+['"][^\n]*\n/m
    .exec(text);
  if (!agp) return null;
  const at = agp.index + agp[0].length;
  return text.slice(0, at) +
    `${agp[1]}classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:${KOTLIN_VERSION}"\n` +
    text.slice(at);
}

/** `android/app/build.gradle` applying the Kotlin Android plugin, with the JVM target block. */
export function withKotlinAndroid(text: string): string | null {
  let next = text;
  if (!/org\.jetbrains\.kotlin\.android|['"]kotlin-android['"]/.test(next)) {
    const apply = /^apply plugin:\s*['"]com\.android\.application['"][^\n]*\n/m.exec(next);
    if (!apply) return null;
    const at = apply.index + apply[0].length;
    next = next.slice(0, at) + "apply plugin: 'org.jetbrains.kotlin.android'\n" + next.slice(at);
  }
  if (!next.includes("org.jetbrains.kotlin.gradle.tasks.KotlinCompile")) {
    next = next.replace(/\n*$/, "\n") + KOTLIN_JVM_TARGET_BLOCK;
  }
  return next;
}

/** Apply a Gradle edit, reporting a file it cannot edit as a manual step. */
async function editGradle(
  inst: Installer,
  rel: string,
  edit: (text: string) => string | null,
  step: string,
): Promise<void> {
  const path = join(inst.opts.dir, rel);
  const text = await inst.read(path);
  const next = text === undefined ? null : edit(text);
  if (next === null) return void inst.report.manual.push(`${rel}: ${step}`);
  await inst.edit(path, () => next);
}

async function installAndroid(inst: Installer): Promise<void> {
  if (!(await hasAndroidApp(inst))) return;
  const names = inst.opts.names;
  const dir = join(inst.opts.dir, ANDROID_DIR);
  for (const name of names) {
    await writeMarked(inst, join(dir, `${name}Plugin.kt`), kotlinPlugin(name));
  }
  await writeRegistrar(inst, join(dir, JAVA_REGISTRAR), names, javaRegistrar, javaRegistration);
  await editGradle(
    inst,
    ROOT_GRADLE,
    withKotlinClasspath,
    `add \`classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:${KOTLIN_VERSION}"\` to ` +
      "buildscript.dependencies.",
  );
  await editGradle(
    inst,
    APP_GRADLE,
    withKotlinAndroid,
    "add `apply plugin: 'org.jetbrains.kotlin.android'` after the com.android.application plugin.",
  );
  await registerInMainActivity(inst, "native-modules");
}

/**
 * Scaffold the native modules `opts.names` into the Capacitor project at `opts.dir` (see the
 * module comment). Idempotent: an unedited generated file is refreshed, an edited one kept
 * (reported under `kept` and `manual`), and the registrars only gain missing lines.
 *
 * @param opts The project directory, the names and flags.
 * @returns What was written, what was already current, and what is left to do by hand.
 */
export async function addNativeModulesToProject(
  opts: NativeModuleOptions,
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
  for (const name of opts.names) {
    await writeMarked(
      inst,
      join(opts.dir, CLIENT_DIR, `Native${name}.ts`),
      typescriptClient(name),
    );
  }
  return inst.report;
}

/**
 * The `native-module` capability of `denext mobile add`: no npm package, denext's scaffold
 * installed through its `install` step.
 */
export const NATIVE_MODULE_CAPABILITY: MobileCapability = {
  capacitorMajor: 8,
  notes: "nativeModule(name) / native/Native<Name>.ts: your own Swift + Kotlin plugin, one " +
    "sample method and event (--name <Name>; also TurboModuleRegistry / requireNativeModule " +
    "in React Native mode)",
  options: ["names"],
  configure: (options): CapabilityConfig => {
    const names = checkNativeModuleNames(options.names);
    return {
      install: {
        label: `native module${names.length > 1 ? "s" : ""} ${names.join(", ")} (iOS ` +
          "<Name>Plugin.swift, Android <Name>Plugin.kt + the Kotlin Gradle plugin, registered " +
          "through DenextNativeModules) + native/Native<Name>.ts",
        run: (opts) => addNativeModulesToProject({ ...opts, names }),
      },
    };
  },
};
