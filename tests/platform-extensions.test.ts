// Platform-specific files (src/build/platform-extensions.ts): each target's probe order, the
// `.native` opt-in, `platformExtensions: false`, the explicit-extension variant, the
// missing-variant message, the project scan → file-URL redirects and per-target gaps, the
// config validation, `denext doctor`'s check, the server loader's redirect, the unbundled dev
// probe and the wiring that picks the target (`--platform`, mobile build, desktop package).

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import * as esbuild from "esbuild";
import {
  chooseVariant,
  composeRedirects,
  desktopPlatform,
  explicitVariant,
  missingVariantMessage,
  parsePlatform,
  type Platform,
  platformFilesReport,
  platformGaps,
  platformRedirects,
  platformResolution,
  platformSuffixes,
  platformVariantsOf,
  probePlatformSource,
  scanPlatformGroups,
  splitPlatformName,
} from "../src/build/platform-extensions.ts";
import { appResolverPlugin, probeSourceFile, SOURCE_EXTS } from "../src/build/next-compat.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import { createUseCacheLoader } from "../src/build/use-cache-loader.ts";
import { firstPartyProbe } from "../src/build/dev-unbundled/resolve.ts";
import type { UnbundledState } from "../src/build/dev-unbundled/state.ts";
import { planMobileBuild } from "../src/build/mobile-build.ts";
import { desktopExportEnv } from "../src/build/desktop-package-script.ts";
import { platformFilesCheck } from "../src/cli/commands/doctor.ts";

/** A temp dir holding `files` (relative path → contents). */
async function tree(files: Record<string, string>): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_platform_unit_" }));
  for (const [name, src] of Object.entries(files)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), src);
  }
  return dir;
}

Deno.test("platformSuffixes: most specific first, every list ending in .web", () => {
  const table: Record<Platform, string[]> = {
    web: [".web"],
    ios: [".ios", ".mobile", ".web"],
    android: [".android", ".mobile", ".web"],
    macos: [".macos", ".desktop", ".web"],
    windows: [".windows", ".desktop", ".web"],
    linux: [".linux", ".desktop", ".web"],
  };
  for (const [platform, want] of Object.entries(table)) {
    assertEquals(platformSuffixes(platform as Platform), want, platform);
  }
});

Deno.test("platformSuffixes: `.native` is opt-in, after the OS, on phones only", () => {
  assertEquals(platformSuffixes("ios", { native: true }), [".ios", ".native", ".mobile", ".web"]);
  assertEquals(platformSuffixes("android", { native: true }), [
    ".android",
    ".native",
    ".mobile",
    ".web",
  ]);
  assertEquals(platformSuffixes("macos", { native: true }), [".macos", ".desktop", ".web"]);
  assertEquals(platformSuffixes("web", { native: true }), [".web"]);
});

Deno.test("platformResolution: on by default, `{ native }` read, `false` turns it off", () => {
  const ios = platformResolution({}, "ios")!;
  assertEquals(ios.suffixes, [".ios", ".mobile", ".web"]);
  assertEquals(ios.extensions.slice(0, 5), [
    ".ios.tsx",
    ".ios.ts",
    ".ios.jsx",
    ".ios.js",
    ".ios.mjs",
  ]);
  assertEquals(ios.extensions.length, 15);
  assertEquals(platformResolution(undefined)!.platform, "web");
  assertEquals(platformResolution({ platformExtensions: true }, "web")!.suffixes, [".web"]);
  assertEquals(
    platformResolution({ platformExtensions: { native: true } }, "ios")!.suffixes,
    [".ios", ".native", ".mobile", ".web"],
  );
  assertEquals(platformResolution({ platformExtensions: false }, "ios"), null);
});

Deno.test("parsePlatform / desktopPlatform: the target names", () => {
  assertEquals(parsePlatform(undefined), "web");
  assertEquals(parsePlatform(""), "web");
  assertEquals(parsePlatform("android"), "android");
  assertThrows(() => parsePlatform("iphone"), Error, "--platform must be one of web, ios");
  assertThrows(() => parsePlatform("x", "DENEXT_PLATFORM"), Error, "DENEXT_PLATFORM must be");
  assertEquals(desktopPlatform("darwin"), "macos");
  assertEquals(desktopPlatform("windows"), "windows");
  assertEquals(desktopPlatform("linux"), "linux");
});

Deno.test("splitPlatformName: a suffix right before the source extension only", () => {
  assertEquals(splitPlatformName("BigButton.ios.tsx"), { stem: "BigButton", suffix: "ios" });
  assertEquals(splitPlatformName("a.b.desktop.mjs"), { stem: "a.b", suffix: "desktop" });
  assertEquals(splitPlatformName("BigButton.tsx"), null);
  assertEquals(splitPlatformName("types.ios.d.ts"), null);
  assertEquals(splitPlatformName("x.ios.css"), null);
  assertEquals(splitPlatformName("x.test.ts"), null);
});

Deno.test("probePlatformSource: each target picks its own file, then the plain one", async () => {
  const dir = await tree({
    "B.tsx": "",
    "B.ios.tsx": "",
    "B.mobile.ts": "",
    "B.desktop.tsx": "",
    "B.native.tsx": "",
    "Only.web.ts": "",
    "Dir/index.android.tsx": "",
    "Dir/index.tsx": "",
  });
  try {
    const probe = (base: string, platform: Platform, config: DenextConfig = {}) =>
      probePlatformSource(
        join(dir, base),
        platformResolution(config, platform),
        probeSourceFile,
        SOURCE_EXTS,
      )?.slice(dir.length + 1);
    assertEquals(probe("B", "web"), "B.tsx");
    assertEquals(probe("B", "ios"), "B.ios.tsx");
    assertEquals(probe("B", "android"), "B.mobile.ts");
    assertEquals(probe("B", "linux"), "B.desktop.tsx");
    assertEquals(probe("B", "android", { platformExtensions: { native: true } }), "B.native.tsx");
    // An explicit extension (the Deno spelling) takes the variant too.
    assertEquals(probe("B.tsx", "ios"), "B.ios.tsx");
    assertEquals(probe("B.tsx", "web"), "B.tsx");
    // `.web` is every target's last resort before the plain file.
    assertEquals(probe("Only", "macos"), "Only.web.ts");
    assertEquals(probe("Dir", "android"), "Dir/index.android.tsx");
    assertEquals(probe("Dir", "ios"), "Dir/index.tsx");
    // Off: the plain file only.
    assertEquals(probe("B", "ios", { platformExtensions: false }), "B.tsx");
    assertEquals(explicitVariant(join(dir, "B.json"), platformResolution({}, "ios")!), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("missingVariantMessage: names the variants and what to add", async () => {
  const dir = await tree({ "BigButton.ios.tsx": "", "BigButton.android.tsx": "" });
  try {
    const variants = platformVariantsOf(join(dir, "BigButton"));
    assertEquals(variants.map((v) => v.suffix), ["android", "ios"]);
    assertEquals(
      missingVariantMessage("./BigButton", variants, platformResolution({}, "web")!),
      "`./BigButton` has `.android` and `.ios` variants but none for web: add `BigButton.tsx` " +
        "or `BigButton.web.tsx`",
    );
    assertEquals(platformVariantsOf(join(dir, "BigButton.tsx")).length, 2);
    assertEquals(platformVariantsOf(join(dir, "missing-dir", "X")), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scanPlatformGroups → platformRedirects / platformGaps per target", async () => {
  const dir = await tree({
    "src/Pad.ios.tsx": "",
    "src/Pad.android.tsx": "",
    "src/Card.tsx": "",
    "src/Card.desktop.tsx": "",
    "src/plain.ts": "",
    "node_modules/lib/x.ios.js": "",
    "out/_denext/y.web.js": "",
    "ios/App/z.ios.ts": "",
  });
  try {
    const groups = await scanPlatformGroups(dir);
    assertEquals(groups.map((g) => g.stem.slice(dir.length + 1)), ["src/Card", "src/Pad"]);
    assertEquals(groups[0].plain, join(dir, "src/Card.tsx"));
    assertEquals(groups[1].plain, null);
    assertEquals(chooseVariant(groups[1], platformResolution({}, "web")!), null);

    const url = (rel: string) => toFileUrl(join(dir, rel)).href;
    const mac = platformRedirects(groups, platformResolution({}, "macos"));
    assertEquals(mac[url("src/Card")], url("src/Card.desktop.tsx"));
    assertEquals(mac[url("src/Card.tsx")], url("src/Card.desktop.tsx"));
    assertEquals(mac[url("src/Card.js")], url("src/Card.desktop.tsx"));
    assert(!(url("src/Pad") in mac), "a gap gets no redirect");
    const ios = platformRedirects(groups, platformResolution({}, "ios"));
    assertEquals(ios[url("src/Pad.tsx")], url("src/Pad.ios.tsx"));
    assert(!(url("src/Card.tsx") in ios), "the plain file needs no redirect");
    assertEquals(platformRedirects(groups, null), {});

    assertEquals(platformGaps(dir, groups, {}), [{
      module: "src/Pad",
      suffixes: ["android", "ios"],
      missing: ["web", "macos", "windows", "linux"],
    }]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("composeRedirects: a variant with a transformed copy redirects to the copy", () => {
  assertEquals(
    composeRedirects({ "file:///a.tsx": "file:///a.ios.tsx", "file:///b": "file:///b.web.ts" }, {
      "file:///a.ios.tsx": "file:///.denext/copy.tsx",
    }),
    { "file:///a.tsx": "file:///.denext/copy.tsx", "file:///b": "file:///b.web.ts" },
  );
  const same = { "file:///a": "file:///a.web.ts" };
  assertEquals(composeRedirects(same, undefined), same);
});

Deno.test("config: platformExtensions is a boolean or `{ native?: boolean }`", () => {
  validateDenextConfig({ platformExtensions: false });
  validateDenextConfig({ platformExtensions: { native: true } });
  assertThrows(
    () => validateDenextConfig({ platformExtensions: "ios" } as unknown as DenextConfig),
    Error,
    "`platformExtensions` must be a boolean",
  );
  assertThrows(
    () => validateDenextConfig({ platformExtensions: { ios: true } } as unknown as DenextConfig),
    Error,
    "`platformExtensions.ios` is not a known option",
  );
  assertThrows(
    () =>
      validateDenextConfig({ platformExtensions: { native: "yes" } } as unknown as DenextConfig),
    Error,
    "`platformExtensions.native` must be a boolean",
  );
});

Deno.test("doctor: the platform-files check lists each gap per target", async () => {
  const dir = await tree({
    "app/BigButton.ios.tsx": "",
    "app/BigButton.android.tsx": "",
    "app/Nav.web.tsx": "",
  });
  try {
    const check = await platformFilesCheck(dir, {});
    assertEquals(check?.ok, false);
    assertEquals(check?.critical, false);
    assertStringIncludes(
      check!.detail,
      "app/BigButton (.android, .ios) has no file for web, macos, windows, linux",
    );
    await Deno.writeTextFile(join(dir, "app/BigButton.tsx"), "");
    const fixed = await platformFilesReport(dir, {});
    assertEquals(fixed?.ok, true);
    assertStringIncludes(fixed!.detail, "2 module(s) with platform files; 1 without a plain file");
    assertEquals(await platformFilesCheck(dir, { platformExtensions: false }), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  const empty = await tree({ "app/page.tsx": "" });
  try {
    assertEquals(await platformFilesCheck(empty, {}), null);
  } finally {
    await Deno.remove(empty, { recursive: true });
  }
});

Deno.test("server loader: redirects load the variant through a rewritten importer", async () => {
  const dir = await tree({
    "page.ts": `import { v } from "./v.ts";\nexport const got = v;\n`,
    "v.ts": `export const v = "PLAIN";\n`,
    "v.ios.ts": `export const v = "IOS";\n`,
    "keep.ts": `export const got = "UNTOUCHED";\n`,
  });
  try {
    const redirects = platformRedirects(
      await scanPlatformGroups(dir),
      platformResolution({}, "ios"),
    );
    const loads: string[] = [];
    const load = createUseCacheLoader((p) => {
      loads.push(p);
      return import(p);
    }, {
      projectDir: dir,
      cacheDir: join(dir, ".denext", "server-cache"),
      redirects,
      useCache: false,
    });
    const page = await load(join(dir, "page.ts")) as { got: string };
    assertEquals(page.got, "IOS");
    assert(loads[0].includes("/.denext/server-cache/"), "the importer was copied");
    // A module with nothing to redirect loads as itself.
    await load(join(dir, "keep.ts"));
    assertEquals(loads[1], toFileUrl(join(dir, "keep.ts")).href);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("unbundled dev: the first-party probe takes the target's file", async () => {
  const dir = await tree({ "B.tsx": "", "B.web.tsx": "", "C.tsx": "", "C.web.js": "" });
  try {
    const state = (opts: Partial<UnbundledState["opts"]>) =>
      ({ opts: { projectDir: dir, ...opts } }) as unknown as UnbundledState;
    const web = firstPartyProbe(state({ appPlatform: platformResolution({}, "web") }));
    assertEquals(web(join(dir, "B")), join(dir, "B.web.tsx"));
    assertEquals(web(join(dir, "B.tsx")), join(dir, "B.web.tsx"));
    // Off: plain files, unless React Native mode still asks for `.web`.
    assertEquals(firstPartyProbe(state({ appPlatform: null }))(join(dir, "B")), join(dir, "B.tsx"));
    const rn = firstPartyProbe(state({
      appPlatform: null,
      reactNative: { plugins: [], platformExtensions: [".web.js"], define: {} },
    }));
    assertEquals(rn(join(dir, "C")), join(dir, "C.web.js"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("appResolverPlugin: the esbuild app resolver probes the target and names a gap", async () => {
  const dir = await tree({
    "deno.json": "{}",
    "main.ts": `import { a } from "./a";\nimport { b } from "./b.ts";\nconsole.log(a, b);\n`,
    "a.ts": `export const a = "A_PLAIN";\n`,
    "a.android.ts": `export const a = "A_ANDROID";\n`,
    "b.ios.ts": `export const b = "B_IOS";\n`,
    "b.android.ts": `export const b = "B_ANDROID";\n`,
  });
  const run = (platform: Platform) =>
    esbuild.build({
      entryPoints: [join(dir, "main.ts")],
      bundle: true,
      write: false,
      logLevel: "silent",
      plugins: [
        appResolverPlugin(join(dir, "deno.json"), undefined, platformResolution({}, platform)),
      ],
    });
  try {
    const android = (await run("android")).outputFiles[0].text;
    assertStringIncludes(android, "A_ANDROID");
    assertStringIncludes(android, "B_ANDROID");
    assert(!android.includes("A_PLAIN") && !android.includes("B_IOS"));
    const err = await run("web").then(() => null, (e) => e as esbuild.BuildFailure);
    assertStringIncludes(
      err!.errors[0].text,
      "`./b.ts` has `.android` and `.ios` variants but none for web: add `b.ts` or `b.web.ts`",
    );
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("wiring: mobile build exports with its platform, desktop package with the target OS", async () => {
  const dir = await tree({
    "capacitor.config.json": JSON.stringify({ appId: "dev.x", appName: "X", webDir: "out" }),
    "android/app/build.gradle": 'versionCode 1\nversionName "1.0"\n',
  });
  try {
    const plan = await planMobileBuild({
      root: dir,
      appDir: dir,
      platform: "android",
      cli: ["run", "-A", "cli.ts"],
      deno: "deno",
    });
    assertEquals(plan.commands[0].args.slice(-4), ["export", dir, "--platform", "android"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  assertEquals(desktopExportEnv("windows"), { DENEXT_PLATFORM: "windows" });
  assertEquals(desktopExportEnv("darwin"), { DENEXT_PLATFORM: "macos" });
});
