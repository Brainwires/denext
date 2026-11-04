// Which of denext's native templates in a Capacitor project are older than this denext writes.
//
// Every native file `denext mobile add` / `add-ota` writes starts with a marker line naming its
// template family and generation (`// denext-auth-session-template: 5 sha256=…`, see
// `native-template-marker.ts`). A generation bump carries a fix the app only gets by re-running
// the command that wrote the files (an unedited file is upgraded in place) and shipping a new
// binary, so `denext upgrade` lists the families behind, with that command.

import { join } from "@std/path";
import { ACCESSIBILITY_TEMPLATE_VERSION } from "./accessibility-native-templates.ts";
import { APP_EXTENSION_TEMPLATE_VERSION } from "./app-extension-native-templates.ts";
import { AUTH_SESSION_TEMPLATE_VERSION } from "./auth-session-native-templates.ts";
import { CONTEXT_MENU_TEMPLATE_VERSION } from "./context-menu-native-templates.ts";
import { EXPO_SDK_TEMPLATE_VERSIONS } from "./expo-sdk-native-templates.ts";
import { NATIVE_VIEWS_TEMPLATE_VERSION } from "./native-views-native-templates.ts";
import { OTA_TEMPLATE_VERSION } from "./ota-native-templates.ts";
import { SETTINGS_TEMPLATE_VERSION } from "./settings-native-templates.ts";
import { STORAGE_TEMPLATE_VERSION } from "./storage-native-templates.ts";
import { TRANSFER_TEMPLATE_VERSION } from "./transfer-native-templates.ts";

/** A template family this denext writes: its current generation and the command that refreshes it. */
interface TemplateFamily {
  readonly current: number;
  readonly command: string;
}

/**
 * The families whose generation has moved past 1 (a family still at its first generation can't
 * be behind), with the command that rewrites their files.
 */
const FAMILIES: Readonly<Record<string, TemplateFamily>> = {
  "ota": { current: OTA_TEMPLATE_VERSION, command: "denext mobile add-ota" },
  "auth-session": {
    current: AUTH_SESSION_TEMPLATE_VERSION,
    command: "denext mobile add auth-session",
  },
  "settings": { current: SETTINGS_TEMPLATE_VERSION, command: "denext mobile add permissions" },
  "storage": { current: STORAGE_TEMPLATE_VERSION, command: "denext mobile add storage" },
  "transfer": { current: TRANSFER_TEMPLATE_VERSION, command: "denext mobile add file-transfer" },
  "accessibility": {
    current: ACCESSIBILITY_TEMPLATE_VERSION,
    command: "denext mobile add accessibility",
  },
  "context-menu": {
    current: CONTEXT_MENU_TEMPLATE_VERSION,
    command: "denext mobile add context-menu",
  },
  "native-views": {
    current: NATIVE_VIEWS_TEMPLATE_VERSION,
    command: "denext mobile add native-views",
  },
  "app-extension": {
    current: APP_EXTENSION_TEMPLATE_VERSION,
    command: "denext mobile add share-extension | widget | live-activity (the one that wrote it)",
  },
  ...Object.fromEntries(
    Object.entries(EXPO_SDK_TEMPLATE_VERSIONS).map(([family, current]) => [
      family,
      { current, command: `denext mobile add ${family}` },
    ]),
  ),
};

/** One family of native templates older than this denext writes. */
export interface StaleNativeTemplate {
  /** The template family (`auth-session`). */
  readonly family: string;
  /** The oldest generation among its files in the project. */
  readonly generation: number;
  /** The generation this denext writes. */
  readonly current: number;
  /** The project-relative files of that family. */
  readonly files: readonly string[];
  /** The command that refreshes them. */
  readonly command: string;
}

/** Directories never walked: build output, dependencies and caches. */
const SKIP_DIRS = new Set([
  "Pods",
  "build",
  "DerivedData",
  "node_modules",
  ".gradle",
  ".idea",
  "capacitor-cordova-ios-plugins",
  "capacitor-cordova-android-plugins",
]);

/** The native source extensions a marker can sit on top of. */
const NATIVE_FILE = /\.(?:swift|java|kt|m|h|xml)$/;

/** At most this many files are read per platform folder (a project's own sources are far fewer). */
const MAX_FILES = 5000;

/** The marker line on top of a native template file (`//` or XML comment). */
const MARKER = /^(?:\/\/|<!--) denext-([a-z0-9-]+)-template: (\d+) sha256=/;

/** Each native file under `root/<sub>` with a marker line: its path and the marker's parts. */
async function markedFiles(
  root: string,
  sub: string,
): Promise<Array<{ file: string; family: string; generation: number }>> {
  const out: Array<{ file: string; family: string; generation: number }> = [];
  let budget = MAX_FILES;
  const walk = async (rel: string): Promise<void> => {
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(join(root, rel)));
    } catch {
      return;
    }
    for (const e of entries) {
      if (budget <= 0) return;
      const path = `${rel}/${e.name}`;
      if (e.isDirectory && !SKIP_DIRS.has(e.name)) await walk(path);
      else if (e.isFile && NATIVE_FILE.test(e.name)) {
        budget--;
        const text = await Deno.readTextFile(join(root, path)).catch(() => "");
        const m = MARKER.exec(text);
        if (m) out.push({ file: path, family: m[1], generation: Number(m[2]) });
      }
    }
  };
  await walk(sub);
  return out;
}

/**
 * The native template families in the Capacitor project at `root` (its `ios/` and `android/`
 * folders) whose files are an older generation than this denext writes, with the command that
 * refreshes each. Empty for a project with no native folders.
 *
 * @param root The project directory.
 * @returns The stale families, by family name.
 */
export async function staleNativeTemplates(root: string): Promise<StaleNativeTemplate[]> {
  const found = [...await markedFiles(root, "ios"), ...await markedFiles(root, "android")];
  const byFamily = new Map<string, { generation: number; files: string[] }>();
  for (const { file, family, generation } of found) {
    if (!Object.hasOwn(FAMILIES, family)) continue;
    const seen = byFamily.get(family) ?? { generation, files: [] };
    seen.generation = Math.min(seen.generation, generation);
    seen.files.push(file);
    byFamily.set(family, seen);
  }
  const out: StaleNativeTemplate[] = [];
  for (const [family, { generation, files }] of [...byFamily].sort(([a], [b]) => a < b ? -1 : 1)) {
    const { current, command } = FAMILIES[family];
    if (generation < current) out.push({ family, generation, current, files, command });
  }
  return out;
}
