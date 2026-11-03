// `staleNativeTemplates` (src/build/native-template-status.ts): the native template families in
// a Capacitor project that are older than this denext writes, read from their marker lines.

import { assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { staleNativeTemplates } from "../src/build/native-template-status.ts";
import { renderMarkedTemplate } from "../src/build/native-template-marker.ts";
import { AUTH_SESSION_TEMPLATE_VERSION } from "../src/build/auth-session-native-templates.ts";
import { OTA_TEMPLATE_VERSION } from "../src/build/ota-native-templates.ts";
import { EXPO_SDK_TEMPLATE_VERSIONS } from "../src/build/expo-sdk-native-templates.ts";

async function project(files: Record<string, string>, run: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "denext_native_status_" });
  try {
    for (const [name, text] of Object.entries(files)) {
      await Deno.mkdir(dirname(join(dir, name)), { recursive: true });
      await Deno.writeTextFile(join(dir, name), text);
    }
    await run(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("staleNativeTemplates: the families behind, their oldest generation and the command", async () => {
  await project({
    // auth-session: one file at the previous generation (the bridge frame-guard fixes came after).
    "ios/App/App/DenextAuthSessionPlugin.swift": await renderMarkedTemplate(
      "auth-session",
      AUTH_SESSION_TEMPLATE_VERSION - 1,
      "// plugin\n",
    ),
    "android/app/src/main/java/dev/denext/authsession/DenextAuthSessionPlugin.java":
      await renderMarkedTemplate("auth-session", AUTH_SESSION_TEMPLATE_VERSION, "// p\n"),
    // An edited file keeps its marker line: it still counts.
    "ios/App/App/DenextCalendarPlugin.swift":
      (await renderMarkedTemplate("calendar", EXPO_SDK_TEMPLATE_VERSIONS.calendar - 1, "// c\n")) +
      "// mine\n",
    // Current: not reported.
    "ios/App/App/DenextOtaPlugin.swift": await renderMarkedTemplate(
      "ota",
      OTA_TEMPLATE_VERSION,
      "// ota\n",
    ),
    // Build output and dependencies are never read; a family this denext doesn't know is skipped.
    "ios/App/Pods/X/DenextOtaPlugin.swift": await renderMarkedTemplate("ota", 1, "// old\n"),
    "android/app/build/gen/Old.java": await renderMarkedTemplate("ota", 1, "// old\n"),
    "android/app/src/main/java/Other.java": await renderMarkedTemplate("not-ours", 1, "// x\n"),
    // An XML resource carries the marker as a comment.
    "android/app/src/main/res/layout/ctx.xml": await renderMarkedTemplate(
      "context-menu",
      1,
      "<x/>\n",
      "xml",
    ),
  }, async (dir) => {
    const stale = await staleNativeTemplates(dir);
    assertEquals(stale.map((s) => [s.family, s.generation, s.command]), [
      ["auth-session", AUTH_SESSION_TEMPLATE_VERSION - 1, "denext mobile add auth-session"],
      ["calendar", EXPO_SDK_TEMPLATE_VERSIONS.calendar - 1, "denext mobile add calendar"],
      ["context-menu", 1, "denext mobile add context-menu"],
    ]);
    assertEquals(stale[0].current, AUTH_SESSION_TEMPLATE_VERSION);
    assertEquals(stale[0].files.length, 2);
  });
});

Deno.test("staleNativeTemplates: a project with no native folders has none", async () => {
  await project({ "deno.json": "{}\n" }, async (dir) => {
    assertEquals(await staleNativeTemplates(dir), []);
  });
});
