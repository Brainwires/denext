// What denext's native-plugin installers share (`denext mobile add-ota` and
// `denext mobile add auth-session`): writing template files that are upgraded in place while
// unedited and kept once edited, and registering the plugins with Capacitor.
//
// Registration. iOS: an app-local plugin is registered from a `CAPBridgeViewController`
// subclass, `DenextBridgeViewController.swift`, which the storyboard and SceneDelegate are
// pointed at. Android: from `MainActivity.onCreate`, before `super.onCreate` builds the bridge.
// Both files are shared by every denext native feature, so their content is composed from the
// features installed (whichever installer runs, and in whichever order): the OTA-only
// versions are byte-for-byte what `add-ota` always wrote, and an unedited composed file (any
// combination) is rewritten when a feature is added. An edited one is kept and reported.

import { join, relative } from "@std/path";
import { isPristineOtaTemplate, OTA_IOS_FILES, renderOtaTemplate } from "./ota-native-templates.ts";
import {
  AUTH_SESSION_BRIDGE_VIEW_CONTROLLER,
  isPristineAuthSessionTemplate,
  renderAuthSessionTemplate,
} from "./auth-session-native-templates.ts";

/** A denext native feature that registers a plugin with the bridge. */
export type NativeFeature = "ota" | "auth-session";

/** Every non-empty feature combination, for recognising a file denext composed. */
const FEATURE_SETS: readonly (readonly NativeFeature[])[] = [
  ["ota"],
  ["auth-session"],
  ["ota", "auth-session"],
];

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

/** Accumulates the report while an installer runs. */
export class NativeInstaller<O extends NativeInstallOptions, R extends NativeInstallReport> {
  constructor(readonly opts: O, readonly report: R) {}

  rel(path: string): string {
    return relative(this.opts.dir, path);
  }

  /**
   * Write `content` to `path` unless it is already there. An existing file is replaced when
   * `force` is on or `isPristine` says it is an unedited denext file; an edited one is kept and
   * reported. Returns whether the file now holds `content`.
   */
  async write(
    path: string,
    content: string,
    isPristine: (existing: string) => Promise<boolean>,
  ): Promise<boolean> {
    const existing = await readText(path);
    const rel = this.rel(path);
    if (existing === content) {
      this.report.unchanged.push(rel);
      return true;
    }
    if (existing !== undefined && !this.opts.force) {
      if (!(await isPristine(existing))) {
        this.report.kept.push(rel);
        this.report.manual.push(
          `${rel} differs from denext's template (edited); kept yours (re-run with --force to replace it).`,
        );
        return false;
      }
      this.report.upgraded.push(rel);
    }
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, content);
    this.report.written.push(rel);
    return true;
  }

  /** Rewrite `path` with `edit(text)`, recording it when the text changed. */
  async edit(path: string, edit: (text: string) => string): Promise<void> {
    const text = await readText(path);
    if (text === undefined) return;
    const next = edit(text);
    if (next === text) return void this.report.unchanged.push(this.rel(path));
    await Deno.writeTextFile(path, next);
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
};

/** Where the OTA bridge view controller registers its plugin; auth sessions go after it. */
const OTA_REGISTRATION = "        bridge?.registerPluginInstance(plugin)\n";
const AUTH_REGISTRATION = "        // denext auth sessions: openAuthSession() in denext/mobile.\n" +
  "        bridge?.registerPluginInstance(DenextAuthSessionPlugin())\n";

/**
 * `DenextBridgeViewController.swift` for `features`, marker line included: OTA alone is the OTA
 * template exactly; OTA with auth sessions is that template also registering
 * `DenextAuthSessionPlugin`; auth sessions alone is the small registering-only controller.
 *
 * @param features The installed features (at least one).
 * @returns The file content.
 */
export async function bridgeViewControllerSource(
  features: ReadonlySet<NativeFeature>,
): Promise<string> {
  const ota = OTA_IOS_FILES[BRIDGE_VC_FILE];
  if (!features.has("ota")) {
    return await renderAuthSessionTemplate(AUTH_SESSION_BRIDGE_VIEW_CONTROLLER);
  }
  if (!features.has("auth-session")) return await renderOtaTemplate(ota);
  if (!ota.includes(OTA_REGISTRATION)) {
    throw new Error(`${BRIDGE_VC_FILE}: the OTA template has no plugin registration to extend`);
  }
  return await renderOtaTemplate(
    ota.replace(OTA_REGISTRATION, OTA_REGISTRATION + AUTH_REGISTRATION),
  );
}

/** Whether a bridge view controller is an unedited denext one (either marker family). */
async function isPristineBridge(text: string): Promise<boolean> {
  return await isPristineOtaTemplate(BRIDGE_VC_FILE, text) ||
    await isPristineAuthSessionTemplate(text);
}

/** Whether `text` is this release's bridge view controller for some feature combination. */
async function isCurrentBridge(text: string): Promise<boolean> {
  for (const set of FEATURE_SETS) {
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
  const existing = await readText(path);
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
  if (!((await readText(path)) ?? "").includes(registration.needle)) {
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

/** What each feature adds to MainActivity: an import, the onCreate lines, and its call. */
const ANDROID_REGISTRATIONS: Readonly<
  Record<NativeFeature, { import: string; lines: string; call: string; step: string }>
> = {
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

/** The features in their MainActivity order (imports sort the same way). */
const FEATURE_ORDER: readonly NativeFeature[] = ["auth-session", "ota"];

/**
 * A `MainActivity` that registers `features` before the bridge is built (OTA first in onCreate,
 * so its `prepare` still runs first thing). OTA alone is exactly what `add-ota` always wrote.
 *
 * @param pkg The activity's Java package.
 * @param features The features to register (at least one).
 * @returns The Java source.
 */
export function mainActivitySource(pkg: string, features: ReadonlySet<NativeFeature>): string {
  const chosen = FEATURE_ORDER.filter((f) => features.has(f));
  const imports = chosen.map((f) => ANDROID_REGISTRATIONS[f].import).join("");
  const lines = [...chosen].reverse().map((f) => ANDROID_REGISTRATIONS[f].lines).join("");
  return `package ${pkg};

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
${imports}
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
${lines}        super.onCreate(savedInstanceState);
    }
}
`;
}

/**
 * The package and registered features of a MainActivity denext can rewrite: the stock one (no
 * features), or one written by {@linkcode mainActivitySource}. Undefined for anything else.
 */
function recognizeMainActivity(
  text: string,
): { pkg: string; features: NativeFeature[] } | undefined {
  const stock = STOCK_MAIN_ACTIVITY.exec(text);
  if (stock) return { pkg: stock[1], features: [] };
  const pkg = /^package\s+([\w.]+)\s*;/.exec(text)?.[1];
  if (pkg === undefined) return undefined;
  const set = FEATURE_SETS.find((s) => mainActivitySource(pkg, new Set(s)) === text);
  return set ? { pkg, features: [...set] } : undefined;
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
 * Make `MainActivity` register `feature`'s plugin. A stock activity, or one denext wrote for
 * other features, is rewritten to register them all; anything else becomes a manual step.
 */
export async function registerInMainActivity(
  inst: NativeInstaller<NativeInstallOptions, NativeInstallReport>,
  feature: NativeFeature,
): Promise<void> {
  const root = inst.opts.dir;
  const activities = await findMainActivities(join(root, ANDROID_JAVA_ROOT));
  const { call, step } = ANDROID_REGISTRATIONS[feature];
  if (activities.length !== 1) {
    inst.report.manual.push(`Android: ${step}`);
    return;
  }
  const path = activities[0];
  const text = await Deno.readTextFile(path);
  if (text.includes(call)) return void inst.report.unchanged.push(inst.rel(path));
  const known = path.endsWith(".java") ? recognizeMainActivity(text) : undefined;
  if (!known) {
    inst.report.manual.push(`${inst.rel(path)}: ${step}`);
    return;
  }
  await inst.edit(path, () => mainActivitySource(known.pkg, new Set([...known.features, feature])));
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
