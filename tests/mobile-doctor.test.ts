// `denext mobile doctor --store | --release` (src/build/mobile-doctor.ts): one set of checks,
// each listed under the profiles it belongs to, over a Capacitor project and its export. A project
// with every problem planted is flagged with a fix for each; a clean one passes.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  formatMobileDoctor,
  mobileDoctorChecks,
  type MobileDoctorReport,
  runMobileDoctor,
} from "../src/build/mobile-doctor.ts";
import { mergePrivacyManifest, privacyEntriesFor } from "../src/build/mobile-privacy.ts";
import { addSourceFiles } from "../src/build/pbxproj.ts";

const PBXPROJ = await Deno.readTextFile(
  new URL("./fixtures/capacitor8/project.pbxproj", import.meta.url),
);

const plist = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;

const ICONS = JSON.stringify({ images: [{ filename: "AppIcon-512@2x.png", idiom: "universal" }] });

/** A clean project: bundled export with a CSP, icons, splash, manifest, usage strings. */
function cleanFiles(): Record<string, string> {
  return {
    "capacitor.config.json": JSON.stringify({
      appId: "dev.example",
      appName: "Example",
      webDir: "out",
    }),
    "package.json": JSON.stringify({
      dependencies: { "@capacitor/core": "^8.0.0", "@capacitor/camera": "^8.2.4" },
    }),
    "ios/App/App/Info.plist": plist(
      "\t<key>NSCameraUsageDescription</key>\n\t<string>Scan receipts.</string>\n" +
        "\t<key>NSPhotoLibraryUsageDescription</key>\n\t<string>Pick receipts.</string>\n" +
        "\t<key>NSPhotoLibraryAddUsageDescription</key>\n\t<string>Save receipts.</string>",
    ),
    "ios/App/App/PrivacyInfo.xcprivacy":
      mergePrivacyManifest(undefined, privacyEntriesFor([])).text,
    "ios/App/App.xcodeproj/project.pbxproj":
      addSourceFiles(PBXPROJ, ["PrivacyInfo.xcprivacy"], { phase: "resources" }).text,
    "ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json": ICONS,
    "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png": "png",
    "ios/App/App/Base.lproj/LaunchScreen.storyboard": "<document/>",
    "android/app/src/main/AndroidManifest.xml": "<manifest><application></application></manifest>",
    "android/app/src/main/res/mipmap-hdpi/ic_launcher.png": "png",
    "android/app/src/main/res/drawable/splash.png": "png",
    "out/index.html":
      `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'"></head></html>`,
    "out/_denext/client/index.js": "console.log(1);\n",
    "src/main.tsx": "export const x = 1;\n",
  };
}

async function project(files: Record<string, string | null>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_mobile_doctor_" });
  for (const [path, content] of Object.entries(files)) {
    if (content === null) continue;
    await Deno.mkdir(join(dir, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, path), content);
  }
  return dir;
}

/** The ids of the checks that found an error / a warning. */
function flagged(report: MobileDoctorReport, level: "error" | "warning"): string[] {
  return [...new Set(report.findings.filter((f) => f.level === level).map((f) => f.check))];
}

Deno.test("mobile doctor: the profiles share checks and differ where they should", () => {
  const store = mobileDoctorChecks("store");
  const release = mobileDoctorChecks("release");
  for (
    const id of [
      "server-url",
      "webview-debugging",
      "cleartext",
      "allow-navigation",
      "csp",
      "secrets",
    ]
  ) {
    assert(store.includes(id) && release.includes(id), id);
  }
  for (
    const id of [
      "usage-strings",
      "privacy-manifest",
      "app-icons",
      "splash",
      "account-deletion",
      "source-maps",
    ]
  ) {
    assert(store.includes(id) && !release.includes(id), id);
  }
  for (const id of ["mixed-content", "android-debuggable", "logging"]) {
    assert(release.includes(id) && !store.includes(id), id);
  }
});

Deno.test("mobile doctor: a clean project passes both profiles", async () => {
  const dir = await project(cleanFiles());
  try {
    for (const profile of ["store", "release"] as const) {
      const report = await runMobileDoctor({ root: dir, profile });
      assertEquals(report.findings, [], profile);
      assertStringIncludes(formatMobileDoctor(report), "All checks passed.");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile doctor --store flags every planted App Review problem, each with a fix", async () => {
  const files: Record<string, string | null> = {
    ...cleanFiles(),
    "capacitor.config.json": JSON.stringify({
      appId: "dev.example",
      webDir: "out",
      server: { url: "http://192.168.1.5:3000", cleartext: true, allowNavigation: ["*"] },
      ios: { webContentsDebuggingEnabled: true },
    }),
    // A stale native copy still pointing at the dev server.
    "ios/App/App/capacitor.config.json": JSON.stringify({
      server: { url: "http://10.0.0.2:3000" },
    }),
    "package.json": JSON.stringify({
      dependencies: {
        "@capacitor/core": "^8.0.0",
        "@capacitor/camera": "^8.2.4",
        "@capacitor/filesystem": "^8.1.3",
      },
    }),
    "ios/App/App/Info.plist": plist(
      "\t<key>NSAppTransportSecurity</key>\n\t<dict>\n\t\t<key>NSAllowsArbitraryLoads</key>\n\t\t<true/>\n\t</dict>",
    ),
    "ios/App/App/PrivacyInfo.xcprivacy": null,
    "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png": null,
    "out/index.html": "<!doctype html><html><head></head></html>",
    "out/_denext/client/index.js":
      'const k = "sk_live_0123456789abcdefghij";\n//# sourceMappingURL=index.js.map\n',
    "out/_denext/client/index.js.map": "{}",
    "src/login.tsx": "await signInWithGoogle({ webClientId });\n",
  };
  const dir = await project(files);
  try {
    const report = await runMobileDoctor({ root: dir, profile: "store" });
    assertEquals(flagged(report, "error"), [
      "server-url",
      "webview-debugging",
      "allow-navigation",
      "secrets",
      "usage-strings",
      "privacy-manifest",
      "app-icons",
      "account-deletion",
    ]);
    assertEquals(flagged(report, "warning"), [
      "cleartext",
      "csp",
      "source-maps",
      "account-deletion",
    ]);
    // Both the source config and the stale native copy are named.
    const urls = report.findings.filter((f) => f.check === "server-url").map((f) => f.message);
    assertEquals(urls.length, 2);
    assertStringIncludes(urls[1], "ios/App/App/capacitor.config.json");
    const usage = report.findings.filter((f) => f.check === "usage-strings").map((f) => f.message);
    assertEquals(usage.length, 3);
    assert(report.findings.every((f) => f.fix.length > 10));
    // The secret itself is never printed.
    assert(!formatMobileDoctor(report).includes("sk_live_0123"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile doctor --release: debuggable, cleartext, mixed content, CSP and secrets are errors", async () => {
  const dir = await project({
    ...cleanFiles(),
    "capacitor.config.json": JSON.stringify({
      appId: "dev.example",
      webDir: "out",
      server: { cleartext: true },
      android: { webContentsDebuggingEnabled: true, allowMixedContent: true },
      loggingBehavior: "production",
    }),
    "android/app/src/main/AndroidManifest.xml":
      '<manifest><application android:debuggable="true" android:usesCleartextTraffic="true"></application></manifest>',
    "out/index.html": "<!doctype html>",
    "out/_denext/client/index.js": "const pem = '-----BEGIN PRIVATE KEY-----';\n",
  });
  try {
    const report = await runMobileDoctor({ root: dir, profile: "release" });
    assertEquals(flagged(report, "error"), [
      "webview-debugging",
      "cleartext",
      "mixed-content",
      "android-debuggable",
      "csp",
      "secrets",
    ]);
    assertEquals(flagged(report, "warning"), ["logging"]);
    assertStringIncludes(formatMobileDoctor(report), "✖ webview-debugging");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile doctor --release: a native copy left inspectable by a killed dev session is an error", async () => {
  // The source config is clean; `denext mobile dev` turned debugging on in the synced copies and
  // was killed before it could restore them.
  const dir = await project({
    ...cleanFiles(),
    "ios/App/App/capacitor.config.json": JSON.stringify({
      appId: "dev.example",
      ios: { webContentsDebuggingEnabled: true },
    }),
    "android/app/src/main/assets/capacitor.config.json": JSON.stringify({
      appId: "dev.example",
      android: { webContentsDebuggingEnabled: true },
    }),
  });
  try {
    const report = await runMobileDoctor({ root: dir, profile: "release" });
    assertEquals(flagged(report, "error"), ["webview-debugging"]);
    const found = report.findings.filter((f) => f.check === "webview-debugging");
    assertEquals(found.map((f) => f.message.split(":")[0]), [
      "ios/App/App/capacitor.config.json",
      "android/app/src/main/assets/capacitor.config.json",
    ]);
    for (const f of found) assertStringIncludes(f.fix, "remove ");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile doctor: a TS config is read as data; no export is a warning; account deletion found", async () => {
  const files: Record<string, string | null> = {
    ...cleanFiles(),
    "capacitor.config.json": null,
    "capacitor.config.ts": `import type { CapacitorConfig } from "@capacitor/cli";
const config: CapacitorConfig = { appId: "dev.example", webDir: "dist", server: { url: "https://example.com" } };
export default config;
`,
    "src/account.tsx": "await session.deleteAccount();\nnativeSession({ baseUrl });\n",
  };
  const dir = await project(files);
  try {
    const report = await runMobileDoctor({ root: dir, profile: "store" });
    assertEquals(flagged(report, "error"), ["server-url"]);
    assertEquals(flagged(report, "warning"), ["csp", "source-maps", "secrets"]);
    assertStringIncludes(
      report.findings.find((f) => f.check === "csp")!.message,
      "no export at dist/",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile doctor refuses a folder without a Capacitor project", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await assertRejects(
      () => runMobileDoctor({ root: dir, profile: "store" }),
      Error,
      "no Capacitor project",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
