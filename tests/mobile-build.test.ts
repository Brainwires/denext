// `denext mobile build` (src/build/mobile-build.ts + mobile-flavor.ts): the plan (commands,
// signing, artifact), secrets kept out of argv and output, flavor edits applied around the
// native build and restored, the sidecar, `--bump`, the crash backup, and the `mobile.flavors`
// config validation. Commands run through a fake runner: no Xcode, no Gradle.

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
  formatBuildPlan,
  formatCommand,
  gradlewCommand,
  iosHostError,
  type MobileBuildOptions,
  planMobileBuild,
  runMobileBuild,
  signingInputs,
} from "../src/build/mobile-build.ts";
import {
  androidVersions,
  bumpBuildNumber,
  iosVersions,
  NativeSnapshot,
  rebaseBundleIds,
  resolveFlavor,
  restoreInterruptedBuild,
  withAppName,
  withDisplayName,
} from "../src/build/mobile-flavor.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";

const PBXPROJ = await Deno.readTextFile(
  new URL("./fixtures/capacitor8/project.pbxproj", import.meta.url),
);

const GRADLE = `android {
    namespace = "dev.example"
    defaultConfig {
        applicationId "dev.example"
        versionCode 7
        versionName "1.4"
    }
}
`;

const STRINGS = `<resources>
  <string name="app_name">Receipts</string>
  <string name="title_activity_main">Receipts</string>
  <string name="package_name">dev.example</string>
</resources>
`;

const PLIST = `<plist version="1.0"><dict>
\t<key>CFBundleDisplayName</key>
\t<string>Receipts</string>
</dict></plist>
`;

async function project(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_mobile_build_" });
  const files: Record<string, string> = {
    "capacitor.config.json": JSON.stringify({
      appId: "dev.example",
      appName: "Receipts",
      webDir: "out",
    }),
    "ios/App/App.xcodeproj/project.pbxproj": PBXPROJ,
    "ios/App/App/Info.plist": PLIST,
    "android/app/build.gradle": GRADLE,
    "android/app/src/main/res/values/strings.xml": STRINGS,
  };
  for (const [path, content] of Object.entries(files)) {
    await Deno.mkdir(join(dir, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, path), content);
  }
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

Deno.test("mobile flavor: text edits of the Capacitor template shapes", () => {
  const pbx = [
    "PRODUCT_BUNDLE_IDENTIFIER = dev.example;",
    'PRODUCT_BUNDLE_IDENTIFIER = "dev.example.share";',
    "PRODUCT_BUNDLE_IDENTIFIER = dev.examples;",
  ].join("\n");
  assertEquals(
    rebaseBundleIds(pbx, "dev.example", "dev.example.beta").split("\n"),
    [
      "PRODUCT_BUNDLE_IDENTIFIER = dev.example.beta;",
      'PRODUCT_BUNDLE_IDENTIFIER = "dev.example.beta.share";',
      "PRODUCT_BUNDLE_IDENTIFIER = dev.examples;",
    ],
  );
  assertStringIncludes(withDisplayName(PLIST, "R & D"), "<string>R &amp; D</string>");
  assertStringIncludes(
    withDisplayName("<plist><dict>\n</dict></plist>", "X"),
    "<key>CFBundleDisplayName</key>",
  );
  const named = withAppName(STRINGS, "Receipts β");
  assertEquals(named.match(/Receipts β/g)?.length, 2);
  assertStringIncludes(named, "dev.example</string>");
  assertEquals(androidVersions(GRADLE), { build: 7, version: "1.4" });
  assertEquals(iosVersions("CURRENT_PROJECT_VERSION = 3;\nMARKETING_VERSION = 2.1;"), {
    build: 3,
    version: "2.1",
  });
});

Deno.test("mobile flavor: resolveFlavor names the declared flavors", () => {
  const mobile = { flavors: { staging: { appIdSuffix: ".staging" } } };
  assertEquals(resolveFlavor(mobile, "staging").config.appIdSuffix, ".staging");
  assertThrows(() => resolveFlavor(mobile, "beta"), Error, "declared: staging");
  assertThrows(() => resolveFlavor(undefined, "beta"), Error, "none declared");
  assertThrows(() => resolveFlavor(mobile, "toString"), Error, "no flavor");
});

Deno.test("mobile build: signing inputs from flags, then the environment", () => {
  const env: Record<string, string> = {
    DENEXT_IOS_TEAM: "TEAM123456",
    ASC_ISSUER_ID: "issuer-uuid",
    DENEXT_ANDROID_KEYSTORE_PASSWORD: "",
    ANDROID_KEYSTORE_PASSWORD: "fallback",
  };
  const s = signingInputs(
    { ascKeyPath: "/keys/AuthKey_ABC123XYZ9.p8", team: "FLAGTEAM01" },
    (n) => env[n],
  );
  assertEquals(s.team, "FLAGTEAM01");
  assertEquals(s.ascKeyId, "ABC123XYZ9");
  assertEquals(s.ascIssuerId, "issuer-uuid");
  assertEquals(s.keystorePassword, "fallback");
});

Deno.test("mobile build: Android plans — debug, unsigned release, keystore via GRADLE_OPTS", async () => {
  const dir = await project();
  try {
    const debug = await planMobileBuild(options(dir));
    assertEquals(debug.commands.map((c) => c.args[0] === "run" ? "export" : c.args.at(-1)), [
      "export",
      "android",
      "assembleDebug",
    ]);
    assertEquals(debug.signing.mode, "debug");
    assertEquals(debug.version, "1.4");
    assertEquals(debug.buildNumber, 7);
    assert(debug.artifact.endsWith(join("dist/mobile/android/Receipts-debug.apk")));

    const unsigned = await planMobileBuild(options(dir, { release: true, skipExport: true }));
    assertEquals(unsigned.signing.mode, "unsigned");
    assert(unsigned.warnings[0].includes("unsigned"));
    assert(unsigned.artifact.endsWith("Receipts-release-unsigned.aab"));
    assertEquals(unsigned.commands[0].args, ["cap", "sync", "android"]);

    const signed = await planMobileBuild(options(dir, {
      release: true,
      apk: true,
      jobs: 2,
      gradleOpts: "-Xmx2g",
      signing: { keystore: "/k/upload.jks", keyAlias: "upload", keystorePassword: "s3cret-pw" },
    }));
    const gradle = signed.commands.at(-1)!;
    assertEquals(gradle.args, ["assembleRelease", "--max-workers=2"]);
    assert(!gradle.args.join(" ").includes("s3cret-pw"), "no secret in argv");
    assertStringIncludes(
      gradle.env!.GRADLE_OPTS,
      "-Xmx2g -Dorg.gradle.project.android.injected.signing.store.file=/k/upload.jks",
    );
    assertStringIncludes(gradle.env!.GRADLE_OPTS, "key.password=s3cret-pw");
    const shown = formatBuildPlan(signed);
    assert(!shown.includes("s3cret-pw"), "no secret in the printed plan");
    assertStringIncludes(shown, `[env: GRADLE_OPTS] ${gradlewCommand()} assembleRelease`);
    assertStringIncludes(shown, "upload keystore /k/upload.jks, alias upload");

    await assertRejects(
      () => planMobileBuild(options(dir, { release: true, signing: { keystore: "/k.jks" } })),
      Error,
      "key alias",
    );
    await assertRejects(
      () =>
        planMobileBuild(options(dir, {
          release: true,
          signing: { keystore: "/k.jks", keyAlias: "a", keystorePassword: "has space" },
        })),
      Error,
      "GRADLE_OPTS",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile build: iOS plans — automatic signing with an API key, and --unsigned", async () => {
  const dir = await project();
  try {
    const signed = await planMobileBuild(options(dir, {
      platform: "ios",
      release: true,
      buildNumber: 12,
      versionName: "2.0",
      jobs: 2,
      signing: {
        team: "TEAM123456",
        ascKeyPath: "/k/AuthKey_X.p8",
        ascKeyId: "X",
        ascIssuerId: "I",
      },
    }));
    const [, , archive, exportCmd] = signed.commands;
    assertEquals(archive.cmd, "xcodebuild");
    for (
      const arg of [
        "archive",
        "Release",
        "-allowProvisioningUpdates",
        "DEVELOPMENT_TEAM=TEAM123456",
        "CURRENT_PROJECT_VERSION=12",
        "MARKETING_VERSION=2.0",
        "-authenticationKeyIssuerID",
      ]
    ) {
      assert(archive.args.includes(arg), arg);
    }
    assertEquals(archive.args[archive.args.indexOf("-jobs") + 1], "2");
    assertEquals(exportCmd.args[0], "-exportArchive");
    assertStringIncludes(signed.exportOptions!.content, "<string>app-store-connect</string>");
    assertStringIncludes(signed.exportOptions!.content, "<string>TEAM123456</string>");
    assertEquals(signed.version, "2.0");
    assertEquals(signed.buildNumber, 12);
    assert(signed.artifact.endsWith("Receipts-release.ipa"));

    const debug = await planMobileBuild(options(dir, { platform: "ios", skipExport: true }));
    assertStringIncludes(debug.exportOptions!.content, "<string>debugging</string>");

    const unsigned = await planMobileBuild(
      options(dir, { platform: "ios", unsigned: true, skipExport: true }),
    );
    assertEquals(unsigned.commands.length, 2);
    assert(unsigned.commands[1].args.includes("CODE_SIGNING_ALLOWED=NO"));
    assert(unsigned.archive?.endsWith("App.xcarchive"));
    assertEquals(unsigned.exportOptions, undefined);
    assert(unsigned.artifact.endsWith("Receipts-debug-unsigned.ipa"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile build: a missing native project is refused", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "capacitor.config.json"), "{}");
    await assertRejects(() => planMobileBuild(options(dir)), Error, "npx cap add android");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** A zip with the given entry names (stored, empty), enough for the artifact check. */
function zipOf(names: string[]): Uint8Array {
  const enc = new TextEncoder();
  const central: number[] = [];
  for (const name of names) {
    const n = enc.encode(name);
    const h = new Uint8Array(46 + n.length);
    const v = new DataView(h.buffer);
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(28, n.length, true);
    h.set(n, 46);
    central.push(...h);
  }
  const eocd = new Uint8Array(22);
  const v = new DataView(eocd.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, names.length, true);
  v.setUint16(10, names.length, true);
  v.setUint32(12, central.length, true);
  v.setUint32(16, 0, true);
  return new Uint8Array([...central, ...eocd]);
}

Deno.test("mobile build: run applies the flavor around the native build, restores it, writes the sidecar", async () => {
  const dir = await project();
  try {
    const plan = await planMobileBuild(options(dir, {
      release: true,
      flavor: {
        name: "staging",
        config: {
          appIdSuffix: ".staging",
          appName: "Receipts β",
          serverUrl: "https://staging.example",
        },
      },
      buildNumber: 42,
      signing: { keystore: "/k.jks", keyAlias: "upload", keystorePassword: "pw" },
    }));
    assertEquals(plan.appId, "dev.example.staging");
    const seen: { cmd: BuildCommand; gradle?: string; strings?: string; cap?: string }[] = [];
    const logs: string[] = [];
    const artifact = await runMobileBuild(plan, { buildNumber: 42 }, {
      log: (l) => logs.push(l),
      now: () => new Date("2026-09-27T00:00:00Z"),
      run: async (cmd) => {
        const entry: (typeof seen)[number] = { cmd };
        if (cmd.cmd === gradlewCommand()) {
          entry.gradle = await Deno.readTextFile(join(dir, "android/app/build.gradle"));
          entry.strings = await Deno.readTextFile(
            join(dir, "android/app/src/main/res/values/strings.xml"),
          );
          entry.cap = await Deno.readTextFile(join(dir, "capacitor.config.json"));
          await Deno.mkdir(join(plan.produced, ".."), { recursive: true });
          await Deno.writeFile(
            plan.produced,
            zipOf(["BundleConfig.pb", "base/manifest/AndroidManifest.xml", "META-INF/UPLOAD.RSA"]),
          );
        }
        seen.push(entry);
        return { code: 0 };
      },
    });
    assertEquals(seen.map((s) => s.cmd.cmd), ["deno", "npx", gradlewCommand()]);
    // The export ran before the flavor was applied; the native build saw it.
    const during = seen[2];
    assertStringIncludes(during.gradle!, 'applicationId "dev.example.staging"');
    assertStringIncludes(during.gradle!, "versionCode 42");
    assertStringIncludes(during.strings!, "Receipts β");
    assertEquals(JSON.parse(during.cap!).server.url, "https://staging.example");
    // Afterwards every file is as it was.
    assertEquals(await Deno.readTextFile(join(dir, "android/app/build.gradle")), GRADLE);
    assertEquals(
      await Deno.readTextFile(join(dir, "android/app/src/main/res/values/strings.xml")),
      STRINGS,
    );
    assertEquals(
      JSON.parse(await Deno.readTextFile(join(dir, "capacitor.config.json"))).appId,
      "dev.example",
    );
    assert(logs.some((l) => l.includes("restored the 3 file(s)")));
    assertEquals(artifact.signed, true);
    assertEquals(artifact.appId, "dev.example.staging");
    assertEquals(artifact.buildNumber, 42);
    assertEquals(artifact.flavor, "staging");
    assert(artifact.path.endsWith(join("android-staging", "Receipts-staging-release.aab")));
    const sidecar = JSON.parse(await Deno.readTextFile(`${artifact.path}.json`));
    assertEquals(sidecar.sha256, artifact.sha256);
    assertEquals(sidecar.builtAt, "2026-09-27T00:00:00.000Z");
    assert(!logs.join("\n").includes("pw\n"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile build --release: refuses a dev server.url / cleartext or a left mobile-dev backup; a flavor's serverUrl is deliberate", async () => {
  const dir = await project();
  try {
    const ran: string[] = [];
    const deps = {
      log: () => {},
      run: (c: BuildCommand) => {
        ran.push(c.cmd);
        return Promise.resolve({ code: 1 });
      },
    };
    const cap = join(dir, "capacitor.config.json");
    const base = { appId: "dev.example", appName: "Receipts", webDir: "out" };
    const release = () => planMobileBuild(options(dir, { release: true, skipExport: true }));
    // A dev session's server block (LAN http + cleartext) is refused before anything runs.
    await Deno.writeTextFile(
      cap,
      JSON.stringify({ ...base, server: { url: "http://192.168.1.5:3000", cleartext: true } }),
    );
    await assertRejects(
      async () => runMobileBuild(await release(), {}, deps),
      Error,
      "server.url is a dev server (http://192.168.1.5:3000)",
    );
    // Cleartext alone (a https url, but plain http allowed) is refused too.
    await Deno.writeTextFile(
      cap,
      JSON.stringify({ ...base, server: { url: "https://app.example", cleartext: true } }),
    );
    await assertRejects(
      async () => runMobileBuild(await release(), {}, deps),
      Error,
      "server.cleartext is true",
    );
    // A TS config is read the same way.
    await Deno.remove(cap);
    await Deno.writeTextFile(
      join(dir, "capacitor.config.ts"),
      'export default { appId: "dev.example", webDir: "out", server: { url: "http://localhost:3000" } };\n',
    );
    await assertRejects(
      async () => runMobileBuild(await release(), {}, deps),
      Error,
      "dev server (http://localhost:3000)",
    );
    await Deno.remove(join(dir, "capacitor.config.ts"));
    await Deno.writeTextFile(cap, JSON.stringify(base));
    // A mobile-dev backup on disk: the session's config may still be live.
    await Deno.mkdir(join(dir, ".denext"), { recursive: true });
    await Deno.writeTextFile(join(dir, ".denext", "mobile-dev-backup.json"), "{}");
    await assertRejects(
      async () => runMobileBuild(await release(), {}, deps),
      Error,
      "mobile dev --restore",
    );
    assertEquals(ran, [], "nothing ran for a refused release");
    // A debug build is not gated.
    await assertRejects(
      async () =>
        runMobileBuild(await planMobileBuild(options(dir, { skipExport: true })), {}, deps),
      Error,
      "exited with 1",
    );
    await Deno.remove(join(dir, ".denext", "mobile-dev-backup.json"));
    // A flavor that sets the server on purpose passes the gate (and reaches the build).
    await Deno.writeTextFile(
      cap,
      JSON.stringify({ ...base, server: { url: "http://10.0.0.2:8080", cleartext: true } }),
    );
    const flavored = await planMobileBuild(options(dir, {
      release: true,
      skipExport: true,
      flavor: { name: "lab", config: { serverUrl: "http://10.0.0.2:8080" } },
    }));
    ran.length = 0;
    await assertRejects(() => runMobileBuild(flavored, {}, deps), Error, "exited with 1");
    assertEquals(ran, ["npx"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile build: a failed native build still restores the flavor edits", async () => {
  const dir = await project();
  try {
    const plan = await planMobileBuild(options(dir, {
      skipExport: true,
      flavor: { name: "beta", config: { appId: "dev.example.beta" } },
    }));
    await assertRejects(
      () =>
        runMobileBuild(plan, {}, {
          log: () => {},
          run: (c) => Promise.resolve({ code: c.cmd === gradlewCommand() ? 1 : 0 }),
        }),
      Error,
      "exited with 1",
    );
    assertEquals(await Deno.readTextFile(join(dir, "android/app/build.gradle")), GRADLE);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile build: the crash backup restores a killed build's edits; --bump is permanent", async () => {
  const dir = await project();
  try {
    const snap = new NativeSnapshot(dir);
    const gradle = join(dir, "android/app/build.gradle");
    const extra = join(dir, "android/new.txt");
    await snap.save(gradle);
    await snap.save(extra);
    await Deno.writeTextFile(gradle, "changed");
    await Deno.writeTextFile(extra, "new");
    // The process dies here: a fresh run finds the backup.
    assertEquals((await restoreInterruptedBuild(dir)).sort(), [
      "android/app/build.gradle",
      "android/new.txt",
    ]);
    assertEquals(await Deno.readTextFile(gradle), GRADLE);
    await assertRejects(() => Deno.stat(extra));
    assertEquals(await restoreInterruptedBuild(dir), []);

    assertEquals(await bumpBuildNumber(dir, "android"), {
      from: 7,
      to: 8,
      file: "android/app/build.gradle",
    });
    assertStringIncludes(await Deno.readTextFile(gradle), "versionCode 8");
    const ios = await bumpBuildNumber(dir, "ios");
    assertEquals(ios.to, ios.from + 1);
    assertEquals(
      iosVersions(await Deno.readTextFile(join(dir, "ios/App/App.xcodeproj/project.pbxproj")))
        .build,
      ios.to,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile build: a planted crash-backup index cannot write or delete outside the project", async () => {
  const parent = await Deno.makeTempDir({ prefix: "denext_mobile_escape_" });
  const dir = join(parent, "app");
  await Deno.mkdir(dir);
  try {
    const victim = join(parent, "victim.txt");
    await Deno.writeTextFile(victim, "keep me");
    const backup = join(dir, ".denext", "mobile-build", "backup");
    await Deno.mkdir(join(backup, "files", "a"), { recursive: true });
    await Deno.writeTextFile(join(parent, "planted.txt"), "planted");
    await Deno.writeTextFile(
      join(backup, "index.json"),
      JSON.stringify({
        "a/../../victim.txt": false, // delete outside
        "../victim.txt": false,
        [victim]: false, // absolute
        "a/../../written.txt": true, // write outside (from a source outside files/ too)
        "ok.txt": false,
      }),
    );
    await Deno.writeTextFile(join(dir, "ok.txt"), "temp");
    assertEquals(await restoreInterruptedBuild(dir), ["ok.txt"]);
    assertEquals(await Deno.readTextFile(victim), "keep me");
    await assertRejects(() => Deno.stat(join(parent, "written.txt")));
    await assertRejects(() => Deno.stat(join(dir, "ok.txt")), Deno.errors.NotFound);
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("mobile build: formatCommand quotes arguments and lists env by name only", () => {
  assertEquals(
    formatCommand({ cmd: "x", args: ["a b", "it's", "plain"], cwd: ".", env: { SECRET: "v" } }),
    "[env: SECRET] x 'a b' 'it'\\''s' plain",
  );
});

Deno.test("config: mobile.flavors is validated", () => {
  const ok: DenextConfig = {
    mobile: {
      flavors: {
        staging: {
          appIdSuffix: ".staging",
          serverUrl: "https://s.example",
          backgroundColor: "#123",
          env: { A: "1" },
        },
        "beta-2": { appId: "com.example.beta" },
      },
    },
  };
  validateDenextConfig(ok);
  const bad = (mobile: unknown, message: string) =>
    assertThrows(() => validateDenextConfig({ mobile } as DenextConfig), Error, message);
  bad([], "`mobile` must be an object");
  bad({ flavors: [] }, "`mobile.flavors` must be an object");
  bad({ flavors: { Staging: {} } }, "lowercase");
  bad({ flavors: { s: { appIdSuffix: "staging" } } }, 'must start with "."');
  bad({ flavors: { s: { appId: "1bad" } } }, "reverse-DNS");
  bad({ flavors: { s: { serverUrl: "not a url" } } }, "absolute URL");
  bad({ flavors: { s: { backgroundColor: "red" } } }, "hex colour");
  bad({ flavors: { s: { appName: 3 } } }, "must be a string");
  bad({ flavors: { s: { env: { A: 1 } } } }, "string values");
});

/** Run the `mobile` verb, capturing console.log. */
async function runVerb(
  positionals: string[],
  flags: Record<string, string | boolean>,
  json = false,
) {
  const { createMobileCommand } = await import("../src/cli/commands/mobile.ts");
  const log = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await createMobileCommand().run({
      positionals,
      flags,
      global: { json, verbose: false, quiet: false },
      rest: [],
    });
  } finally {
    console.log = log;
  }
  return lines.join("\n");
}

Deno.test("denext mobile build / assets --dry-run through the verb", async () => {
  const dir = await project();
  try {
    const plan = await runVerb(["build", "ios"], {
      dir,
      "dry-run": true,
      unsigned: true,
      release: true,
    });
    assertStringIncludes(plan, "denext mobile build ios --dry-run (nothing runs)");
    assertStringIncludes(plan, "CODE_SIGNING_ALLOWED=NO");
    Deno.env.set("DENEXT_ANDROID_KEYSTORE_PASSWORD", "pw");
    const json = JSON.parse(
      await runVerb(["build", "android"], {
        dir,
        "dry-run": true,
        release: true,
        keystore: "/k.jks",
        "key-alias": "a",
      }, true),
    );
    assertEquals(json.signing.mode, "keystore");
    assertEquals(json.commands.at(-1).env, { GRADLE_OPTS: "***" });

    await Deno.mkdir(join(dir, "assets"));
    const { encodePng, solid } = await import("../src/build/png-raster.ts");
    await Deno.writeFile(
      join(dir, "assets/icon.png"),
      await encodePng(solid(16, 16, { r: 1, g: 2, b: 3 })),
    );
    const assets = await runVerb(["assets"], { dir, "dry-run": true, platform: "android" });
    assertStringIncludes(
      assets,
      "would write  android/app/src/main/res/mipmap-mdpi/ic_launcher.png",
    );
  } finally {
    Deno.env.delete("DENEXT_ANDROID_KEYSTORE_PASSWORD");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile build: the Gradle wrapper per host; iOS steps name macOS off a Mac", () => {
  assertEquals(gradlewCommand("darwin"), "./gradlew");
  assertEquals(gradlewCommand("linux"), "./gradlew");
  assertEquals(gradlewCommand("windows"), "./gradlew.bat");
  assertEquals(iosHostError("build", "darwin"), undefined);
  assertStringIncludes(iosHostError("build", "windows")!, "needs macOS with Xcode (xcodebuild)");
  assertStringIncludes(iosHostError("submit", "linux")!, "xcrun altool");
  assertStringIncludes(iosHostError("submit", "windows")!, "--dry-run");
});

Deno.test("mobile build: a Windows keystore path reaches GRADLE_OPTS with forward slashes", {
  ignore: Deno.build.os !== "windows", // the `\` → `/` rewrite only applies to Windows paths
}, async () => {
  const dir = await project();
  try {
    const plan = await planMobileBuild(options(dir, {
      release: true,
      signing: { keystore: "C:\\keys\\upload.jks", keyAlias: "a", keystorePassword: "pw" },
    }));
    assertStringIncludes(
      plan.commands.at(-1)!.env!.GRADLE_OPTS,
      "signing.store.file=C:/keys/upload.jks",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
