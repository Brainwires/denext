// What denext's native-plugin installers share (`denext mobile add-ota`, `denext mobile add
// auth-session` and the app extensions: share-extension, widget, live-activity): writing template files that are upgraded in place while
// unedited and kept once edited, and registering the plugins with Capacitor.
//
// Registration. iOS: an app-local plugin is registered from a `CAPBridgeViewController`
// subclass, `DenextBridgeViewController.swift`, which the storyboard and SceneDelegate are
// pointed at. Android: from `MainActivity.onCreate`, before `super.onCreate` builds the bridge.
// Both files are shared by every denext native feature, so their content is composed from the
// features installed (whichever installer runs, and in whichever order), under a marker line
// (see native-template-marker.ts), and an unedited composed file (any combination, this
// release's or an earlier one's) is rewritten when a feature is added. An edited one is kept
// and reported.

import { join, relative } from "@std/path";
import {
  markedTemplateIntact,
  renderMarkedTemplate,
  sha256Text,
} from "./native-template-marker.ts";
import {
  isPristineOtaTemplate,
  OTA_IOS_FILES,
  OTA_TEMPLATE_VERSION,
  renderOtaTemplate,
} from "./ota-native-templates.ts";
import {
  AUTH_SESSION_BRIDGE_VIEW_CONTROLLER,
  AUTH_SESSION_TEMPLATE_VERSION,
  isPristineAuthSessionTemplate,
  renderAuthSessionTemplate,
} from "./auth-session-native-templates.ts";
import {
  APP_EXTENSION_TEMPLATE_VERSION,
  genericBridgeViewController,
  isPristineAppExtensionTemplate,
  renderAppExtensionTemplate,
} from "./app-extension-native-templates.ts";

/** A denext native feature that registers a plugin with the bridge. */
export type NativeFeature = "ota" | "auth-session" | "share-receive" | "widgets" | "live-activity";

/** Every feature, in the order the bridge view controller registers them after OTA. */
const ALL_FEATURES: readonly NativeFeature[] = [
  "ota",
  "auth-session",
  "share-receive",
  "widgets",
  "live-activity",
];

/** Every non-empty combination of `features`, for recognising a file denext composed. */
function featureSets<F extends NativeFeature>(features: readonly F[]): F[][] {
  const sets: F[][] = [];
  for (let mask = 1; mask < 1 << features.length; mask++) {
    sets.push(features.filter((_, i) => mask & (1 << i)));
  }
  return sets;
}

/** The report fields every native installer fills, as project-relative paths and notes. */
export interface NativeInstallReport {
  /** Files created or rewritten. */
  written: string[];
  /** Template files (also in `written`) upgraded from an unedited earlier denext template. */
  upgraded: string[];
  /** Template files kept because they were edited (a `manual` step says how to replace them). */
  kept: string[];
  /** Files already exactly as they would be written. */
  unchanged: string[];
  /** Steps it did not automate: each a one-line instruction. */
  manual: string[];
  /** Platforms it skipped, with the reason. */
  skipped: string[];
}

/** The options every native installer takes. */
export interface NativeInstallOptions {
  /** The Capacitor project root (holding `ios/` and/or `android/`). */
  dir: string;
  /**
   * Overwrite template files that differ from the current templates, local edits included.
   * Without it, only unedited denext templates of an earlier release are upgraded.
   */
  force?: boolean;
  /** Id generator for new pbxproj objects (tests). */
  randomId?: () => string;
}

/** The iOS app folder, relative to the project root. */
export const IOS_APP = "ios/App/App";
/** The Xcode project file, relative to the project root. */
export const PBXPROJ = "ios/App/App.xcodeproj/project.pbxproj";
const ANDROID_JAVA_ROOT = "android/app/src/main/java";
const BRIDGE_VC = "DenextBridgeViewController";
/** The shared bridge view controller's file name. */
export const BRIDGE_VC_FILE = `${BRIDGE_VC}.swift`;

/** The contents of `path`, or undefined when it does not exist. */
export async function readText(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
}

/** Whether `path` is a file. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/** The generation in `text`'s leading `family` marker line, or undefined without one. */
function markerGeneration(family: string, text: string): number | undefined {
  const m = new RegExp(`^(?://|<!--) denext-${family}-template: (\\d+) `).exec(text);
  return m ? Number(m[1]) : undefined;
}

/**
 * The marker generation of `text` when a newer denext wrote it (above what this release writes
 * for its family in `generations`), else undefined. Such a file is never rewritten: that would
 * downgrade it.
 */
function newerGeneration(
  text: string,
  generations: Readonly<Record<string, number>>,
): number | undefined {
  for (const [family, current] of Object.entries(generations)) {
    const found = markerGeneration(family, text);
    if (found !== undefined && found > current) return found;
  }
  return undefined;
}

/** The template marker families, with the generation this release writes for each. */
const TEMPLATE_GENERATIONS: Readonly<Record<string, number>> = {
  ota: OTA_TEMPLATE_VERSION,
  "auth-session": AUTH_SESSION_TEMPLATE_VERSION,
  "app-extension": APP_EXTENSION_TEMPLATE_VERSION,
};

/** The manual step for a shared file a newer denext wrote that lacks `step`'s registration. */
function newerDenextStep(rel: string, step: string): string {
  return `${rel} was written by a newer denext: upgrade denext and run this again, or ${step}`;
}

/** How a family of templates is rendered (marker line) and recognised as unedited. */
export interface TemplateKind {
  render(template: string): Promise<string>;
  isPristine(name: string, text: string): Promise<boolean>;
}

/** The OTA templates: `// denext-ota-template:` markers, plus the pre-marker shipped hashes. */
export const OTA_TEMPLATES: TemplateKind = {
  render: renderOtaTemplate,
  isPristine: isPristineOtaTemplate,
};

/** The auth-session templates: `// denext-auth-session-template:` markers. */
export const AUTH_SESSION_TEMPLATES: TemplateKind = {
  render: renderAuthSessionTemplate,
  isPristine: (_name, text) => isPristineAuthSessionTemplate(text),
};

/** The app extension templates (share, widgets, Live Activities): `denext-app-extension-template:`. */
export const APP_EXTENSION_TEMPLATES: TemplateKind = {
  render: (template) => renderAppExtensionTemplate(template),
  isPristine: (_name, text) => isPristineAppExtensionTemplate(text),
};

/** Accumulates the report while an installer runs. */
export class NativeInstaller<O extends NativeInstallOptions, R extends NativeInstallReport> {
  /** What a dry run would have written, by absolute path (read back by {@linkcode read}). */
  readonly #pending = new Map<string, string>();

  /**
   * @param opts The installer's options.
   * @param report The report to fill.
   * @param dryRun Plan only: record every write and edit in the report, change no file.
   */
  constructor(readonly opts: O, readonly report: R, readonly dryRun = false) {}

  rel(path: string): string {
    return relative(this.opts.dir, path);
  }

  /** The contents of `path` as this run left it (a dry run's pending write first). */
  async read(path: string): Promise<string | undefined> {
    return this.#pending.get(path) ?? await readText(path);
  }

  /** Write `content` to `path` (creating its folder), or only remember it in a dry run. */
  async #store(path: string, content: string): Promise<void> {
    if (this.dryRun) return void this.#pending.set(path, content);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, content);
  }

  /**
   * Write `content` to `path` unless it is already there. An existing file is replaced when
   * `force` is on or `isPristine` says it is an unedited denext file; an edited one, or one whose
   * template marker a newer denext wrote (never downgraded), is kept and reported. Returns
   * whether the file now holds `content`.
   */
  async write(
    path: string,
    content: string,
    isPristine: (existing: string) => Promise<boolean>,
  ): Promise<boolean> {
    const existing = await this.read(path);
    const rel = this.rel(path);
    if (existing === content) {
      this.report.unchanged.push(rel);
      return true;
    }
    if (existing !== undefined && !this.opts.force) {
      if (newerGeneration(existing, TEMPLATE_GENERATIONS) !== undefined) {
        this.report.kept.push(rel);
        this.report.manual.push(
          `${rel} was written by a newer denext: kept it (upgrade denext, or re-run with --force ` +
            "to replace it).",
        );
        return false;
      }
      if (!(await isPristine(existing))) {
        this.report.kept.push(rel);
        this.report.manual.push(
          `${rel} differs from denext's template (edited); kept yours (re-run with --force to replace it).`,
        );
        return false;
      }
      this.report.upgraded.push(rel);
    }
    await this.#store(path, content);
    this.report.written.push(rel);
    return true;
  }

  /** Rewrite `path` with `edit(text)`, recording it when the text changed. */
  async edit(path: string, edit: (text: string) => string): Promise<void> {
    const text = await this.read(path);
    if (text === undefined) return;
    const next = edit(text);
    if (next === text) return void this.report.unchanged.push(this.rel(path));
    await this.#store(path, next);
    this.report.written.push(this.rel(path));
  }
}

/**
 * Write the templates `files` (name → template) of `kind` into `dir`, each rendered with its
 * marker line (see {@linkcode NativeInstaller.write} for what is replaced and what is kept).
 */
export async function writeTemplates(
  inst: NativeInstaller<NativeInstallOptions, NativeInstallReport>,
  dir: string,
  files: Readonly<Record<string, string>>,
  kind: TemplateKind,
): Promise<void> {
  for (const [name, template] of Object.entries(files)) {
    await inst.write(
      join(dir, name),
      await kind.render(template),
      (text) => kind.isPristine(name, text),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// iOS: the shared bridge view controller.

/** The Swift plugin file whose presence in the app folder means a feature is installed. */
const IOS_FEATURE_FILES: Readonly<Record<NativeFeature, string>> = {
  ota: "DenextOtaPlugin.swift",
  "auth-session": "DenextAuthSessionPlugin.swift",
  "share-receive": "DenextShareReceivePlugin.swift",
  widgets: "DenextWidgetsPlugin.swift",
  "live-activity": "DenextLiveActivityPlugin.swift",
};

/** Where the OTA bridge view controller registers its plugin; the others go after it. */
const OTA_REGISTRATION = "        bridge?.registerPluginInstance(plugin)\n";

/** Each non-OTA feature's registration lines in `capacitorDidLoad()`. */
const IOS_REGISTRATIONS: Readonly<Record<Exclude<NativeFeature, "ota">, string>> = {
  "auth-session": "        // denext auth sessions: openAuthSession() in denext/mobile.\n" +
    "        bridge?.registerPluginInstance(DenextAuthSessionPlugin())\n",
  "share-receive": "        // denext share extension: onShareReceived() in denext/mobile.\n" +
    "        bridge?.registerPluginInstance(DenextShareReceivePlugin())\n",
  widgets: "        // denext widgets: setWidgetData() / reloadWidgets() in denext/mobile.\n" +
    "        bridge?.registerPluginInstance(DenextWidgetsPlugin())\n",
  "live-activity": "        // denext Live Activities: startLiveActivity() in denext/mobile.\n" +
    "        bridge?.registerPluginInstance(DenextLiveActivityPlugin())\n",
};

/** The registration lines of the non-OTA features in `features`, in their fixed order. */
function registrationLines(features: ReadonlySet<NativeFeature>): string {
  return ALL_FEATURES.filter((f): f is Exclude<NativeFeature, "ota"> =>
    f !== "ota" && features.has(f)
  ).map((f) => IOS_REGISTRATIONS[f]).join("");
}

/**
 * `DenextBridgeViewController.swift` for `features`, marker line included: OTA alone is the OTA
 * template exactly; OTA with other features is that template also registering their plugins;
 * auth sessions alone is the auth-session registering-only controller; any other set without
 * OTA is the app-extension registering-only controller.
 *
 * @param features The installed features (at least one).
 * @returns The file content.
 */
export async function bridgeViewControllerSource(
  features: ReadonlySet<NativeFeature>,
): Promise<string> {
  const ota = OTA_IOS_FILES[BRIDGE_VC_FILE];
  const others = registrationLines(features);
  if (!features.has("ota")) {
    if (features.size === 1 && features.has("auth-session")) {
      return await renderAuthSessionTemplate(AUTH_SESSION_BRIDGE_VIEW_CONTROLLER);
    }
    return await renderAppExtensionTemplate(genericBridgeViewController(others));
  }
  if (others === "") return await renderOtaTemplate(ota);
  if (!ota.includes(OTA_REGISTRATION)) {
    throw new Error(`${BRIDGE_VC_FILE}: the OTA template has no plugin registration to extend`);
  }
  return await renderOtaTemplate(ota.replace(OTA_REGISTRATION, OTA_REGISTRATION + others));
}

/** Whether a bridge view controller is an unedited denext one (any marker family). */
async function isPristineBridge(text: string): Promise<boolean> {
  return await isPristineOtaTemplate(BRIDGE_VC_FILE, text) ||
    await isPristineAuthSessionTemplate(text) || await isPristineAppExtensionTemplate(text);
}

/** Whether `text` is this release's bridge view controller for some feature combination. */
async function isCurrentBridge(text: string): Promise<boolean> {
  for (const set of featureSets(ALL_FEATURES)) {
    if (text === await bridgeViewControllerSource(new Set(set))) return true;
  }
  return false;
}

/** The features installed on iOS (their plugin file is in the app folder), plus `including`. */
async function iosFeatures(root: string, including: NativeFeature): Promise<Set<NativeFeature>> {
  const features = new Set<NativeFeature>([including]);
  for (const [feature, file] of Object.entries(IOS_FEATURE_FILES)) {
    if (await isFile(join(root, IOS_APP, file))) features.add(feature as NativeFeature);
  }
  return features;
}

/**
 * Write `DenextBridgeViewController.swift` registering every installed feature's plugin (see
 * {@linkcode bridgeViewControllerSource}). An edited controller is kept; when it does not
 * register `including`'s plugin, `registration` is reported as the manual step.
 */
export async function installBridgeViewController(
  inst: NativeInstaller<NativeInstallOptions, NativeInstallReport>,
  including: NativeFeature,
  registration: { needle: string; step: string },
): Promise<void> {
  const root = inst.opts.dir;
  const path = join(root, IOS_APP, BRIDGE_VC_FILE);
  const features = await iosFeatures(root, including);
  const existing = await inst.read(path);
  // A bridge a newer denext wrote is never downgraded (as if edited; --force still replaces it).
  if (
    existing !== undefined && !inst.opts.force &&
    newerGeneration(existing, TEMPLATE_GENERATIONS) !== undefined
  ) {
    const rel = inst.rel(path);
    if (existing.includes(registration.needle)) return void inst.report.unchanged.push(rel);
    inst.report.kept.push(rel);
    inst.report.manual.push(newerDenextStep(rel, registration.step));
    return;
  }
  // An OTA bridge from an earlier denext goes with that release's OTA files: only `add-ota`
  // upgrades them together, so another installer leaves it (the current OTA bridge may call
  // what the older OTA files lack).
  if (
    including !== "ota" && features.has("ota") && existing !== undefined && !inst.opts.force &&
    !(await isCurrentBridge(existing))
  ) {
    inst.report.kept.push(inst.rel(path));
    inst.report.manual.push(
      `${inst.rel(path)} is not the current denext template: run \`denext mobile add-ota\` ` +
        "first (it upgrades the OTA files together), then run this again.",
    );
    return;
  }
  const content = await bridgeViewControllerSource(features);
  if (await inst.write(path, content, isPristineBridge)) return;
  if (!((await inst.read(path)) ?? "").includes(registration.needle)) {
    inst.report.manual.push(`${inst.rel(path)}: ${registration.step}`);
  }
}

/** `customClass="CAPBridgeViewController"` plus its `customModule="Capacitor"`. */
const STORYBOARD_STOCK =
  /customClass="CAPBridgeViewController"(?:\s+customModule="Capacitor")?(?:\s+customModuleProvider="[^"]*")?/;

/** Point Main.storyboard at the bridge subclass while it still names the stock one. */
async function wireStoryboard(
  inst: NativeInstaller<NativeInstallOptions, NativeInstallReport>,
  root: string,
): Promise<void> {
  const path = join(root, IOS_APP, "Base.lproj", "Main.storyboard");
  const text = await readText(path);
  if (text === undefined || text.includes(`customClass="${BRIDGE_VC}"`)) return;
  if (STORYBOARD_STOCK.test(text)) {
    await inst.edit(path, (t) =>
      t.replace(
        STORYBOARD_STOCK,
        `customClass="${BRIDGE_VC}" customModule="App" customModuleProvider="target"`,
      ));
    return;
  }
  const custom = /customClass="([^"]+)"/.exec(text)?.[1];
  // A custom bridge subclass in the app folder was already reported with its fix, and one
  // that already subclasses the bridge needs nothing.
  const reported = inst.report.manual.some((m) => m.includes(`class ${custom}:`));
  if (custom && !reported && !(await subclassesBridge(root, custom))) {
    inst.report.manual.push(
      `Main.storyboard uses ${custom}: make ${custom} a subclass of ${BRIDGE_VC}.`,
    );
  }
}

/** Whether a Swift file in the app folder declares `class <name>: DenextBridgeViewController`. */
async function subclassesBridge(root: string, name: string): Promise<boolean> {
  const dir = join(root, IOS_APP);
  const declaration = new RegExp(`\\bclass\\s+${name}\\s*:\\s*${BRIDGE_VC}\\b`);
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".swift")) continue;
    if (declaration.test(await Deno.readTextFile(join(dir, entry.name)))) return true;
  }
  return false;
}

/** Point SceneDelegate's root view controller at the bridge subclass while it is stock. */
async function wireSceneDelegate(
  inst: NativeInstaller<NativeInstallOptions, NativeInstallReport>,
  root: string,
): Promise<void> {
  const path = join(root, IOS_APP, "SceneDelegate.swift");
  await inst.edit(
    path,
    (t) => t.replace(/\bCAPBridgeViewController\(\)/g, `${BRIDGE_VC}()`),
  );
}

/** Report every app-side `CAPBridgeViewController` subclass: its superclass must change. */
async function reportBridgeSubclasses(
  inst: NativeInstaller<NativeInstallOptions, NativeInstallReport>,
  root: string,
): Promise<void> {
  const dir = join(root, IOS_APP);
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".swift") || entry.name === BRIDGE_VC_FILE) continue;
    const text = await Deno.readTextFile(join(dir, entry.name));
    for (const m of text.matchAll(/\bclass\s+(\w+)\s*:\s*CAPBridgeViewController\b/g)) {
      inst.report.manual.push(
        `${IOS_APP}/${entry.name}: change \`class ${m[1]}: CAPBridgeViewController\` to \`class ${
          m[1]
        }: ${BRIDGE_VC}\` (and call super from any instanceDescriptor()/capacitorDidLoad() override).`,
      );
    }
  }
}

/**
 * Make the app use `DenextBridgeViewController`: report app-side `CAPBridgeViewController`
 * subclasses, and switch a stock storyboard and SceneDelegate over.
 */
export async function wireBridgeViewController(
  inst: NativeInstaller<NativeInstallOptions, NativeInstallReport>,
): Promise<void> {
  const root = inst.opts.dir;
  await reportBridgeSubclasses(inst, root);
  await wireStoryboard(inst, root);
  await wireSceneDelegate(inst, root);
}

// ---------------------------------------------------------------------------------------------
// Android: MainActivity.

/** The stock Capacitor `MainActivity.java`: a bare `extends BridgeActivity {}`. */
const STOCK_MAIN_ACTIVITY =
  /^\s*package\s+([\w.]+)\s*;\s*import\s+com\.getcapacitor\.BridgeActivity\s*;\s*public\s+class\s+MainActivity\s+extends\s+BridgeActivity\s*\{\s*\}\s*$/;

/** The features that register an Android plugin (Live Activities are iOS only). */
export type AndroidFeature = Exclude<NativeFeature, "live-activity">;

/** A plain `registerPlugin(<cls>.class)` registration of a plugin in package `pkg`. */
function pluginRegistration(pkg: string, cls: string, what: string) {
  return {
    import: `import ${pkg}.${cls};\n`,
    lines: `        // ${what}. It must run before super.onCreate, which builds the bridge.\n` +
      `        registerPlugin(${cls}.class);\n`,
    call: `${cls}.class`,
    step: `call \`registerPlugin(${cls}.class);\` (import ${pkg}.${cls}) in ` +
      "MainActivity.onCreate, before super.onCreate.",
  };
}

/** What each feature adds to MainActivity: an import, the onCreate lines, and its call. */
const ANDROID_REGISTRATIONS: Readonly<
  Record<AndroidFeature, { import: string; lines: string; call: string; step: string }>
> = {
  "share-receive": pluginRegistration(
    "dev.denext.sharereceive",
    "DenextShareReceivePlugin",
    "denext share target: registers the DenextShareReceive plugin (onShareReceived in\n" +
      "        // denext/mobile)",
  ),
  widgets: pluginRegistration(
    "dev.denext.widgets",
    "DenextWidgetsPlugin",
    "denext widgets: registers the DenextWidgets plugin (setWidgetData in denext/mobile)",
  ),
  "auth-session": {
    import: "import dev.denext.authsession.DenextAuthSessionPlugin;\n",
    lines:
      "        // denext auth sessions: registers the DenextAuthSession plugin (openAuthSession in\n" +
      "        // denext/mobile). It must run before super.onCreate, which builds the bridge.\n" +
      "        registerPlugin(DenextAuthSessionPlugin.class);\n",
    call: "DenextAuthSessionPlugin.class",
    step: "call `registerPlugin(DenextAuthSessionPlugin.class);` (import " +
      "dev.denext.authsession.DenextAuthSessionPlugin) in MainActivity.onCreate, before super.onCreate.",
  },
  ota: {
    import: "import dev.denext.ota.DenextOta;\n",
    lines:
      "        // denext over-the-air UI: registers the DenextOta plugin and picks the UI to start\n" +
      "        // from. It must run before super.onCreate, which builds the bridge.\n" +
      "        DenextOta.prepare(this, bridgeBuilder);\n",
    call: "DenextOta.prepare(",
    step: "call `DenextOta.prepare(this, bridgeBuilder);` (import dev.denext.ota.DenextOta) " +
      "first thing in MainActivity.onCreate, before super.onCreate.",
  },
};

/**
 * The features in their MainActivity import order; onCreate registers them in reverse, so OTA's
 * `prepare` stays first thing. The newer features come first, which keeps the body of what
 * earlier releases wrote for OTA and auth sessions the same.
 */
const FEATURE_ORDER: readonly AndroidFeature[] = [
  "share-receive",
  "widgets",
  "auth-session",
  "ota",
];

/** The marker family of a MainActivity denext composed: `// denext-main-activity-template:`. */
const MAIN_ACTIVITY_FAMILY = "main-activity";
/** The generation of {@linkcode mainActivitySource}'s text, stamped into its marker line. */
const MAIN_ACTIVITY_TEMPLATE_VERSION = 1;

/**
 * SHA-256 of every MainActivity denext wrote before the marker line existed, with the package
 * line normalised to `package PKG;` (see {@linkcode normalizedPackage}): the OTA-only activity
 * of v2.7.0 … v2.9.0 (`preparedMainActivity` in mobile-ota-install.ts), and
 * `mainActivitySource` for every feature combination of v2.10.0-rc.1 / rc.2 (OTA, auth
 * sessions) and v2.10.0-rc.3 (plus share-receive and widgets). The text never changed between
 * those tags, so each combination has one hash. A file equal to one of them is unedited.
 */
const SHIPPED_MAIN_ACTIVITY_SHA256: readonly string[] = [
  "2d3341402b008db857d0ad376dad06dcb50464ec3f2cb8f9eace3f96338bec37", // ota
  "a31a00132ce0134fca1e5e654956567e6f7d2cc401c1386fd8b741ce1c3b380c", // auth-session
  "83c0722f6b0e921d65965848ec6a7c5d79cfada73b88293e0f723c451b145083", // auth-session+ota
  "221f4cfe7f8e5663e833dfa306010550572ddf745ae4b918d76892fc0c82613a", // share-receive
  "2454f88c67da50bda67aa003e9142959feffd6ab9b1a53c21caadbd5c626b980", // widgets
  "af2709906b97f27f3fa23467f07f823c6dc2cb26561fad456e24e177c3e8d09a", // share-receive+widgets
  "7c41a59cb2d6907f065507050ec8ce88aefff0027e4b928703d225f6fdf11ec3", // share-receive+auth-session
  "3fb7afa42eccddfb7470f2c5fab1e606916529c20d3e8b1d33a2d99b0f9e1c5b", // widgets+auth-session
  "40f11d4532cbe208715c48932d9fe05ec23a71dd419c500822ef07d59aa8025c", // share+widgets+auth
  "75b84fb0cd554c43dfefaa3ea1cb5b74ec064c54b570a7e2ee45c40a205c46fe", // share-receive+ota
  "821f931afa5b88adc0a792c0d738ee999ad304d72cec5333aa03e9a59cab85b1", // widgets+ota
  "a114f08eb13e92205187e2cd140e2db080bbbb5aff0e8ce3499e5873b74c155d", // share+widgets+ota
  "c2733f54637ec2a8cba871e77179563ec576241d2085eb8d4b8bf08991c7d5e7", // share+auth+ota
  "6f06a5fbdb1ed9459e774665fe81301b3dd0e6237bedc9b3ce4b70139f76ed0c", // widgets+auth+ota
  "24b5ef26fcd8d7d70ac6f3e188ca4f3bce2b1dced99a6ff1326cfbe5cd06a04f", // all four
];

/** `text` with its leading `package <name>;` replaced by `package PKG;`, for hashing. */
function normalizedPackage(text: string): string {
  return text.replace(/^package\s+[\w.]+\s*;/, "package PKG;");
}

/**
 * A `MainActivity` that registers `features` before the bridge is built (OTA first in onCreate,
 * so its `prepare` still runs first thing), under a `// denext-main-activity-template:` marker
 * line, so a later release still recognises it as unedited after the text changes.
 *
 * @param pkg The activity's Java package.
 * @param features The features to register (at least one).
 * @returns The Java source, marker line included.
 */
export function mainActivitySource(
  pkg: string,
  features: ReadonlySet<AndroidFeature>,
): Promise<string> {
  const chosen = FEATURE_ORDER.filter((f) => features.has(f));
  const imports = chosen.map((f) => ANDROID_REGISTRATIONS[f].import).join("");
  const lines = [...chosen].reverse().map((f) => ANDROID_REGISTRATIONS[f].lines).join("");
  return renderMarkedTemplate(
    MAIN_ACTIVITY_FAMILY,
    MAIN_ACTIVITY_TEMPLATE_VERSION,
    `package ${pkg};

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
${imports}
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
${lines}        super.onCreate(savedInstanceState);
    }
}
`,
  );
}

/** Whether `text` is a MainActivity denext composed and nobody edited (marker or shipped hash). */
async function isPristineMainActivity(text: string): Promise<boolean> {
  const marked = await markedTemplateIntact(MAIN_ACTIVITY_FAMILY, text);
  if (marked !== undefined) return marked;
  return SHIPPED_MAIN_ACTIVITY_SHA256.includes(await sha256Text(normalizedPackage(text)));
}

/**
 * The features an unedited denext MainActivity registers, or undefined when it also registers a
 * plugin this release does not know (a newer release's feature, which a rewrite would drop).
 */
function registeredFeatures(text: string): AndroidFeature[] | undefined {
  const known = new Set(FEATURE_ORDER.map((f) => ANDROID_REGISTRATIONS[f].call));
  for (const m of text.matchAll(/registerPlugin\(\s*(\w+)\.class\s*\)/g)) {
    if (!known.has(`${m[1]}.class`)) return undefined;
  }
  return FEATURE_ORDER.filter((f) => text.includes(ANDROID_REGISTRATIONS[f].call));
}

/**
 * The package and registered features of a MainActivity denext can rewrite: the stock one (no
 * features), or an unedited one denext composed (this release or an earlier one). Undefined
 * for anything else.
 */
async function recognizeMainActivity(
  text: string,
): Promise<{ pkg: string; features: AndroidFeature[] } | undefined> {
  const stock = STOCK_MAIN_ACTIVITY.exec(text);
  if (stock) return { pkg: stock[1], features: [] };
  const pkg = /^package\s+([\w.]+)\s*;/m.exec(text)?.[1];
  if (pkg === undefined || !(await isPristineMainActivity(text))) return undefined;
  const features = registeredFeatures(text);
  return features ? { pkg, features } : undefined;
}

/** Every `MainActivity.java`/`.kt` under `dir`, as absolute paths. */
async function findMainActivities(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory) out.push(...await findMainActivities(path));
      else if (entry.name === "MainActivity.java" || entry.name === "MainActivity.kt") {
        out.push(path);
      }
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return out;
}

/**
 * Make `MainActivity` register `feature`'s plugin. A stock activity, or an unedited one denext
 * wrote (this release or an earlier one), is rewritten to the current source registering them
 * all; an edited one that already registers `feature` is left alone, and any other becomes a
 * manual step.
 */
export async function registerInMainActivity(
  inst: NativeInstaller<NativeInstallOptions, NativeInstallReport>,
  feature: AndroidFeature,
): Promise<void> {
  const root = inst.opts.dir;
  const activities = await findMainActivities(join(root, ANDROID_JAVA_ROOT));
  const { call, step } = ANDROID_REGISTRATIONS[feature];
  if (activities.length !== 1) {
    inst.report.manual.push(`Android: ${step}`);
    return;
  }
  const path = activities[0];
  const text = (await inst.read(path)) ?? "";
  // One a newer denext wrote is never downgraded: it is treated like an edited one.
  if (
    newerGeneration(text, { [MAIN_ACTIVITY_FAMILY]: MAIN_ACTIVITY_TEMPLATE_VERSION }) !== undefined
  ) {
    if (text.includes(call)) return void inst.report.unchanged.push(inst.rel(path));
    inst.report.manual.push(newerDenextStep(inst.rel(path), step));
    return;
  }
  const known = path.endsWith(".java") ? await recognizeMainActivity(text) : undefined;
  if (!known) {
    if (text.includes(call)) return void inst.report.unchanged.push(inst.rel(path));
    inst.report.manual.push(`${inst.rel(path)}: ${step}`);
    return;
  }
  const current = await mainActivitySource(known.pkg, new Set(known.features));
  // An unedited activity from an earlier release (the text or the marker generation changed).
  if (known.features.length > 0 && text !== current) inst.report.upgraded.push(inst.rel(path));
  const next = await mainActivitySource(known.pkg, new Set([...known.features, feature]));
  await inst.edit(path, () => next);
}

/** Whether the project has `android/app/src/main`; records the skip when it does not. */
export async function hasAndroidApp(
  inst: NativeInstaller<NativeInstallOptions, NativeInstallReport>,
): Promise<boolean> {
  try {
    await Deno.stat(join(inst.opts.dir, "android", "app", "src", "main"));
    return true;
  } catch {
    inst.report.skipped.push("Android: no android/app/src/main (run `cap add android` first).");
    return false;
  }
}

/** Whether the project has an Xcode project; records the skip when it does not. */
export async function hasIosApp(
  inst: NativeInstaller<NativeInstallOptions, NativeInstallReport>,
): Promise<boolean> {
  if (await isFile(join(inst.opts.dir, PBXPROJ))) return true;
  inst.report.skipped.push(`iOS: no ${PBXPROJ} (run \`cap add ios\` first).`);
  return false;
}
