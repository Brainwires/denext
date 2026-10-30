// `denext mobile build`'s hardening: the web export and `cap sync` run without the signing
// credentials, inputs that land in Groovy / plist / build settings are validated, and a release
// build runs `denext mobile doctor --release` after `cap sync`, refusing on any error.
// Commands run through a fake runner (no Xcode, no Gradle); one test spawns a real `deno`.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  type BuildCommand,
  buildStepEnv,
  gradlewCommand,
  type MobileBuildDeps,
  type MobileBuildOptions,
  planMobileBuild,
  runMobileBuild,
  withoutSigningEnv,
} from "../src/build/mobile-build.ts";
import {
  applyAndroidVersions,
  applyFlavor,
  assertFlavorAppId,
  assertVersionName,
  NativeSnapshot,
} from "../src/build/mobile-flavor.ts";
import type { MobileDoctorReport } from "../src/build/mobile-doctor.ts";
import { runInheritedCommand } from "../src/cli/commands/mobile-build.ts";
import { installFakeCapacitorCli } from "./_capacitor-cli.ts";

const PBXPROJ = await Deno.readTextFile(
  new URL("./fixtures/capacitor8/project.pbxproj", import.meta.url),
);

const GRADLE = `android {
    defaultConfig {
        applicationId "dev.example"
        versionCode 7
        versionName "1.4"
    }
}
`;

const plist = (body = "") =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;

/** A Capacitor project with both platforms, its own @capacitor/cli and an export. */
async function project(files: Record<string, string> = {}): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_build_hard_" }));
  const all: Record<string, string> = {
    "capacitor.config.json": JSON.stringify({ appId: "dev.example", appName: "R", webDir: "out" }),
    "ios/App/App.xcodeproj/project.pbxproj": PBXPROJ,
    "ios/App/App/Info.plist": plist(),
    "android/app/build.gradle": GRADLE,
    "android/app/src/main/AndroidManifest.xml":
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application>' +
      "</application></manifest>",
    "out/index.html":
      `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'"></head></html>`,
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    await Deno.mkdir(join(dir, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, path), content);
  }
  await installFakeCapacitorCli(dir);
  return dir;
}

function options(dir: string, extra: Partial<MobileBuildOptions> = {}): MobileBuildOptions {
  return {
    root: dir,
    appDir: dir,
    platform: "android",
    cli: ["run", "-A", "cli.ts"],
    deno: "deno",
    ...extra,
  };
}

/** Deps whose `cap sync` succeeds and whose native build fails (so reaching it is visible). */
function deps(
  extra: Partial<MobileBuildDeps> = {},
): MobileBuildDeps & { ran: string[]; logged: string[] } {
  const ran: string[] = [];
  const logged: string[] = [];
  return {
    ran,
    logged,
    log: (line) => void logged.push(line),
    run: (c: BuildCommand) => {
      ran.push(c.cmd);
      return Promise.resolve({ code: c.cmd === "npx" ? 0 : 1 });
    },
    ...extra,
  };
}

// ---- signing secrets stay out of the export and cap sync -----------------------------------

Deno.test("mobile build: the export and cap sync run without the signing credentials; the native build keeps them", async () => {
  const dir = await project();
  try {
    const plan = await planMobileBuild(options(dir, {
      release: true,
      signing: { keystore: "/k/up.jks", keyAlias: "up", keystorePassword: "pw" },
    }));
    const [exportCmd, sync, gradle] = plan.commands;
    assert(exportCmd.args.includes("export"));
    assertEquals(exportCmd.scrubSigningEnv, true);
    assertEquals(sync.scrubSigningEnv, true);
    assertEquals(gradle.scrubSigningEnv, undefined);
    assert(gradle.env?.GRADLE_OPTS?.includes("signing.store.password=pw"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("withoutSigningEnv: drops every signing and store credential, keeps the rest", () => {
  const env = {
    PATH: "/usr/bin",
    HOME: "/home/ci",
    GRADLE_OPTS: "-Xmx2g",
    DENEXT_ANDROID_KEYSTORE_PASSWORD: "a",
    ANDROID_KEY_PASSWORD: "b",
    DENEXT_ANDROID_KEYSTORE: "/k/up.jks",
    DENEXT_ASC_KEY_PATH: "/k/AuthKey.p8",
    ASC_ISSUER_ID: "c",
    DENEXT_IOS_TEAM: "TEAM123456",
    APPLE_TEAM_ID: "TEAM123456",
    MATCH_PASSWORD: "d",
    MATCH_GIT_BASIC_AUTHORIZATION: "e",
    SUPPLY_JSON_KEY_DATA: "f",
    FASTLANE_PASSWORD: "g",
    APP_STORE_CONNECT_API_KEY_KEY: "h",
    DENEXT_PLAY_SERVICE_ACCOUNT: "/k/sa.json",
    // Windows environment names are case-insensitive.
    denext_android_key_password: "i",
  };
  assertEquals(withoutSigningEnv(env), {
    PATH: "/usr/bin",
    HOME: "/home/ci",
    GRADLE_OPTS: "-Xmx2g",
  });
  assertEquals(
    buildStepEnv({ scrubSigningEnv: true, env: { NODE_ENV: "production" } }, () => env),
    {
      env: { PATH: "/usr/bin", HOME: "/home/ci", GRADLE_OPTS: "-Xmx2g", NODE_ENV: "production" },
      clearEnv: true,
    },
  );
  assertEquals(buildStepEnv({ env: { GRADLE_OPTS: "x" } }, () => env), {
    env: { GRADLE_OPTS: "x" },
    clearEnv: false,
  });
  assertEquals(buildStepEnv({}, () => env), { clearEnv: false });
});

Deno.test("runInheritedCommand: a scrubbed step's child process never sees the keystore password", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_build_env_" });
  const name = "DENEXT_ANDROID_KEYSTORE_PASSWORD";
  const before = Deno.env.get(name);
  Deno.env.set(name, "not-for-build-plugins");
  try {
    const seen = async (scrubSigningEnv: boolean) => {
      const out = join(dir, `${scrubSigningEnv}.json`);
      const { code } = await runInheritedCommand({
        cmd: Deno.execPath(),
        args: [
          "eval",
          `Deno.writeTextFileSync(${JSON.stringify(out)}, JSON.stringify(Deno.env.toObject()))`,
        ],
        cwd: dir,
        env: { DENEXT_STEP: "export" },
        ...(scrubSigningEnv ? { scrubSigningEnv } : {}),
      });
      assertEquals(code, 0);
      return JSON.parse(await Deno.readTextFile(out)) as Record<string, string>;
    };
    const scrubbed = await seen(true);
    assertEquals(scrubbed[name], undefined);
    assertEquals(scrubbed.DENEXT_STEP, "export");
    assert(scrubbed.PATH !== undefined, "the rest of the environment is inherited");
    assertEquals((await seen(false))[name], "not-for-build-plugins");
  } finally {
    if (before === undefined) Deno.env.delete(name);
    else Deno.env.set(name, before);
    await Deno.remove(dir, { recursive: true });
  }
});

// ---- inputs written into Groovy, the Xcode project and ExportOptions.plist ------------------

Deno.test("mobile build: a version name that could run Groovy at Gradle time is refused", async () => {
  for (const bad of ["1.0${x}", '1.0"', "1.0 beta", "1.0\\", "$(id)", ""]) {
    assertThrows(() => assertVersionName(bad), Error, "version", bad);
  }
  for (const good of ["1.4.0", "2.0.0-beta.1+42", "10"]) assertVersionName(good);
  const dir = await project();
  try {
    await assertRejects(
      () => planMobileBuild(options(dir, { versionName: "1.0${System.exit(1)}" })),
      Error,
      "may only use letters, digits",
    );
    await assertRejects(
      () => planMobileBuild(options(dir, { platform: "ios", versionName: "1.0;x" })),
      Error,
      "may only use letters, digits",
    );
    // applyAndroidVersions refuses on its own too, before writing.
    await assertRejects(
      () => applyAndroidVersions(dir, undefined, '1.0" + "x', null),
      Error,
      "version name",
    );
    assertEquals(await Deno.readTextFile(join(dir, "android/app/build.gradle")), GRADLE);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile build: a flavor app id that is not reverse-DNS is refused", async () => {
  for (const bad of ["dev.example.${x}", 'dev.example.beta"', "dev", "dev example.app", ".dev"]) {
    assertThrows(() => assertFlavorAppId(bad), Error, "reverse-DNS", bad);
  }
  for (const good of ["dev.example.beta", "com.example.app-2", "a.b_c"]) assertFlavorAppId(good);
  const dir = await project();
  try {
    for (
      const config of [{ appIdSuffix: ".beta${x}" }, { appId: 'dev.example"; x="' }, {
        appIdSuffix: ".a b",
      }]
    ) {
      await assertRejects(
        () => planMobileBuild(options(dir, { flavor: { name: "f", config } })),
        Error,
        "reverse-DNS",
        JSON.stringify(config),
      );
      const snapshot = new NativeSnapshot(dir);
      await assertRejects(
        () => applyFlavor(dir, "android", config, snapshot),
        Error,
        "reverse-DNS",
      );
      assertEquals(snapshot.files, [], "nothing edited");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile build ios: the team id must be ten uppercase letters and digits", async () => {
  const dir = await project();
  try {
    for (const team of ["TEAM12345", "team123456", "TEAM123456</string>", "ABCDE 1234"]) {
      await assertRejects(
        () => planMobileBuild(options(dir, { platform: "ios", signing: { team } })),
        Error,
        "is not ten uppercase letters and digits",
        team,
      );
    }
    const plan = await planMobileBuild(options(dir, {
      platform: "ios",
      release: true,
      signing: { team: "TEAM123456" },
    }));
    assertStringIncludes(plan.exportOptions!.content, "<string>TEAM123456</string>");
    // An Android build ignores the iOS team (it may sit in the environment for both).
    await planMobileBuild(options(dir, { signing: { team: "not-a-team" } }));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---- the release gate: the doctor's release profile after cap sync ---------------------------

/** A fake doctor report with `findings`. */
function report(
  root: string,
  findings: MobileDoctorReport["findings"],
): () => Promise<MobileDoctorReport> {
  return () => Promise.resolve({ root, profile: "release", checks: [], findings });
}

Deno.test("mobile build --release: a doctor error stops the build after cap sync, before the native build", async () => {
  const dir = await project();
  try {
    const plan = await planMobileBuild(options(dir, { release: true, skipExport: true }));
    const error = {
      check: "webview-debugging",
      level: "error" as const,
      message: "capacitor.config.json: android.webContentsDebuggingEnabled is true",
      fix: "remove it",
      releaseGate: true,
    };
    const refused = deps({ doctor: report(dir, [error]) });
    await assertRejects(
      () => runMobileBuild(plan, {}, refused),
      Error,
      "[webview-debugging] capacitor.config.json: android.webContentsDebuggingEnabled is true",
    );
    assertEquals(refused.ran, ["npx"], "cap sync ran; Gradle never started");
    // Warnings do not block, and the other platform's native files do not block this one.
    const passed = deps({
      doctor: report(dir, [
        { ...error, level: "warning" },
        {
          ...error,
          check: "cleartext",
          message: "ios/App/App/Info.plist: NSAllowsLocalNetworking",
        },
      ]),
    });
    await assertRejects(() => runMobileBuild(plan, {}, passed), Error, "exited with 1");
    assertEquals(passed.ran, ["npx", gradlewCommand()]);
    // A doctor error outside the release-security gate is printed with its fix; the build goes on.
    const csp = {
      check: "csp",
      level: "error" as const,
      message: "out/index.html has no Content-Security-Policy meta tag",
      fix: "add one",
    };
    const warned = deps({ doctor: report(dir, [csp]) });
    await assertRejects(() => runMobileBuild(plan, {}, warned), Error, "exited with 1");
    assertEquals(warned.ran, ["npx", gradlewCommand()]);
    assertStringIncludes(warned.logged.join("\n"), "warning: [csp] out/index.html has no");
    // A debug build is not gated.
    const debug = deps({ doctor: report(dir, [error]) });
    await assertRejects(
      async () =>
        runMobileBuild(await planMobileBuild(options(dir, { skipExport: true })), {}, debug),
      Error,
      "exited with 1",
    );
    assertEquals(debug.ran, ["npx", gradlewCommand()]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile build --release: the real doctor refuses each release error", async () => {
  const config = (extra: Record<string, unknown>) =>
    JSON.stringify({ appId: "dev.example", appName: "R", webDir: "out", ...extra });
  const cases: Array<[string, Record<string, string>, "ios" | "android"]> = [
    [
      "webview-debugging",
      { "capacitor.config.json": config({ android: { webContentsDebuggingEnabled: true } }) },
      "android",
    ],
    [
      "allow-navigation",
      { "capacitor.config.json": config({ server: { allowNavigation: ["*"] } }) },
      "android",
    ],
    [
      "allow-navigation",
      { "capacitor.config.json": config({ server: { allowNavigation: ["http://api.example"] } }) },
      "ios",
    ],
    [
      "cleartext",
      {
        "android/app/src/main/AndroidManifest.xml":
          '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application ' +
          'android:usesCleartextTraffic="true"></application></manifest>',
      },
      "android",
    ],
    [
      "android-debuggable",
      {
        "android/app/src/main/AndroidManifest.xml":
          '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application ' +
          'android:debuggable="true"></application></manifest>',
      },
      "android",
    ],
    [
      "legacy-bridge",
      { "capacitor.config.json": config({ android: { useLegacyBridge: true } }) },
      "android",
    ],
    [
      "bridge-origin-guard",
      {
        "capacitor.config.json": config({
          server: { allowNavigation: ["https://partner.example"] },
          plugins: { DenextBridge: { frameGuard: false } },
        }),
      },
      "android",
    ],
    [
      "cleartext",
      {
        "ios/App/App/Info.plist": plist(
          "\t<key>NSAppTransportSecurity</key>\n\t<dict>\n\t\t<key>NSAllowsLocalNetworking</key>" +
            "\n\t\t<true/>\n\t</dict>",
        ),
      },
      "ios",
    ],
    [
      "cleartext",
      {
        "android/app/src/main/AndroidManifest.xml":
          '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application ' +
          'android:networkSecurityConfig="@xml/nsc"></application></manifest>',
        "android/app/src/main/res/xml/nsc.xml":
          '<network-security-config><base-config cleartextTrafficPermitted="true" />' +
          "</network-security-config>",
      },
      "android",
    ],
  ];
  for (const [check, files, platform] of cases) {
    const dir = await project(files);
    try {
      const plan = await planMobileBuild(options(dir, {
        platform,
        release: true,
        skipExport: true,
        ...(platform === "ios" ? { unsigned: true } : {}),
      }));
      const d = deps();
      await assertRejects(() => runMobileBuild(plan, {}, d), Error, `[${check}]`, check);
      assertEquals(d.ran, ["npx"], `${check}: only cap sync ran`);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("mobile build --release: an iOS-only release error does not block the Android build", async () => {
  const dir = await project({
    "ios/App/App/Info.plist": plist(
      "\t<key>NSAppTransportSecurity</key>\n\t<dict>\n\t\t<key>NSAllowsLocalNetworking</key>" +
        "\n\t\t<true/>\n\t</dict>",
    ),
  });
  try {
    const plan = await planMobileBuild(options(dir, { release: true, skipExport: true }));
    const d = deps();
    await assertRejects(() => runMobileBuild(plan, {}, d), Error, "exited with 1");
    assertEquals(d.ran, ["npx", gradlewCommand()]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile build --release: a flavor's https serverUrl is not a server-url error", async () => {
  const dir = await project();
  try {
    const plan = await planMobileBuild(options(dir, {
      release: true,
      skipExport: true,
      flavor: { name: "hosted", config: { serverUrl: "https://app.example" } },
    }));
    const d = deps();
    await assertRejects(() => runMobileBuild(plan, {}, d), Error, "exited with 1");
    assertEquals(d.ran, ["npx", gradlewCommand()]);
    // The flavor's edit is restored.
    assert(!(await Deno.readTextFile(join(dir, "capacitor.config.json"))).includes("app.example"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile build --release: a missing CSP builds with a warning; a wildcard allowNavigation is refused", async () => {
  const noCsp = { "out/index.html": "<!doctype html><html><head></head></html>" };
  const dir = await project(noCsp);
  try {
    const plan = await planMobileBuild(options(dir, { release: true, skipExport: true }));
    const d = deps();
    await assertRejects(() => runMobileBuild(plan, {}, d), Error, "exited with 1");
    assertEquals(d.ran, ["npx", gradlewCommand()], "the native build ran");
    assertStringIncludes(d.logged.join("\n"), "warning: [csp]");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  const wild = await project({
    ...noCsp,
    "capacitor.config.json": JSON.stringify({
      appId: "dev.example",
      webDir: "out",
      server: { allowNavigation: ["*"] },
    }),
  });
  try {
    const plan = await planMobileBuild(options(wild, { release: true, skipExport: true }));
    const d = deps();
    const err = await assertRejects(() => runMobileBuild(plan, {}, d), Error, "[allow-navigation]");
    assert(!err.message.includes("[csp]"), "only the release-security findings refuse");
    assertEquals(d.ran, ["npx"]);
  } finally {
    await Deno.remove(wild, { recursive: true });
  }
});

Deno.test("mobile build --release: NSAllowsArbitraryLoads, an insecure ATS domain and mixed content only warn", async () => {
  const cases: Array<[string, Record<string, string>, "ios" | "android"]> = [
    [
      "cleartext",
      {
        "ios/App/App/Info.plist": plist(
          "\t<key>NSAppTransportSecurity</key>\n\t<dict>\n\t\t<key>NSAllowsArbitraryLoads</key>" +
            "\n\t\t<true/>\n\t\t<key>NSExceptionDomains</key>\n\t\t<dict>\n\t\t\t<key>legacy.example</key>" +
            "\n\t\t\t<dict><key>NSExceptionAllowsInsecureHTTPLoads</key><true/></dict>\n\t\t</dict>" +
            "\n\t</dict>",
        ),
      },
      "ios",
    ],
    [
      "mixed-content",
      {
        "capacitor.config.json": JSON.stringify({
          appId: "dev.example",
          webDir: "out",
          android: { allowMixedContent: true },
        }),
      },
      "android",
    ],
  ];
  for (const [check, files, platform] of cases) {
    const dir = await project(files);
    try {
      const plan = await planMobileBuild(options(dir, {
        platform,
        release: true,
        skipExport: true,
        ...(platform === "ios" ? { unsigned: true } : {}),
      }));
      const d = deps();
      await assertRejects(() => runMobileBuild(plan, {}, d), Error, "exited with 1", check);
      assertEquals(d.ran.length, 2, `${check}: the native build ran`);
      assertStringIncludes(d.logged.join("\n"), `warning: [${check}]`);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
