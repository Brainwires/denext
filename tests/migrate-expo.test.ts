// `denext migrate --from expo` on fixture Expo apps: the static app-config reader (never
// running project code), the web entry, the generated deno.json / denext.config.ts /
// capacitor.config.ts, the `denext mobile add` plan, the expo-* shim report and the
// native-only package flags, and the CLI report.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { migrateProject } from "../src/build/migrate.ts";
import {
  expoMobilePlan,
  readExpoAppConfig,
  readStaticAppConfig,
} from "../src/build/expo-migrate.ts";
import { migrateCommand } from "../src/cli/commands/migrate.ts";
import { capture, makeCtx } from "./_cli-coverage-helpers.ts";

/** Write `files` (relative path → contents; objects are JSON) under `root`. */
async function writeTree(root: string, files: Record<string, unknown>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, typeof body === "string" ? body : JSON.stringify(body));
  }
}

/** Run `fn` on a fresh temp dir holding `files`. */
async function withApp(
  files: Record<string, unknown>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_migrate_expo_" }));
  try {
    await writeTree(dir, files);
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** A T3-Code-shaped app: a dynamic app.config.ts, `main: index.ts`, pnpm, native modules. */
const T3_LIKE: Record<string, unknown> = {
  "package.json": {
    name: "@acme/mobile",
    main: "index.ts",
    dependencies: {
      expo: "~57.0.18",
      "expo-haptics": "~57.0.2",
      "expo-secure-store": "~57.0.2",
      "expo-sqlite": "~57.0.2",
      "expo-camera": "~57.0.4",
      "expo-location": "~57.0.1",
      react: "19.2.3",
      "react-native": "0.86.3",
      "react-native-nitro-markdown": "^0.5.0",
      "react-native-webview": "^13.16.1",
      "react-native-reanimated": "4.5.5",
      "@acme/terminal-native": "file:./modules/terminal",
      "@acme/pure-js": "1.0.0",
      "react-native-image-viewing": "^0.2.2",
      "not-installed": "1.0.0",
    },
    devDependencies: { tailwindcss: "^4.0.0" },
  },
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "index.ts": 'import { registerRootComponent } from "expo";\n',
  "global.css": '@import "tailwindcss";\n',
  "app.config.ts": `import type { ExpoConfig } from "expo/config";
import { loadEnv } from "../../scripts/env.ts";
Deno.writeTextFileSync("EXECUTED", "the config ran");
const env = loadEnv();
const APP_VARIANT = env.APP_VARIANT ?? "production";
const VARIANTS = {
  production: { appName: "Acme", scheme: "acme", bundle: "com.acme.app" },
} as const;
const variant = VARIANTS[APP_VARIANT];
const personal = env.PERSONAL === "1";
const sqlitePlugin = ["expo-sqlite", { enableFTS: true }];
const config: ExpoConfig = {
  name: variant.appName,
  slug: "acme-app",
  version: "1.3.1",
  scheme: variant.scheme,
  updates: { url: "https://u.expo.dev/abc", enabled: env.UPDATES !== "0" },
  ios: {
    bundleIdentifier: personal ? env.BUNDLE : variant.bundle,
    associatedDomains: [\`applinks:\${"links.acme.dev"}\`, \`webcredentials:\${variant.bundle}\`],
    infoPlist: {
      NSCameraUsageDescription: "Scan codes",
      NSMicrophoneUsageDescription: \`Voice for \${"Acme"}\`,
      NSLocalNetworkUsageDescription: env.LOCAL_NET,
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: { package: variant.bundle, permissions: ["RECORD_AUDIO", "android.permission.CAMERA"] },
  plugins: [
    "expo-secure-store",
    ...(personal ? [] : [sqlitePlugin, "./plugins/withThing.cjs"]),
    ["expo-camera", { cameraPermission: "cam" }],
  ],
  extra: { eas: { projectId: "abc" }, token: env.TOKEN },
} satisfies ExpoConfig;
export default config;
`,
  // Installed packages: a Nitro module, a codegen component with no web build, a codegen
  // package WITH a web build (not flagged), an Expo native local module, a pure-JS package.
  "node_modules/react-native-nitro-markdown/package.json": { name: "react-native-nitro-markdown" },
  "node_modules/react-native-webview/package.json": {
    name: "react-native-webview",
    codegenConfig: { name: "RNCWebViewSpec" },
  },
  "node_modules/react-native-reanimated/package.json": {
    name: "react-native-reanimated",
    codegenConfig: { name: "rnreanimated" },
  },
  "node_modules/react-native-reanimated/lib/module/js-reanimated/index.web.js": "export {};\n",
  "modules/terminal/package.json": { name: "@acme/terminal-native" },
  "modules/terminal/expo-module.config.json": { platforms: ["apple", "android"] },
  "node_modules/@acme/pure-js/package.json": { name: "@acme/pure-js" },
  // Pure JS, but a module that exists only as .ios / .android variants.
  "node_modules/react-native-image-viewing/package.json": { name: "react-native-image-viewing" },
  "node_modules/react-native-image-viewing/dist/index.js": "export {};\n",
  "node_modules/react-native-image-viewing/dist/components/ImageItem.ios.js": "export {};\n",
  "node_modules/react-native-image-viewing/dist/components/ImageItem.android.js": "export {};\n",
  "node_modules/react-native-image-viewing/dist/components/Ok.ios.js": "export {};\n",
  "node_modules/react-native-image-viewing/dist/components/Ok.js": "export {};\n",
  "node_modules/shiki/package.json": { name: "shiki" },
  "metro.config.js": `const path = require("node:path");
const config = getDefaultConfig(__dirname);
config.resolver = {
  ...config.resolver,
  extraNodeModules: {
    ...config.resolver?.extraNodeModules,
    "@acme/generated-licenses": path.join(__dirname, ".generated", "licenses"),
    shiki: path.dirname(require.resolve("shiki/package.json")),
  },
};
module.exports = config;
`,
};

Deno.test("expo app config: read statically — consts, members, templates, conditionals", async () => {
  const value = await readStaticAppConfig(`
    const BASE = { id: "com.x", host: "x.dev" } as const;
    const list = ["a", ...(flag() ? ["b"] : ["c"])];
    export default ({ config }) => ({
      ...config,
      id: BASE.id,
      url: \`https://\${BASE.host}/p\`,
      same: cond ? "s" : "s",
      differ: cond ? "a" : "b",
      computed: process.env.X,
      call: make(),
      list,
      nested: { deep: [1, { k: BASE.host }] },
    });`);
  assertEquals(value?.id, "com.x");
  assertEquals(value?.url, "https://x.dev/p");
  assertEquals(value?.same, "s");
  assertEquals(value?.list, ["a", "b", "c"], "both branches of a spread conditional");
  assertEquals(value?.nested, { deep: [1, { k: "x.dev" }] });
  assert(typeof value?.computed === "symbol" && typeof value?.call === "symbol", "unknown");
  assertEquals(
    await readStaticAppConfig('module.exports = { expo: { name: "cjs" } };'),
    { name: "cjs" },
    "module.exports and the expo key",
  );
  assertEquals(
    await readStaticAppConfig("function f() { return { name: 'fn' }; } export default f;"),
    { name: "fn" },
  );
  assertEquals(await readStaticAppConfig("export default makeConfig();"), null);
  assertEquals(await readStaticAppConfig("this is not ( valid"), null);
});

Deno.test("migrate --from expo: a T3-shaped app (dynamic config, pnpm, native modules)", async () => {
  await withApp(T3_LIKE, async (dir) => {
    const r = await migrateProject(dir, { from: "expo", denextLocalPath: Deno.cwd() });
    assertEquals(r.kind, "expo");
    await assertRejectsExecuted(dir);
    const e = r.expo!;

    // The config: literal parts read, code-dependent parts listed, nothing executed.
    assertEquals(e.config.source, "app.config.ts");
    assertEquals(e.config.unresolved.sort(), [
      "android.package",
      "ios.bundleIdentifier",
      "name",
      "scheme",
    ]);
    assertEquals(e.capacitor.appId, "com.example.acmeapp", "a placeholder from the slug");
    assertEquals(e.capacitor.placeholderId, true);
    assertEquals(e.capacitor.appName, "acme-app");

    // The mobile plan: packages, plugins (both branches), usage strings and permissions.
    const caps = e.mobile.capabilities.map((c) => c.capability);
    assertEquals(caps, ["haptics", "secure-store", "deep-links", "camera", "barcode", "sqlite"]);
    assertEquals(e.mobile.domains, ["links.acme.dev"]);
    assertEquals(
      e.mobile.command,
      "denext mobile add haptics secure-store deep-links camera barcode sqlite " +
        "--domain links.acme.dev",
    );
    assertEquals(e.mobile.manualPlist, {
      NSCameraUsageDescription: "Scan codes",
      NSMicrophoneUsageDescription: "Voice for Acme",
      NSLocalNetworkUsageDescription: null,
    });
    assertEquals(e.mobile.manualPermissions, ["android.permission.RECORD_AUDIO"]);

    // The dependency report.
    const status = Object.fromEntries(e.deps.expo.map((p) => [p.name, p.status]));
    assertEquals(status["expo-sqlite"], "partial");
    assertEquals(status["expo-haptics"], "full");
    assertEquals(status["expo-location"], "none");
    assertEquals(e.deps.nativeOnly, [
      { name: "@acme/terminal-native", kind: "Expo native module" },
      {
        name: "react-native-image-viewing",
        kind: "iOS / Android files only (dist/components/ImageItem has no web or plain variant)",
      },
      { name: "react-native-nitro-markdown", kind: "Nitro module (JSI)" },
      { name: "react-native-webview", kind: "TurboModule / Fabric component (codegen)" },
    ]);
    assertEquals(e.metro, {
      file: "metro.config.js",
      extraModules: ["@acme/generated-licenses"],
      resolveRequest: false,
    });
    assertEquals(e.deps.notInstalled, ["not-installed"]);
    assertEquals(e.missingPackages, ["react-native-web", "@sqlite.org/sqlite-wasm"]);
    assertEquals(e.tailwindInput, "./global.css");
    assertEquals(e.expoRouter, false);

    // The generated files.
    const cfg = await Deno.readTextFile(join(dir, "denext.config.ts"));
    assertStringIncludes(cfg, 'mode: "spa"');
    assertStringIncludes(cfg, "reactNative: true,");
    assertStringIncludes(cfg, 'entry: "./index.ts"');
    assertStringIncludes(cfg, "precompress: false");
    assertStringIncludes(cfg, "__DENEXT_EXPO_CONFIG__");
    const head = /globalThis\.__DENEXT_EXPO_CONFIG__=(\{.*?\})<\/script>/.exec(
      JSON.parse(`"${/head: "((?:[^"\\]|\\.)*)"/.exec(cfg)![1]}"`),
    )![1];
    assertEquals(JSON.parse(head), {
      slug: "acme-app",
      version: "1.3.1",
      updates: { url: "https://u.expo.dev/abc" },
      extra: { eas: { projectId: "abc" } },
    });
    const deno = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    assertEquals(deno.nodeModulesDir, "manual");
    assert(String(deno.imports.react).includes("compat/react.ts"), "react → denext compat");
    for (const t of ["dev", "build", "export", "start", "mobile:sync", "mobile:ios"]) {
      assert(deno.tasks[t], t);
    }
    const cap = await Deno.readTextFile(join(dir, "capacitor.config.ts"));
    assertStringIncludes(cap, 'appId: "com.example.acmeapp"');
    assertStringIncludes(cap, "TODO: a placeholder");
    assertStringIncludes(cap, 'webDir: "out"');

    // Re-running overwrites its own files; a hand-authored config is kept.
    await Deno.writeTextFile(join(dir, "capacitor.config.ts"), "// mine\n");
    const again = await migrateProject(dir, { from: "expo", denextLocalPath: Deno.cwd() });
    assertEquals(again.expo!.capacitor.configWritten, false);
    assertEquals(await Deno.readTextFile(join(dir, "capacitor.config.ts")), "// mine\n");
  });
});

/** The dynamic config was only parsed: its top-level side effect never ran. */
async function assertRejectsExecuted(dir: string): Promise<void> {
  const ran = await Deno.stat(join(dir, "EXECUTED")).then(() => true, () => false);
  assertEquals(ran, false, "migrate must not execute app.config.ts");
}

/** An app.json app with Expo's default entry (no `main`: ./App). */
const APP_JSON_APP: Record<string, unknown> = {
  "package.json": {
    name: "simple",
    dependencies: { expo: "~57.0.18", "expo-linking": "~57.0.8", react: "19.2.3" },
  },
  "App.tsx": "export default function App() { return null; }\n",
  "app.json": {
    expo: {
      name: "Simple App",
      slug: "simple",
      scheme: ["simple", "simple-alt"],
      ios: {
        bundleIdentifier: "dev.simple.app",
        associatedDomains: ["applinks:simple.dev"],
        infoPlist: { NSFaceIDUsageDescription: "Unlock" },
      },
      android: { package: "dev.simple.android", permissions: ["VIBRATE", "INTERNET"] },
      extra: { apiUrl: "https://api.simple.dev" },
    },
  },
};

Deno.test("migrate --from expo: app.json, Expo's default App entry, schemes and domains", async () => {
  await withApp({ ...APP_JSON_APP, "ios/Podfile": "" }, async (dir) => {
    const r = await migrateProject(dir, { denextLocalPath: Deno.cwd() });
    assertEquals(r.kind, "expo", "auto-detected");
    const e = r.expo!;
    assertEquals(e.config.source, "app.json");
    assertEquals(e.config.unresolved, []);
    assertEquals(e.capacitor, {
      appId: "dev.simple.app",
      appName: "Simple App",
      placeholderId: false,
      configWritten: true,
    });
    assertEquals(e.generatedEntry, { path: "index.web.ts", kind: "app" });
    assertEquals(r.spa!.entry, "./index.web.ts");
    const entry = await Deno.readTextFile(join(dir, "index.web.ts"));
    assertStringIncludes(entry, 'import App from "./App";');
    assertStringIncludes(entry, "registerRootComponent(App);");
    assertEquals(r.spa!.nodeModulesDir, "auto", "no lockfile");
    assertEquals(
      e.mobile.command,
      "denext mobile add haptics deep-links --scheme simple --scheme simple-alt " +
        "--domain simple.dev",
    );
    assertEquals(e.mobile.manualPlist, { NSFaceIDUsageDescription: "Unlock" });
    assertEquals(e.mobile.manualPermissions, [], "INTERNET needs nothing");
    assertEquals(e.prebuildFolders, ["ios"]);
  });
});

Deno.test("migrate --from expo: a dynamic config that is all code falls back to app.json", async () => {
  await withApp({
    ...APP_JSON_APP,
    "app.config.js": "module.exports = require('./make-config')();\n",
  }, async (dir) => {
    const config = await readExpoAppConfig(dir);
    assertEquals(config.source, "app.config.js + app.json");
    assertStringIncludes(config.notes[0], "app.config.js could not be read statically");
    assertEquals(config.iosBundleIdentifier, "dev.simple.app");
  });
});

Deno.test("migrate --from expo: a function config over app.json overrides what it can read", async () => {
  await withApp({
    ...APP_JSON_APP,
    "app.config.ts": `export default ({ config }) => ({
      ...config,
      name: "Dynamic",
      ios: { ...config.ios, bundleIdentifier: process.env.BUNDLE_ID },
    });\n`,
  }, async (dir) => {
    const config = await readExpoAppConfig(dir);
    assertEquals(config.name, "Dynamic");
    assertEquals(config.iosBundleIdentifier, "dev.simple.app", "app.json's value for code");
    assertEquals(config.unresolved, [], "app.json covered it");
  });
});

Deno.test("migrate --from expo: expo-router gets its web entry without Metro's runtime", async () => {
  await withApp({
    "package.json": {
      name: "routed",
      main: "expo-router/entry",
      dependencies: { expo: "~57.0.18", "expo-router": "~57.0.0", "react-native": "0.86.3" },
    },
    "app/index.tsx": "export default function Home() { return null; }\n",
    "app.json": { expo: { name: "Routed", slug: "routed" } },
  }, async (dir) => {
    const r = await migrateProject(dir, { denextLocalPath: Deno.cwd() });
    assertEquals(r.expo!.expoRouter, true);
    assertEquals(r.expo!.generatedEntry, { path: "index.web.ts", kind: "expo-router" });
    assertEquals(r.spa!.entry, "./index.web.ts");
    const entry = await Deno.readTextFile(join(dir, "index.web.ts"));
    assertStringIncludes(entry, 'from "expo-router/build/qualified-entry"');
    assert(!entry.includes('import "@expo/metro-runtime"'), "without Metro's runtime");
    assertEquals(
      r.expo!.deps.expo.find((p) => p.name === "expo-router")?.status,
      "none",
    );
  });
});

Deno.test("expoMobilePlan: nothing to add → no command", () => {
  const plan = expoMobilePlan({ expo: "1" }, {
    source: null,
    schemes: [],
    infoPlist: {},
    androidPermissions: [],
    plugins: [],
    linkDomains: [],
    runtimeConfig: {},
    unresolved: [],
    notes: [],
  });
  assertEquals(plan.command, null);
  assertEquals(plan.capabilities, []);
});

Deno.test("migrate CLI: the Expo report", async () => {
  await withApp(T3_LIKE, async (dir) => {
    const cap = capture();
    try {
      await migrateCommand.run(makeCtx({
        positionals: [dir],
        flags: { from: "expo", "denext-local-path": Deno.cwd() },
      }));
    } finally {
      cap.restore();
    }
    const out = cap.logs.join("\n");
    assertStringIncludes(out, 'Expo app detected — wrote denext.config.ts (mode: "spa"');
    assertStringIncludes(out, "not statically readable (computed in code): ");
    assertStringIncludes(out, "expo-sqlite              partial");
    assertStringIncludes(out, "expo-location            no shim");
    assertStringIncludes(out, "react-native-nitro-markdown — Nitro module (JSI)");
    assertStringIncludes(out, "install react-native-web @sqlite.org/sqlite-wasm");
    assertStringIncludes(out, "denext mobile add haptics secure-store deep-links");
    assertStringIncludes(out, 'NSMicrophoneUsageDescription = "Voice for Acme"');
    assertStringIncludes(out, "NSLocalNetworkUsageDescription = (computed in code)");
    assertStringIncludes(out, "android.permission.RECORD_AUDIO");
    assertStringIncludes(out, "uniwind recipe");
    assertStringIncludes(out, "extraNodeModules): @acme/generated-licenses");
  });
});

Deno.test("expo app config: config-plugin permission options become usage strings", async () => {
  await withApp({
    "package.json": { name: "p", dependencies: { expo: "1", "expo-auth-session": "1" } },
    "App.js": "export default () => null;\n",
    "app.json": {
      expo: {
        slug: "p",
        plugins: [
          ["expo-audio", { microphonePermission: "Talk to it" }],
          ["expo-camera", { cameraPermission: false, microphonePermission: false }],
          ["expo-location", { locationWhenInUsePermission: "Find you" }],
          "expo-secure-store",
        ],
      },
    },
  }, async (dir) => {
    const config = await readExpoAppConfig(dir);
    assertEquals(config.infoPlist, {
      NSMicrophoneUsageDescription: "Talk to it",
      NSLocationWhenInUseUsageDescription: "Find you",
    });
    assertEquals(config.plugins, [
      "expo-audio",
      "expo-camera",
      "expo-location",
      "expo-secure-store",
    ]);
    const plan = expoMobilePlan({ expo: "1", "expo-auth-session": "1" }, config);
    assertEquals(
      plan.command,
      "denext mobile add secure-store auth-session barcode --scheme <scheme>",
      "auth-session with no scheme in the config gets a placeholder",
    );
  });
});
