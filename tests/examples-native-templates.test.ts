// The Capacitor examples commit the native files `denext mobile add …` / `add-ota` wrote into
// their ios/ and android/ projects, and the nightly mobile build (mobile-build.yml) compiles those
// committed files. When a template moves on (a new generation of the OTA plugin, a MainActivity
// that forwards one more signal) and the examples are not regenerated, that build keeps compiling
// the old code instead of what `denext mobile add` writes today. This test fails on such drift:
// every file carrying a `denext-<family>-template: <n>` marker must be at the family's current
// generation, and still be the unedited template its marker hashes (an edited file is kept as-is
// by the installers, so it would never be upgraded). deno.json's `fmt.exclude` leaves the examples'
// ios/ and android/ alone for the same reason: `deno fmt` reindents XML, which breaks the hash of
// the widget layouts denext writes.

import { assert, assertEquals } from "@std/assert";
import { walk } from "@std/fs";
import { fromFileUrl, join, relative } from "@std/path";
import { ACCESSIBILITY_TEMPLATE_VERSION } from "../src/build/accessibility-native-templates.ts";
import { APP_EXTENSION_TEMPLATE_VERSION } from "../src/build/app-extension-native-templates.ts";
import { AUTH_SESSION_TEMPLATE_VERSION } from "../src/build/auth-session-native-templates.ts";
import { BACK_TEMPLATE_VERSION } from "../src/build/back-native-templates.ts";
import { CONTEXT_MENU_TEMPLATE_VERSION } from "../src/build/context-menu-native-templates.ts";
import { mainActivitySource } from "../src/build/mobile-native-install.ts";
import { renderNativeModuleTemplate } from "../src/build/native-module-native-templates.ts";
import { markedTemplateIntact } from "../src/build/native-template-marker.ts";
import { NATIVE_VIEWS_TEMPLATE_VERSION } from "../src/build/native-views-native-templates.ts";
import { OTA_TEMPLATE_VERSION } from "../src/build/ota-native-templates.ts";
import { SETTINGS_TEMPLATE_VERSION } from "../src/build/settings-native-templates.ts";
import { STORAGE_TEMPLATE_VERSION } from "../src/build/storage-native-templates.ts";
import { SYSTEM_ICON_TEMPLATE_VERSION } from "../src/build/system-icon-native-templates.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/** The examples with a committed Capacitor project (their READMEs list the `mobile add` lines). */
const EXAMPLES = ["examples/mobile", "examples/native-views", "examples/expo-app"];

/** The leading marker line of a denext native template. */
const MARKER = /^(?:\/\/|<!--|#) denext-([a-z-]+)-template: (\d+) /;

/** The generation in the marker line of `text`. */
function generationOf(text: string): number {
  const m = MARKER.exec(text);
  assert(m, `no marker line in ${text.slice(0, 80)}`);
  return Number(m[2]);
}

/**
 * The generation this release writes for every template family, with the command that rewrites
 * a family's files. A family missing here fails the test: add it when an example starts using it.
 */
async function currentGenerations(): Promise<Map<string, { generation: number; add: string }>> {
  return new Map([
    ["ota", { generation: OTA_TEMPLATE_VERSION, add: "mobile add-ota" }],
    ["auth-session", { generation: AUTH_SESSION_TEMPLATE_VERSION, add: "mobile add auth-session" }],
    ["app-extension", {
      generation: APP_EXTENSION_TEMPLATE_VERSION,
      // DenextBridgeViewController.swift without OTA is in this family too; any denext native
      // capability rewrites it.
      add:
        "mobile add share-extension / widget / live-activity (or any denext native capability, " +
        "for DenextBridgeViewController.swift)",
    }],
    ["back", { generation: BACK_TEMPLATE_VERSION, add: "mobile add back" }],
    ["settings", { generation: SETTINGS_TEMPLATE_VERSION, add: "mobile add permissions" }],
    ["accessibility", {
      generation: ACCESSIBILITY_TEMPLATE_VERSION,
      add: "mobile add accessibility",
    }],
    ["context-menu", { generation: CONTEXT_MENU_TEMPLATE_VERSION, add: "mobile add context-menu" }],
    ["system-icon", { generation: SYSTEM_ICON_TEMPLATE_VERSION, add: "mobile add system-icons" }],
    ["native-views", {
      generation: NATIVE_VIEWS_TEMPLATE_VERSION,
      add: "mobile add native-views / native-map",
    }],
    ["storage", { generation: STORAGE_TEMPLATE_VERSION, add: "mobile add storage" }],
    ["main-activity", {
      generation: generationOf(await mainActivitySource("p", new Set())),
      add:
        "mobile add <any denext native capability the example uses> (MainActivity is recomposed)",
    }],
    ["native-module", {
      generation: generationOf(await renderNativeModuleTemplate("")),
      add: "mobile add native-module --name <Name>",
    }],
  ]);
}

/** The source files of the example's native projects that can carry a marker line. */
async function nativeFiles(example: string): Promise<string[]> {
  const files: string[] = [];
  for (const platform of ["ios", "android"]) {
    const dir = join(ROOT, example, platform);
    try {
      await Deno.stat(dir);
    } catch {
      continue; // examples/expo-app has no android/
    }
    for await (
      const e of walk(dir, {
        includeDirs: false,
        exts: [".swift", ".java", ".kt", ".xml", ".m", ".h"],
        // Build output, dependencies and the web export `cap sync` copies in.
        skip: [
          /\/(?:node_modules|Pods|build|\.gradle|DerivedData|public|capacitor-cordova-[^/]+)\//,
        ],
      })
    ) files.push(e.path);
  }
  return files.sort();
}

for (const example of EXAMPLES) {
  Deno.test(`${example}: every committed native template is at the current generation, unedited`, async () => {
    const current = await currentGenerations();
    const problems: string[] = [];
    let marked = 0;
    for (const path of await nativeFiles(example)) {
      const text = (await Deno.readTextFile(path)).replaceAll("\r\n", "\n");
      const m = MARKER.exec(text);
      if (!m) continue;
      marked++;
      const [, family, found] = m;
      const rel = relative(ROOT, path).replaceAll("\\", "/");
      const now = current.get(family);
      if (!now) {
        problems.push(
          `${rel}: unknown template family "${family}" — add its generation constant to ` +
            `currentGenerations() in tests/examples-native-templates.test.ts`,
        );
        continue;
      }
      if (Number(found) !== now.generation) {
        problems.push(
          `${rel}: denext-${family}-template generation ${found}, current ${now.generation}. ` +
            `Run \`denext ${now.add}\` in ${example} to regenerate it (its README lists the lines).`,
        );
      } else if (await markedTemplateIntact(family, text) !== true) {
        problems.push(
          `${rel}: edited after denext wrote it (the marker's hash does not match), so ` +
            `\`denext ${now.add}\` keeps it as is. Restore the template: re-run that with --force ` +
            `in ${example}.`,
        );
      }
    }
    assert(marked > 0, `${example}: no file with a denext template marker under ios/ or android/`);
    assertEquals(problems, [], `${example} has stale native files:\n  ${problems.join("\n  ")}`);
  });
}
