// `denext mobile add-ota [dir]`: retrofit denext's over-the-air UI updates into an existing
// Capacitor project. It writes the native templates (src/build/ota-native-templates.ts),
// adds the Swift files to the Xcode app target (src/build/pbxproj.ts), points the storyboard
// and SceneDelegate at `DenextBridgeViewController` while they still name the stock
// `CAPBridgeViewController`, and rewrites a stock `MainActivity`. With a public key it also
// embeds the OTA signature key (Info.plist `DenextOtaPublicKey`, AndroidManifest meta-data
// `dev.denext.ota.PUBLIC_KEY`), replacing an earlier one. Anything customised is left alone
// and reported as a one-line manual step. Running it twice changes nothing.

import { join, relative } from "@std/path";
import { addSourceFiles } from "./pbxproj.ts";
import { OTA_ANDROID_FILES, OTA_IOS_FILES } from "./ota-native-templates.ts";

/** Options for {@linkcode addOtaToProject}. */
export interface AddOtaOptions {
  /** The Capacitor project root (holding `ios/` and/or `android/`). */
  dir: string;
  /** Overwrite template files that differ from the current templates (local edits are lost). */
  force?: boolean;
  /** Id generator for new pbxproj objects (tests). */
  randomId?: () => string;
  /**
   * The OTA signature public key as one-line base64 SPKI (already validated, e.g. by
   * `parseOtaPublicKey`). Embedded in Info.plist and AndroidManifest.xml, replacing an
   * earlier value; left out, neither file is touched.
   */
  publicKey?: string;
}

/** What {@linkcode addOtaToProject} did, as project-relative paths and one-line notes. */
export interface AddOtaReport {
  /** Files created or rewritten. */
  written: string[];
  /** Files already exactly as they would be written. */
  unchanged: string[];
  /** Steps it did not automate: each a one-line instruction. */
  manual: string[];
  /** Platforms it skipped, with the reason. */
  skipped: string[];
}

/** The iOS app folder, relative to the project root. */
const IOS_APP = "ios/App/App";
const PBXPROJ = "ios/App/App.xcodeproj/project.pbxproj";
/** The Android package the templates use (kept apart from the app's own package). */
const ANDROID_OTA_DIR = "android/app/src/main/java/dev/denext/ota";
const ANDROID_JAVA_ROOT = "android/app/src/main/java";
const BRIDGE_VC = "DenextBridgeViewController";

async function readText(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/** Accumulates the report while the installer runs. */
class Installer {
  readonly report: AddOtaReport = { written: [], unchanged: [], manual: [], skipped: [] };
  constructor(readonly opts: AddOtaOptions) {}

  rel(path: string): string {
    return relative(this.opts.dir, path);
  }

  /** Write a template file unless it is already current (or differs and `force` is off). */
  async template(path: string, content: string): Promise<void> {
    const existing = await readText(path);
    if (existing === content) return void this.report.unchanged.push(this.rel(path));
    if (existing !== undefined && !this.opts.force) {
      this.report.manual.push(
        `${
          this.rel(path)
        } differs from denext's template; kept yours (re-run with --force to replace it).`,
      );
      return;
    }
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, content);
    this.report.written.push(this.rel(path));
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

/** `customClass="CAPBridgeViewController"` plus its `customModule="Capacitor"`. */
const STORYBOARD_STOCK =
  /customClass="CAPBridgeViewController"(?:\s+customModule="Capacitor")?(?:\s+customModuleProvider="[^"]*")?/;

/** Point Main.storyboard at the bridge subclass while it still names the stock one. */
async function wireStoryboard(inst: Installer, root: string): Promise<void> {
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
async function wireSceneDelegate(inst: Installer, root: string): Promise<void> {
  const path = join(root, IOS_APP, "SceneDelegate.swift");
  await inst.edit(
    path,
    (t) => t.replace(/\bCAPBridgeViewController\(\)/g, `${BRIDGE_VC}()`),
  );
}

/** Report every app-side `CAPBridgeViewController` subclass: its superclass must change. */
async function reportBridgeSubclasses(inst: Installer, root: string): Promise<void> {
  const dir = join(root, IOS_APP);
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".swift") || entry.name in OTA_IOS_FILES) continue;
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

/** The Info.plist key the iOS plugin reads its OTA public key from. */
const IOS_PUBLIC_KEY_KEY = "DenextOtaPublicKey";
/** The `<meta-data>` name the Android plugin reads its OTA public key from. */
const ANDROID_PUBLIC_KEY_META = "dev.denext.ota.PUBLIC_KEY";

const PLIST_PUBLIC_KEY = new RegExp(
  `<key>${IOS_PUBLIC_KEY_KEY}</key>\\s*<string>[^<]*</string>`,
);

/** `plist` with `DenextOtaPublicKey` set to `key`, or null when it has no top-level dict. */
function withPlistPublicKey(plist: string, key: string): string | null {
  const entry = `<key>${IOS_PUBLIC_KEY_KEY}</key>\n\t<string>${key}</string>`;
  if (PLIST_PUBLIC_KEY.test(plist)) return plist.replace(PLIST_PUBLIC_KEY, entry);
  const end = plist.lastIndexOf("</dict>");
  if (end < 0 || !plist.slice(end).includes("</plist>")) return null;
  const lineStart = plist.lastIndexOf("\n", end - 1) + 1;
  // A `</dict>` on a line of its own gets the entry on the lines above it.
  if (plist.slice(lineStart, end).trim() === "") {
    return `${plist.slice(0, lineStart)}\t${entry}\n${plist.slice(lineStart)}`;
  }
  return `${plist.slice(0, end)}\t${entry}\n${plist.slice(end)}`;
}

const MANIFEST_PUBLIC_KEY = new RegExp(
  `<meta-data\\b[^>]*android:name="${ANDROID_PUBLIC_KEY_META.replaceAll(".", "\\.")}"[^>]*/>`,
);

/** `manifest` with the public-key `<meta-data>` set to `key`, or null without `</application>`. */
function withManifestPublicKey(manifest: string, key: string): string | null {
  const element = `<meta-data android:name="${ANDROID_PUBLIC_KEY_META}" android:value="${key}" />`;
  if (MANIFEST_PUBLIC_KEY.test(manifest)) return manifest.replace(MANIFEST_PUBLIC_KEY, element);
  const end = manifest.lastIndexOf("</application>");
  if (end < 0) return null;
  const lineStart = manifest.lastIndexOf("\n", end - 1) + 1;
  const indent = manifest.slice(lineStart, end);
  if (indent.trim() !== "") return `${manifest.slice(0, end)}${element}\n${manifest.slice(end)}`;
  return `${manifest.slice(0, lineStart)}${indent}    ${element}\n${manifest.slice(lineStart)}`;
}

/** Embed `key` with `inject`, or report `step` as manual when the file has no place for it. */
async function embedPublicKey(
  inst: Installer,
  path: string,
  inject: (text: string, key: string) => string | null,
  step: string,
): Promise<void> {
  const key = inst.opts.publicKey;
  if (key === undefined) return;
  const text = await readText(path);
  const next = text === undefined ? null : inject(text, key);
  if (next === null) return void inst.report.manual.push(`${inst.rel(path)}: ${step}`);
  await inst.edit(path, () => next);
}

async function installIos(inst: Installer): Promise<void> {
  const root = inst.opts.dir;
  const pbxprojPath = join(root, PBXPROJ);
  if (!(await isFile(pbxprojPath))) {
    inst.report.skipped.push(`iOS: no ${PBXPROJ} (run \`cap add ios\` first).`);
    return;
  }
  for (const [name, content] of Object.entries(OTA_IOS_FILES)) {
    await inst.template(join(root, IOS_APP, name), content);
  }
  await inst.edit(
    pbxprojPath,
    (t) => addSourceFiles(t, Object.keys(OTA_IOS_FILES), { randomId: inst.opts.randomId }).text,
  );
  await reportBridgeSubclasses(inst, root);
  await wireStoryboard(inst, root);
  await wireSceneDelegate(inst, root);
  await embedPublicKey(
    inst,
    join(root, IOS_APP, "Info.plist"),
    withPlistPublicKey,
    `add the string key ${IOS_PUBLIC_KEY_KEY} (the base64 public key) to the top-level dict.`,
  );
}

/** The stock Capacitor `MainActivity.java`: a bare `extends BridgeActivity {}`. */
const STOCK_MAIN_ACTIVITY =
  /^\s*package\s+([\w.]+)\s*;\s*import\s+com\.getcapacitor\.BridgeActivity\s*;\s*public\s+class\s+MainActivity\s+extends\s+BridgeActivity\s*\{\s*\}\s*$/;

/** A stock MainActivity rewritten to prepare the OTA UI before the bridge is built. */
function preparedMainActivity(pkg: string): string {
  return `package ${pkg};

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import dev.denext.ota.DenextOta;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // denext over-the-air UI: registers the DenextOta plugin and picks the UI to start
        // from. It must run before super.onCreate, which builds the bridge.
        DenextOta.prepare(this, bridgeBuilder);
        super.onCreate(savedInstanceState);
    }
}
`;
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

async function wireMainActivity(inst: Installer, root: string): Promise<void> {
  const activities = await findMainActivities(join(root, ANDROID_JAVA_ROOT));
  const step = "call `DenextOta.prepare(this, bridgeBuilder);` (import dev.denext.ota.DenextOta) " +
    "first thing in MainActivity.onCreate, before super.onCreate.";
  if (activities.length !== 1) {
    inst.report.manual.push(`Android: ${step}`);
    return;
  }
  const path = activities[0];
  const text = await Deno.readTextFile(path);
  if (text.includes("DenextOta.prepare(")) return void inst.report.unchanged.push(inst.rel(path));
  const stock = path.endsWith(".java") ? STOCK_MAIN_ACTIVITY.exec(text) : null;
  if (!stock) {
    inst.report.manual.push(`${inst.rel(path)}: ${step}`);
    return;
  }
  await inst.edit(path, () => preparedMainActivity(stock[1]));
}

async function installAndroid(inst: Installer): Promise<void> {
  const root = inst.opts.dir;
  try {
    await Deno.stat(join(root, "android", "app", "src", "main"));
  } catch {
    inst.report.skipped.push("Android: no android/app/src/main (run `cap add android` first).");
    return;
  }
  for (const [name, content] of Object.entries(OTA_ANDROID_FILES)) {
    await inst.template(join(root, ANDROID_OTA_DIR, name), content);
  }
  await wireMainActivity(inst, root);
  await embedPublicKey(
    inst,
    join(root, "android", "app", "src", "main", "AndroidManifest.xml"),
    withManifestPublicKey,
    `add <meta-data android:name="${ANDROID_PUBLIC_KEY_META}" android:value="<base64 public key>" /> inside <application>.`,
  );
}

/**
 * Install denext's over-the-air UI updates into the Capacitor project at `opts.dir`: the
 * `DenextOta` plugin for iOS (three Swift files, added to the Xcode app target, with the
 * storyboard and SceneDelegate switched to `DenextBridgeViewController`) and for Android
 * (three Java files in `dev.denext.ota`, called from `MainActivity`). Idempotent; customised
 * files are never rewritten, only reported under `manual`.
 *
 * @param opts The project directory and flags.
 * @returns What was written, what was already current, and what is left to do by hand.
 */
export async function addOtaToProject(opts: AddOtaOptions): Promise<AddOtaReport> {
  const inst = new Installer(opts);
  await installIos(inst);
  await installAndroid(inst);
  return inst.report;
}
