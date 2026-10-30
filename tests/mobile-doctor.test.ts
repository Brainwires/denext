// `denext mobile doctor --store | --release` (src/build/mobile-doctor.ts): one set of checks,
// each listed under the profiles it belongs to, over a Capacitor project and its export. A project
// with every problem planted is flagged with a fix for each; a clean one passes.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  formatMobileDoctor,
  mobileDoctorChecks,
  type MobileDoctorReport,
  releaseGateFindings,
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

Deno.test("mobile doctor --release: OTA installed without a public key is an error, per platform", async () => {
  const iosStore = "ios/App/App/DenextOtaStore.swift";
  const androidStore = "android/app/src/main/java/dev/denext/ota/DenextOtaStore.java";
  const dir = await project({
    ...cleanFiles(),
    [iosStore]: "// ota\n",
    [androidStore]: "// ota\n",
  });
  try {
    assert(mobileDoctorChecks("release").includes("ota-signing"));
    assert(!mobileDoctorChecks("store").includes("ota-signing"));
    const unsigned = await runMobileDoctor({ root: dir, profile: "release" });
    const found = unsigned.findings.filter((f) => f.check === "ota-signing");
    assertEquals(found.map((f) => f.message.split(":")[0]), ["iOS", "Android"]);
    assert(found.every((f) => f.level === "error" && f.fix.includes("--public-key")));
    // Embed the key on iOS only: Android is still flagged.
    await Deno.writeTextFile(
      join(dir, "ios/App/App/Info.plist"),
      plist("\t<key>DenextOtaPublicKey</key>\n\t<string>MFkw</string>"),
    );
    const half = await runMobileDoctor({ root: dir, profile: "release" });
    assertEquals(
      half.findings.filter((f) => f.check === "ota-signing").map((f) => f.message.split(":")[0]),
      ["Android"],
    );
    await Deno.writeTextFile(
      join(dir, "android/app/src/main/AndroidManifest.xml"),
      '<manifest><application><meta-data android:name="dev.denext.ota.PUBLIC_KEY" android:value="MFkw" /></application></manifest>',
    );
    const signed = await runMobileDoctor({ root: dir, profile: "release" });
    assertEquals(signed.findings.filter((f) => f.check === "ota-signing"), []);
    // Without OTA installed the check does not apply.
    await Deno.remove(join(dir, iosStore));
    await Deno.remove(join(dir, androidStore));
    const none = await runMobileDoctor({ root: dir, profile: "release" });
    assert(!none.checks.includes("ota-signing"));
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
      "bridge-origin-guard",
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
    assertEquals(flagged(report, "warning"), [
      "bridge-origin-guard",
      "csp",
      "source-maps",
      "secrets",
    ]);
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

Deno.test("mobile doctor: a com.example placeholder app id is an error in both profiles", async () => {
  // `denext create --capacitor` and migrate write `com.example.<name>` until you pick yours. Two
  // careless apps shipped with it would share keychain, storage and push namespaces, and the
  // stores refuse it; up to 4.5.0 nothing before submission said so.
  const files = cleanFiles();
  files["capacitor.config.json"] = JSON.stringify({
    appId: "com.example.denext",
    appName: "Example",
    webDir: "out",
  });
  const dir = await project(files);
  try {
    for (const profile of ["store", "release"] as const) {
      const report = await runMobileDoctor({ root: dir, profile });
      assertEquals(flagged(report, "error"), ["placeholder-app-id"], profile);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile doctor: allowNavigation's broad wildcards and http entries are flagged", async () => {
  const cases: Array<[string, "error" | "warning" | null, "error" | "warning" | null]> = [
    // entry, --release level, --store level
    ["*", "error", "error"],
    ["https://*", "error", "error"],
    ["*.com", "error", "error"],
    ["app.*", "error", "error"],
    ["*.example.*", "error", "error"],
    ["*.example.com", "warning", "warning"],
    ["http://api.example.com", "error", "warning"],
    ["http://*.example.com", "error", "warning"],
    ["api.example.com", null, null],
    ["https://api.example.com", null, null],
  ];
  for (const [entry, release, store] of cases) {
    const dir = await project({
      ...cleanFiles(),
      "capacitor.config.json": JSON.stringify({
        appId: "dev.example",
        webDir: "out",
        server: { allowNavigation: [entry] },
      }),
    });
    try {
      for (const [profile, want] of [["release", release], ["store", store]] as const) {
        const report = await runMobileDoctor({ root: dir, profile });
        const found = report.findings.filter((f) => f.check === "allow-navigation");
        assertEquals(found.map((f) => f.level), want ? [want] : [], `${entry} (${profile})`);
        if (want) assertStringIncludes(found[0].message, "server.allowNavigation");
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("mobile doctor: a network security config that permits cleartext is flagged", async () => {
  const manifest =
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application ' +
    'android:networkSecurityConfig="@xml/network_security_config"></application></manifest>';
  const xml = (body: string) =>
    `<?xml version="1.0" encoding="utf-8"?>\n<network-security-config>\n${body}\n</network-security-config>\n`;
  const cases: Array<[string, string | null]> = [
    ['<base-config cleartextTrafficPermitted="true" />', "<base-config> (every host)"],
    [
      '<domain-config cleartextTrafficPermitted="true"><domain>10.0.0.2</domain></domain-config>',
      "a <domain-config>",
    ],
    ['<base-config cleartextTrafficPermitted="false" />', null],
    ['<!-- <base-config cleartextTrafficPermitted="true" /> -->', null],
  ];
  for (const [body, where] of cases) {
    const dir = await project({
      ...cleanFiles(),
      "android/app/src/main/AndroidManifest.xml": manifest,
      "android/app/src/main/res/xml/network_security_config.xml": xml(body),
    });
    try {
      const release = await runMobileDoctor({ root: dir, profile: "release" });
      const found = release.findings.filter((f) =>
        f.check === "cleartext" && f.message.includes("network_security_config.xml")
      );
      if (where === null) {
        assertEquals(found, [], body);
        continue;
      }
      assertEquals(found.map((f) => f.level), ["error"], body);
      assertStringIncludes(found[0].message, `cleartextTrafficPermitted="true" on ${where}`);
      const store = await runMobileDoctor({ root: dir, profile: "store" });
      assertEquals(
        store.findings.filter((f) => f.message.includes("network_security_config.xml"))
          .map((f) => f.level),
        ["warning"],
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("mobile doctor --release: frameGuard off over a third-party allowNavigation origin is an error", async () => {
  const config = (server: Record<string, unknown>) =>
    JSON.stringify({
      appId: "dev.example",
      webDir: "out",
      server,
      plugins: { DenextBridge: { frameGuard: false } },
    });
  const level = async (server: Record<string, unknown>, profile: "release" | "store") => {
    const dir = await project({ ...cleanFiles(), "capacitor.config.json": config(server) });
    try {
      const report = await runMobileDoctor({ root: dir, profile });
      return report.findings.filter((f) => f.check === "bridge-origin-guard").map((f) => f.level);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  };
  const others = { allowNavigation: ["https://partner.example"] };
  assertEquals(await level(others, "release"), ["error"]);
  assertEquals(await level(others, "store"), ["warning"]);
  // A hosted app's own server.url alone (what `denext migrate` opts out for) stays a warning.
  assertEquals(await level({ url: "https://app.example" }, "release"), ["warning"]);
});

Deno.test("mobile doctor: the release gate is the release-security findings only", async () => {
  const dir = await project({
    ...cleanFiles(),
    "capacitor.config.json": JSON.stringify({
      appId: "dev.example",
      webDir: "out",
      server: { url: "https://app.example", allowNavigation: ["*.example.com", "*"] },
      android: { webContentsDebuggingEnabled: true, useLegacyBridge: true },
    }),
    "ios/App/App/Info.plist": plist(
      "\t<key>NSAppTransportSecurity</key>\n\t<dict>\n\t\t<key>NSAllowsLocalNetworking</key>\n" +
        "\t\t<true/>\n\t\t<key>NSAllowsArbitraryLoads</key>\n\t\t<true/>\n\t</dict>",
    ),
    "out/index.html": "<!doctype html><html><head></head></html>",
  });
  try {
    const report = await runMobileDoctor({ root: dir, profile: "release" });
    const gate = releaseGateFindings(report);
    assertEquals([...new Set(gate.map((f) => f.check))].sort(), [
      "allow-navigation",
      "cleartext",
      "legacy-bridge",
      "webview-debugging",
    ]);
    const cleartext = gate.filter((f) => f.check === "cleartext").map((f) => f.message);
    assertEquals(cleartext.length, 1, cleartext.join("\n"));
    assertStringIncludes(cleartext[0], "NSAllowsLocalNetworking");
    // The wildcard subdomain is a warning, never a gate.
    assertEquals(gate.filter((f) => f.check === "allow-navigation").length, 1);
    // Errors outside the gate: a hosted https server.url, NSAllowsArbitraryLoads, the CSP.
    const rest = report.findings.filter((f) => f.level === "error" && !f.releaseGate);
    for (const id of ["server-url", "cleartext", "csp"]) {
      assert(rest.some((f) => f.check === id), id);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
