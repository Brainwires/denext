// `denext mobile add share-extension | widget | live-activity`: add app extensions to an
// existing Capacitor project, the way `add-ota` / `add auth-session` install denext's plugins.
//
// - share-extension: an iOS Share Extension target (DenextShareExtension) that queues what was
//   shared in the App Group container and opens the app through its URL scheme; Android SEND /
//   SEND_MULTIPLE intent filters on the launcher activity; and the DenextShareReceive plugin
//   (both platforms) behind onShareReceived().
// - widget --name <Name> [--configurable <param:enum=a|b,...>]: a WidgetKit extension target
//   (DenextWidgets, created once) with one widget per name reading the JSON setWidgetData()
//   stored in the App Group (configurable: an App Intents configuration on iOS 17+ whose
//   provider reads the snapshot stored for the chosen values, static before); on Android an
//   AppWidgetProvider per name with its layout, provider XML and manifest receiver; and the
//   DenextWidgets plugin behind setWidgetData() / reloadWidgets().
// - live-activity --name <Name> (iOS only): the ActivityKit attributes (compiled into the app and
//   the widget extension), a Live Activity UI per name in the widget extension (created when
//   absent), NSSupportsLiveActivities, and the DenextLiveActivity plugin.
//
// Each shares an App Group with the app (mobile-app-group.ts). Every template carries a marker
// (app-extension-native-templates.ts): an unedited one is upgraded by a later run, an edited one
// kept and reported. Running any of them twice changes nothing.

import { join } from "@std/path";
import { addSourceFiles, applicationTargetName } from "./pbxproj.ts";
import {
  plistEntry,
  plistTopDict,
  withManifestActivityBlock,
  withManifestApplicationBlock,
  withPlistTrue,
} from "./mobile-native-config.ts";
import {
  isPristineAppExtensionTemplate,
  renderAppExtensionTemplate,
  SHARE_EXTENSION_ATTRIBUTES,
  SHARE_EXTENSION_IOS_FILES,
  SHARE_EXTENSION_TARGET,
  SHARE_INTENT_FILTERS,
  SHARE_RECEIVE_ANDROID_FILES,
  SHARE_RECEIVE_IOS_FILES,
} from "./app-extension-native-templates.ts";
import {
  androidWidgetInfo,
  androidWidgetLayout,
  androidWidgetReceiver,
  androidWidgetSource,
  configurableWidgetSource,
  EXTENSION_NAME,
  LIVE_ACTIVITY_PLUGIN_IOS_FILES,
  LIVE_ACTIVITY_SHARED_FILES,
  liveActivitiesSource,
  liveActivitySource,
  snakeName,
  WIDGET_EXTENSION_ATTRIBUTES,
  type WidgetParam,
  widgetParamsIn,
  WIDGETS_ANDROID_FILES,
  WIDGETS_IOS_FILES,
  WIDGETS_PLUGIN_IOS_FILES,
  WIDGETS_TARGET,
  widgetsBundleSource,
  widgetSource,
} from "./widget-native-templates.ts";
import {
  APP_EXTENSION_TEMPLATES,
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
  readText,
  registerInMainActivity,
  wireBridgeViewController,
  writeTemplates,
} from "./mobile-native-install.ts";
import {
  installAppGroup,
  installExtensionTarget,
  reportAppGroup,
  resolveAppGroup,
} from "./mobile-app-group.ts";

/** Options for the app extension installers. */
export interface AppExtensionOptions extends NativeInstallOptions {
  /** `--app-group`: the App Group (default `group.<the app's bundle id>`). */
  appGroup?: string;
  /**
   * share-extension: the app's custom URL scheme the extension opens it with (default: the
   * first CFBundleURLSchemes entry of the app's Info.plist).
   */
  scheme?: string;
  /** widget / live-activity: the names (`--name`, PascalCase), at least one. */
  names?: readonly string[];
  /**
   * widget: `--configurable`, parsed (`parseWidgetParams` in widget-native-templates.ts): make every named widget
   * configurable with these enum parameters. Absent, a widget already configurable keeps the
   * parameters its source records.
   */
  configurable?: readonly WidgetParam[];
}

type Installer = NativeInstaller<AppExtensionOptions, NativeInstallReport>;

const ANDROID_MAIN = "android/app/src/main";
const ANDROID_JAVA = `${ANDROID_MAIN}/java`;
const ANDROID_MANIFEST = `${ANDROID_MAIN}/AndroidManifest.xml`;
/** The folder of the widget extension, relative to the project root. */
const WIDGETS_DIR = `ios/App/${WIDGETS_TARGET}`;

function newInstaller(opts: AppExtensionOptions): Installer {
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
 * `--name` values for a widget / live-activity, deduplicated and checked (PascalCase type
 * names); throws without any.
 *
 * @param names The names.
 * @param what The capability, for the error message.
 * @returns The names.
 */
export function checkExtensionNames(names: readonly string[] | undefined, what: string): string[] {
  const list = [...new Set(names ?? [])];
  if (list.length === 0) {
    throw new Error(
      `${what} needs --name <Name> (a PascalCase name such as Status; several comma-separated).`,
    );
  }
  for (const name of list) {
    if (!EXTENSION_NAME.test(name)) {
      throw new Error(
        `--name ${name}: a ${what} name is a PascalCase identifier (letters and digits, starting ` +
          "with an upper-case letter), e.g. Status or OrderProgress.",
      );
    }
  }
  return list;
}

/** Write `content` (a template already rendered with its marker) at `path`. */
function writeMarked(inst: Installer, path: string, content: string): Promise<boolean> {
  return inst.write(path, content, isPristineAppExtensionTemplate);
}

/** Add `files` of the group `group` (default: the target's own) to target `target`. */
async function compile(
  inst: Installer,
  files: readonly string[],
  where: { target?: string; group?: string },
): Promise<void> {
  const randomId = inst.opts.randomId;
  await inst.edit(join(inst.opts.dir, PBXPROJ), (t) =>
    addSourceFiles(t, files, {
      target: where.target ?? applicationTargetName(t),
      group: where.group,
      randomId,
    }).text);
}

/** The App Group for this run (from `--app-group` or the app's bundle id). */
async function appGroupOf(inst: Installer): Promise<string> {
  return resolveAppGroup((await readText(join(inst.opts.dir, PBXPROJ)))!, inst.opts.appGroup);
}

/**
 * Register `feature`'s plugin in the shared bridge view controller and compile it (plus the
 * bridge) into the app; `plugin` is its Swift file in the app folder.
 */
async function installAppPlugin(
  inst: Installer,
  feature: NativeFeature,
  files: Readonly<Record<string, string>>,
  pluginClass: string,
): Promise<void> {
  await installBridgeViewController(inst, feature, {
    needle: `${pluginClass}()`,
    step:
      `make capacitorDidLoad() call \`bridge?.registerPluginInstance(${pluginClass}())\` after ` +
      "super.capacitorDidLoad().",
  });
  await writeTemplates(inst, join(inst.opts.dir, IOS_APP), files, APP_EXTENSION_TEMPLATES);
  await compile(inst, [BRIDGE_VC_FILE, ...Object.keys(files)], {});
}

/** Finish an iOS install: storyboard / SceneDelegate wiring, the App Group, the portal note. */
async function finishIos(inst: Installer, group: string): Promise<void> {
  await wireBridgeViewController(inst);
  await installAppGroup(inst, group);
  await reportAppGroup(inst, group);
}

/** Apply `edit` to the Android manifest, or report `step` when it has no place for it. */
async function editManifest(
  inst: Installer,
  edit: (text: string) => string | null,
  step: string,
): Promise<void> {
  const path = join(inst.opts.dir, ANDROID_MANIFEST);
  const text = await readText(path);
  const next = text === undefined ? null : edit(text);
  if (next === null) return void inst.report.manual.push(`${ANDROID_MANIFEST}: ${step}`);
  await inst.edit(path, () => next);
}

// ---------------------------------------------------------------------------------------------
// share-extension

/** The app's first registered custom URL scheme (Info.plist CFBundleURLSchemes). */
async function appScheme(root: string): Promise<string | undefined> {
  const plist = await readText(join(root, IOS_APP, "Info.plist"));
  const top = plist === undefined ? null : plistTopDict(plist);
  if (!plist || !top || !plistEntry(plist, top, "CFBundleURLTypes")) return undefined;
  const types = plist.slice(plist.indexOf("<key>CFBundleURLTypes</key>"), top.close);
  const schemes = /<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(
    types,
  );
  const scheme = schemes?.[1].trim();
  return scheme && !scheme.includes("$(") ? scheme : undefined;
}

async function installShareIos(inst: Installer): Promise<void> {
  if (!(await hasIosApp(inst))) return;
  const root = inst.opts.dir;
  const scheme = inst.opts.scheme ?? await appScheme(root);
  if (scheme === undefined) {
    throw new Error(
      "share-extension opens the app through its URL scheme, and the app registers none: pass " +
        "--scheme <scheme> (or run `denext mobile add deep-links --scheme <scheme>` first).",
    );
  }
  const group = await appGroupOf(inst);
  await installAppPlugin(
    inst,
    "share-receive",
    SHARE_RECEIVE_IOS_FILES,
    "DenextShareReceivePlugin",
  );
  await writeTemplates(
    inst,
    join(root, "ios", "App", SHARE_EXTENSION_TARGET),
    SHARE_EXTENSION_IOS_FILES,
    APP_EXTENSION_TEMPLATES,
  );
  await installExtensionTarget(
    inst,
    {
      name: SHARE_EXTENSION_TARGET,
      bundleSuffix: "share",
      extensionAttributes: SHARE_EXTENSION_ATTRIBUTES,
      plist: { DenextAppScheme: scheme },
    },
    group,
    Object.keys(SHARE_EXTENSION_IOS_FILES),
  );
  // The inbox is read by the app's plugin too.
  await compile(inst, ["DenextShareInbox.swift"], { group: SHARE_EXTENSION_TARGET });
  await finishIos(inst, group);
}

async function installShareAndroid(inst: Installer): Promise<void> {
  if (!(await hasAndroidApp(inst))) return;
  await writeTemplates(
    inst,
    join(inst.opts.dir, ANDROID_JAVA, "dev", "denext", "sharereceive"),
    SHARE_RECEIVE_ANDROID_FILES,
    APP_EXTENSION_TEMPLATES,
  );
  await registerInMainActivity(inst, "share-receive");
  await editManifest(
    inst,
    (text) =>
      withManifestActivityBlock(
        text,
        'android:name="android.intent.action.SEND"',
        SHARE_INTENT_FILTERS,
      ),
    "add SEND and SEND_MULTIPLE intent filters (text/plain, image/*) to the launcher activity.",
  );
}

/**
 * Install the share extension into the Capacitor project at `opts.dir`: on iOS the
 * DenextShareExtension target (ShareViewController + DenextShareInbox, embedded in the app, App
 * Group entitlement, DenextAppScheme to open the app with) and the DenextShareReceive plugin in
 * the app; on Android SEND / SEND_MULTIPLE intent filters on the launcher activity and the
 * DenextShareReceive plugin. Idempotent; edited templates are kept and reported. Throws before
 * changing anything when iOS has no URL scheme to open the app with (pass `scheme`).
 *
 * @param opts The project directory, App Group and scheme.
 * @returns What was written, kept, and left to do by hand.
 */
export async function addShareExtensionToProject(
  opts: AppExtensionOptions,
): Promise<NativeInstallReport> {
  const inst = newInstaller(opts);
  await installShareIos(inst);
  await installShareAndroid(inst);
  return inst.report;
}

// ---------------------------------------------------------------------------------------------
// widgets + Live Activities: the shared widget extension

/** The names of the `<Name><suffix>.swift` files in the widget extension declaring `decl`. */
async function namesIn(root: string, suffix: string, decl: (name: string) => string) {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(join(root, WIDGETS_DIR))) {
      const m = new RegExp(`^(\\w+)${suffix}\\.swift$`).exec(entry.name);
      if (!entry.isFile || !m || !EXTENSION_NAME.test(m[1])) continue;
      const text = await Deno.readTextFile(join(root, WIDGETS_DIR, entry.name));
      if (text.includes(decl(m[1]))) names.push(m[1]);
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return names.sort();
}

/** The widget names installed in the extension. */
function installedWidgets(root: string): Promise<string[]> {
  return namesIn(root, "Widget", (n) => `struct ${n}Widget: Widget`);
}

/** The installed widgets that are configurable (declare `<Name>ConfigurableWidget`). */
function installedConfigurable(root: string): Promise<string[]> {
  return namesIn(root, "Widget", (n) => `struct ${n}ConfigurableWidget: Widget`);
}

/** The Live Activity names installed in the extension. */
function installedLiveActivities(root: string): Promise<string[]> {
  return namesIn(root, "LiveActivity", (n) => `enum ${n}LiveActivity`);
}

/** Create (or keep) the widget extension target with its fixed files. */
async function installWidgetExtension(inst: Installer, group: string): Promise<void> {
  const root = inst.opts.dir;
  await writeTemplates(inst, join(root, WIDGETS_DIR), WIDGETS_IOS_FILES, APP_EXTENSION_TEMPLATES);
  await installExtensionTarget(
    inst,
    {
      name: WIDGETS_TARGET,
      bundleSuffix: "widgets",
      extensionAttributes: WIDGET_EXTENSION_ATTRIBUTES,
      minimumIos: "14.0",
    },
    group,
    Object.keys(WIDGETS_IOS_FILES),
  );
}

/** Rewrite the extension's bundle to list every widget and the Live Activities. */
async function composeBundle(inst: Installer): Promise<void> {
  const root = inst.opts.dir;
  const widgets = await installedWidgets(root);
  const configurable = await installedConfigurable(root);
  const live = (await installedLiveActivities(root)).length > 0;
  const path = join(root, WIDGETS_DIR, "DenextWidgetsBundle.swift");
  const content = await renderAppExtensionTemplate(
    widgetsBundleSource(widgets, live, configurable),
  );
  if (!(await writeMarked(inst, path, content))) {
    const text = await readText(path) ?? "";
    const missing = [
      ...widgets.map((w) => `${w}Widget()`),
      ...configurable.map((w) => `${w}ConfigurableWidget()`),
      ...(live ? ["DenextLiveActivities()"] : []),
    ].filter((w) => !text.includes(w));
    if (missing.length > 0) {
      inst.report.manual.push(
        `${inst.rel(path)}: list ${missing.join(", ")} in the bundle's body.`,
      );
    }
  }
  await compile(inst, ["DenextWidgetsBundle.swift"], { target: WIDGETS_TARGET });
}

/** The app's Android resource package: `namespace` in app/build.gradle(.kts). */
async function androidNamespace(root: string): Promise<string | undefined> {
  for (const file of ["build.gradle", "build.gradle.kts"]) {
    const text = await readText(join(root, "android", "app", file));
    const ns = text && /\bnamespace\s*=?\s*["']([\w.]+)["']/.exec(text)?.[1];
    if (ns) return ns;
  }
  return undefined;
}

async function installWidgetsIos(inst: Installer, names: readonly string[]): Promise<void> {
  if (!(await hasIosApp(inst))) return;
  const root = inst.opts.dir;
  const group = await appGroupOf(inst);
  await installAppPlugin(inst, "widgets", WIDGETS_PLUGIN_IOS_FILES, "DenextWidgetsPlugin");
  await installWidgetExtension(inst, group);
  for (const name of names) {
    const path = join(root, WIDGETS_DIR, `${name}Widget.swift`);
    const existing = await readText(path);
    const params = inst.opts.configurable ??
      (existing === undefined ? undefined : widgetParamsIn(existing));
    const source = params !== undefined && params.length > 0
      ? configurableWidgetSource(name, params)
      : widgetSource(name);
    await writeMarked(inst, path, await renderAppExtensionTemplate(source));
  }
  await compile(inst, names.map((n) => `${n}Widget.swift`), { target: WIDGETS_TARGET });
  await composeBundle(inst);
  await finishIos(inst, group);
}

async function installWidgetsAndroid(inst: Installer, names: readonly string[]): Promise<void> {
  if (!(await hasAndroidApp(inst))) return;
  const root = inst.opts.dir;
  const rPackage = await androidNamespace(root);
  if (rPackage === undefined) {
    inst.report.manual.push(
      "Android: no `namespace` in android/app/build.gradle, so the widget providers were not " +
        "written (they import the app's R class).",
    );
    return;
  }
  const javaDir = join(root, ANDROID_JAVA, "dev", "denext", "widgets");
  await writeTemplates(inst, javaDir, WIDGETS_ANDROID_FILES, APP_EXTENSION_TEMPLATES);
  for (const name of names) {
    const res = snakeName(name);
    await writeMarked(
      inst,
      join(javaDir, `${name}Widget.java`),
      await renderAppExtensionTemplate(androidWidgetSource(name, rPackage)),
    );
    await writeMarked(
      inst,
      join(root, ANDROID_MAIN, "res", "layout", `denext_widget_${res}.xml`),
      await renderAppExtensionTemplate(androidWidgetLayout(), "xml"),
    );
    await writeMarked(
      inst,
      join(root, ANDROID_MAIN, "res", "xml", `denext_widget_${res}_info.xml`),
      await renderAppExtensionTemplate(androidWidgetInfo(name), "xml"),
    );
    await editManifest(
      inst,
      (text) =>
        withManifestApplicationBlock(
          text,
          `android:name="dev.denext.widgets.${name}Widget"`,
          androidWidgetReceiver(name),
        ),
      `add the <receiver> for dev.denext.widgets.${name}Widget inside <application>.`,
    );
  }
  await registerInMainActivity(inst, "widgets");
  if ((inst.opts.configurable?.length ?? 0) > 0) {
    inst.report.skipped.push(
      "Android: widgets are static (no configure activity); they show the snapshot " +
        "setWidgetData stores without params.",
    );
  }
}

/**
 * Install home-screen widgets into the Capacitor project at `opts.dir`, one per name: on iOS the
 * DenextWidgets WidgetKit extension (created once, embedded in the app, App Group entitlement)
 * with `<Name>Widget.swift` each (configurable with `opts.configurable`: an App Intents
 * `WidgetConfigurationIntent` on iOS 17+, a static configuration on 14–16) and the bundle
 * listing them, plus the DenextWidgets plugin in the app; on Android `<Name>Widget.java` (an AppWidgetProvider) with its layout, provider XML
 * and manifest receiver, plus the DenextWidgets plugin. Idempotent; edited templates are kept.
 *
 * @param opts The project directory, App Group and widget names.
 * @returns What was written, kept, and left to do by hand.
 */
export async function addWidgetsToProject(opts: AppExtensionOptions): Promise<NativeInstallReport> {
  const names = checkExtensionNames(opts.names, "widget");
  const inst = newInstaller(opts);
  await installWidgetsIos(inst, names);
  await installWidgetsAndroid(inst, names);
  return inst.report;
}

// ---------------------------------------------------------------------------------------------
// live-activity

async function installLiveActivitiesIos(inst: Installer, names: readonly string[]): Promise<void> {
  if (!(await hasIosApp(inst))) return;
  const root = inst.opts.dir;
  const group = await appGroupOf(inst);
  await installAppPlugin(
    inst,
    "live-activity",
    LIVE_ACTIVITY_PLUGIN_IOS_FILES,
    "DenextLiveActivityPlugin",
  );
  await installWidgetExtension(inst, group);
  await writeTemplates(
    inst,
    join(root, WIDGETS_DIR),
    LIVE_ACTIVITY_SHARED_FILES,
    APP_EXTENSION_TEMPLATES,
  );
  for (const name of names) {
    await writeMarked(
      inst,
      join(root, WIDGETS_DIR, `${name}LiveActivity.swift`),
      await renderAppExtensionTemplate(liveActivitySource(name)),
    );
  }
  const all = await installedLiveActivities(root);
  const dispatcher = join(root, WIDGETS_DIR, "DenextLiveActivities.swift");
  if (
    !(await writeMarked(
      inst,
      dispatcher,
      await renderAppExtensionTemplate(liveActivitiesSource(all)),
    ))
  ) {
    const text = await readText(dispatcher) ?? "";
    const missing = all.filter((n) => !text.includes(`${n}LiveActivity.`));
    if (missing.length > 0) {
      inst.report.manual.push(
        `${inst.rel(dispatcher)}: dispatch ${missing.join(", ")} in both switches.`,
      );
    }
  }
  const shared = Object.keys(LIVE_ACTIVITY_SHARED_FILES);
  await compile(
    inst,
    [...shared, "DenextLiveActivities.swift", ...names.map((n) => `${n}LiveActivity.swift`)],
    { target: WIDGETS_TARGET },
  );
  // The app starts the activities, so it compiles the attributes too.
  await compile(inst, shared, { group: WIDGETS_TARGET });
  await composeBundle(inst);
  const plist = join(root, IOS_APP, "Info.plist");
  const text = await readText(plist);
  const next = text === undefined ? null : withPlistTrue(text, "NSSupportsLiveActivities");
  if (next === null) {
    inst.report.manual.push(`${IOS_APP}/Info.plist: set NSSupportsLiveActivities to YES.`);
  } else {
    await inst.edit(plist, () => next);
  }
  await finishIos(inst, group);
  inst.report.manual.push(
    "Live Activities need iOS 16.1 or later (the app keeps its deployment target; older iOS " +
      "rejects with code unsupported). To update one by push, start it with { push: true }, " +
      "send liveActivityPushToken(id) to your server, and give the app the push entitlement " +
      "(`denext mobile add push`). To start one by push (iOS 17.2+), send " +
      "liveActivityPushToStartToken() to your server, which sends an APNs push with " +
      "apns-push-type liveactivity, event start and attributes-type DenextActivityAttributes.",
  );
}

/**
 * Install Live Activities into the Capacitor project at `opts.dir` (iOS only), one UI per name:
 * the DenextActivityAttributes type (compiled into the app and the widget extension),
 * `<Name>LiveActivity.swift` plus the dispatcher in the DenextWidgets extension (created when
 * absent), NSSupportsLiveActivities in the app's Info.plist, and the DenextLiveActivity plugin.
 * Android is skipped: the JS API rejects there with code `unsupported`. Idempotent.
 *
 * @param opts The project directory, App Group and Live Activity names.
 * @returns What was written, kept, and left to do by hand.
 */
export async function addLiveActivitiesToProject(
  opts: AppExtensionOptions,
): Promise<NativeInstallReport> {
  const names = checkExtensionNames(opts.names, "live-activity");
  const inst = newInstaller(opts);
  await installLiveActivitiesIos(inst, names);
  inst.report.skipped.push(
    "Android: Live Activities are iOS only (startLiveActivity rejects with code unsupported).",
  );
  return inst.report;
}
