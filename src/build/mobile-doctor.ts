// `denext mobile doctor --store | --release`: one set of checks over a Capacitor project and its
// web export, run under a profile. `--store` asks "will App Review accept this build?" (guideline
// 4.2 "Minimum Functionality", 5.1.1(v) account deletion, 4.8 Sign in with Apple, the privacy
// manifest, usage strings, icons); `--release` asks "is this build safe to ship?" (a debuggable
// WebView, cleartext, mixed content, wildcard navigation, no CSP, secrets in the bundle). A check
// both care about is written once and listed in both profiles.
//
// Sources: App Review Guidelines https://developer.apple.com/app-store/review/guidelines/ (4.2,
// 4.8, 5.1.1(v)); the Capacitor config reference https://capacitorjs.com/docs/config (server.url
// "is not intended for use in production", webContentsDebuggingEnabled, cleartext,
// allowMixedContent, allowNavigation); Capacitor's security guide
// https://capacitorjs.com/docs/guides/security (CSP, "never embed secrets in your app code").
//
// Nothing here runs the project: configs are read as data (the native copies `cap sync` writes
// are what ships, and are preferred), the export is scanned as text.

import { join } from "@std/path";
import { posixRelative } from "./mobile-paths.ts";
import { walk } from "@std/fs";
import { capacitorConfigFile, readCapacitorConfig } from "./capacitor-config.ts";
import { MOBILE_CAPABILITIES } from "./mobile-capabilities.ts";
import {
  checkPrivacyManifest,
  detectInstalledCapabilities,
  type PrivacyFinding,
} from "./mobile-privacy.ts";
import { dictGet, parsePlist, type PlistDict, type PlistNode } from "./plist-value.ts";
import { leakedCssShimKeys } from "./css-config-guard.ts";
import { fastlaneFindings } from "./mobile-fastlane.ts";

/** Which question the doctor answers. */
export type MobileDoctorProfile = "store" | "release";

/** One problem, with its fix. */
export interface MobileDoctorFinding {
  /** The check that found it (`server-url`, `privacy-manifest`, …). */
  readonly check: string;
  /** `error` blocks review or is a security hole in a release; `warning` should be looked at. */
  readonly level: "error" | "warning";
  readonly message: string;
  readonly fix: string;
}

/** What the doctor found. */
export interface MobileDoctorReport {
  readonly root: string;
  readonly profile: MobileDoctorProfile;
  /** The checks that ran, in order. */
  readonly checks: readonly string[];
  readonly findings: readonly MobileDoctorFinding[];
}

/** Options for {@linkcode runMobileDoctor}. */
export interface MobileDoctorOptions {
  /** The Capacitor project (the folder with `capacitor.config.*`). */
  readonly root: string;
  readonly profile: MobileDoctorProfile;
  /** The denext app whose sources are scanned for auth (default: `root`). */
  readonly appDir?: string;
}

/** A config as one source has it, labelled with that source's path. */
interface ConfigSource {
  readonly label: string;
  readonly config: Record<string, unknown>;
}

/** Everything the checks read, gathered once. */
interface MobileProject {
  readonly root: string;
  readonly appDir: string;
  /** The source config and the native copies `cap sync` wrote (what the shell loads). */
  readonly configs: readonly ConfigSource[];
  /** The export `webDir` (absolute), or null when it does not exist. */
  readonly webDir: string | null;
  /** The webDir as configured, for messages. */
  readonly webDirName: string;
  /** ios/App/App/Info.plist's top-level dict, or null. */
  readonly infoPlist: PlistDict | null;
  /** android/app/src/main/AndroidManifest.xml, or null. */
  readonly androidManifest: string | null;
  readonly hasIos: boolean;
  readonly hasAndroid: boolean;
}

const INFO_PLIST = "ios/App/App/Info.plist";
const ANDROID_MANIFEST = "android/app/src/main/AndroidManifest.xml";
const NATIVE_CONFIGS = [
  "ios/App/App/capacitor.config.json",
  "android/app/src/main/assets/capacitor.config.json",
];

async function readText(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

/** The source config and each native copy that exists, as data. */
async function readConfigs(root: string): Promise<ConfigSource[]> {
  const out: ConfigSource[] = [];
  const file = await capacitorConfigFile(root);
  if (file) {
    const config = await readCapacitorConfig(file, await Deno.readTextFile(file));
    if (config) out.push({ label: posixRelative(root, file), config });
  }
  for (const rel of NATIVE_CONFIGS) {
    const text = await readText(join(root, rel));
    const config = text === null ? null : await readCapacitorConfig(rel, text);
    if (config) out.push({ label: rel, config });
  }
  return out;
}

/** Info.plist's top-level dict, or null when missing or unreadable. */
async function readInfoPlist(root: string): Promise<PlistDict | null> {
  const text = await readText(join(root, INFO_PLIST));
  if (text === null) return null;
  try {
    const node = parsePlist(text);
    return node.kind === "dict" ? node : null;
  } catch {
    return null;
  }
}

/**
 * Read a Capacitor project for the doctor.
 *
 * @param root The Capacitor project.
 * @param appDir The denext app (default: `root`).
 * @returns The project's configs, export, Info.plist and manifest.
 */
async function readMobileProject(root: string, appDir = root): Promise<MobileProject> {
  const configs = await readConfigs(root);
  const webDirName = String(
    configs.find((c) => typeof c.config.webDir === "string")?.config.webDir ?? "out",
  );
  const webDir = join(root, webDirName);
  return {
    root,
    appDir,
    configs,
    webDir: (await isDir(webDir)) ? webDir : null,
    webDirName,
    infoPlist: await readInfoPlist(root),
    androidManifest: await readText(join(root, ANDROID_MANIFEST)),
    hasIos: await isDir(join(root, "ios")),
    hasAndroid: await isDir(join(root, "android")),
  };
}

/** A check: its id, which profiles run it, and what it finds. */
interface Check {
  readonly id: string;
  readonly profiles: readonly MobileDoctorProfile[];
  /** Whether the project has what the check looks at (default: always); listed only then. */
  readonly applies?: (p: MobileProject) => Promise<boolean>;
  readonly run: (
    p: MobileProject,
    profile: MobileDoctorProfile,
  ) => Promise<MobileDoctorFinding[]> | MobileDoctorFinding[];
}

/** The value at `path` in a config, or undefined. */
function at(config: Record<string, unknown>, ...path: string[]): unknown {
  let v: unknown = config;
  for (const key of path) {
    if (typeof v !== "object" || v === null) return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}

/** One finding per config source where `test` holds. */
function perConfig(
  p: MobileProject,
  test: (c: Record<string, unknown>) => boolean,
  make: (label: string) => MobileDoctorFinding,
): MobileDoctorFinding[] {
  return p.configs.filter((s) => test(s.config)).map((s) => make(s.label));
}

// ---- config checks ----------------------------------------------------------------------------

const serverUrl: Check = {
  id: "server-url",
  profiles: ["store", "release"],
  run: (p) =>
    perConfig(p, (c) => typeof at(c, "server", "url") === "string", (label) => ({
      check: "server-url",
      level: "error",
      message: `${label} sets server.url (${
        String(at(p.configs.find((s) => s.label === label)!.config, "server", "url"))
      }): the app loads a remote site instead of its bundled export, the classic 4.2 rejection`,
      fix: "remove server.url (a leftover `denext mobile dev` session: `denext mobile dev " +
        "--restore`), then `npx cap sync`",
    })),
};

const webviewDebugging: Check = {
  id: "webview-debugging",
  profiles: ["store", "release"],
  run: (p) =>
    ["ios", "android"].flatMap((platform) =>
      perConfig(p, (c) => at(c, platform, "webContentsDebuggingEnabled") === true, (label) => ({
        check: "webview-debugging",
        level: "error",
        message: `${label}: ${platform}.webContentsDebuggingEnabled is true, so a release build ` +
          "lets anyone attach a web inspector to the app",
        fix: `remove ${platform}.webContentsDebuggingEnabled (debug builds are inspectable ` +
          "without it; `denext mobile dev` turns it on for its session only)",
      }))
    ),
};

const mixedContent: Check = {
  id: "mixed-content",
  profiles: ["release"],
  run: (p) =>
    perConfig(p, (c) => at(c, "android", "allowMixedContent") === true, (label) => ({
      check: "mixed-content",
      level: "error",
      message: `${label}: android.allowMixedContent lets the https WebView load http content`,
      fix: "remove android.allowMixedContent and load every resource over https",
    })),
};

const legacyBridge: Check = {
  id: "legacy-bridge",
  profiles: ["release"],
  run: (p) =>
    perConfig(p, (c) => at(c, "android", "useLegacyBridge") === true, (label) => ({
      check: "legacy-bridge",
      level: "error",
      message: `${label}: android.useLegacyBridge exposes the native bridge through ` +
        "addJavascriptInterface, which every frame can call: an iframe could reach every " +
        "installed plugin (the default bridge accepts plugin calls from the main frame only)",
      fix: "remove android.useLegacyBridge",
    })),
};

/** The bridge view controller denext generates, and the guard every current one carries. */
const BRIDGE_VIEW_CONTROLLER = "ios/App/App/DenextBridgeViewController.swift";
const FRAME_GUARD_CLASS = "DenextMainFrameBridgeGuard";

const bridgeFrameGuard: Check = {
  id: "bridge-frame-guard",
  profiles: ["store", "release"],
  run: async (p) => {
    const text = await readText(join(p.root, BRIDGE_VIEW_CONTROLLER));
    if (text === null || text.includes(FRAME_GUARD_CLASS)) return [];
    return [{
      check: "bridge-frame-guard",
      level: "error",
      message: `${BRIDGE_VIEW_CONTROLLER} predates the main-frame guard: any iframe in the page ` +
        "can post native plugin calls to every installed plugin",
      fix: "re-run `denext mobile add-ota` (with OTA) or the `denext mobile add` that wrote " +
        "it: an unedited file is upgraded, an edited one is kept (`--force` replaces it, or copy " +
        `${FRAME_GUARD_CLASS} from the current template and call its install(on: bridge) ` +
        "after super.capacitorDidLoad()); then ship a new binary",
    }];
  },
};

/** Whether an allowNavigation entry allows every host. */
function wildcardHost(entry: unknown): boolean {
  return typeof entry === "string" && /^(?:[a-z]+:\/\/)?\*(?:\/.*)?$/i.test(entry.trim());
}

const allowNavigation: Check = {
  id: "allow-navigation",
  profiles: ["store", "release"],
  run: (p) =>
    perConfig(p, (c) => {
      const list = at(c, "server", "allowNavigation");
      return Array.isArray(list) && list.some(wildcardHost);
    }, (label) => ({
      check: "allow-navigation",
      level: "error",
      message: `${label}: server.allowNavigation allows "*", so any site can load inside the ` +
        "app's WebView (with the native bridge)",
      fix: "list the exact hosts the WebView must navigate to; open everything else with " +
        "openExternal()",
    })),
};

/** The ATS exceptions of Info.plist that allow plain http. */
function atsExceptions(plist: PlistDict): string[] {
  const ats = dictGet(plist, "NSAppTransportSecurity");
  if (ats?.kind !== "dict") return [];
  const isTrue = (n: PlistNode | undefined) => n?.kind === "bool" && n.value;
  const out = [
    "NSAllowsArbitraryLoads",
    "NSAllowsArbitraryLoadsInWebContent",
    "NSAllowsArbitraryLoadsForMedia",
    "NSAllowsLocalNetworking",
  ]
    .filter((k) => isTrue(dictGet(ats, k)));
  const domains = dictGet(ats, "NSExceptionDomains");
  if (domains?.kind === "dict") {
    for (const [host, d] of domains.entries) {
      if (d.kind === "dict" && isTrue(dictGet(d, "NSExceptionAllowsInsecureHTTPLoads"))) {
        out.push(`NSExceptionDomains ${host} (NSExceptionAllowsInsecureHTTPLoads)`);
      }
    }
  }
  return out;
}

const cleartext: Check = {
  id: "cleartext",
  profiles: ["store", "release"],
  run: (p, profile) => {
    const level = profile === "release" ? "error" : "warning";
    const out = perConfig(p, (c) => at(c, "server", "cleartext") === true, (label) => ({
      check: "cleartext",
      level,
      message: `${label}: server.cleartext allows plain-http traffic from the WebView (Android)`,
      fix: "remove server.cleartext (it is for live reload) and use https",
    }));
    for (const key of p.infoPlist ? atsExceptions(p.infoPlist) : []) {
      out.push({
        check: "cleartext",
        level,
        message: `${INFO_PLIST}: App Transport Security exception ${key}` +
          (key === "NSAllowsLocalNetworking" ? " (left by a `denext mobile dev` session?)" : ""),
        fix: "remove the exception (App Review asks for a justification of each) and use https",
      });
    }
    if (p.androidManifest && /android:usesCleartextTraffic\s*=\s*"true"/.test(p.androidManifest)) {
      out.push({
        check: "cleartext",
        level,
        message: `${ANDROID_MANIFEST}: android:usesCleartextTraffic="true"`,
        fix: "remove it, or scope plain http to named hosts with a network security config",
      });
    }
    return out;
  },
};

const androidDebuggable: Check = {
  id: "android-debuggable",
  profiles: ["release"],
  run: (p) =>
    p.androidManifest && /android:debuggable\s*=\s*"true"/.test(p.androidManifest)
      ? [{
        check: "android-debuggable",
        level: "error",
        message: `${ANDROID_MANIFEST}: android:debuggable="true" (Play refuses debuggable uploads)`,
        fix: "remove the attribute; Gradle sets it for debug builds only",
      }]
      : [],
};

const productionLogging: Check = {
  id: "logging",
  profiles: ["release"],
  run: (p) =>
    perConfig(p, (c) => at(c, "loggingBehavior") === "production", (label) => ({
      check: "logging",
      level: "warning",
      message: `${label}: loggingBehavior "production" writes native and console logs in ` +
        "release builds (readable on a connected device)",
      fix: 'use "debug" (the default) unless you need release logs',
    })),
};

// ---- export checks ----------------------------------------------------------------------------

/** The finding when there is no export to scan. */
function noExport(p: MobileProject, check: string): MobileDoctorFinding[] {
  return [{
    check,
    level: "warning",
    message: `no export at ${p.webDirName}/ (webDir), so it was not scanned`,
    fix: "run `denext export` (and `npx cap sync`) before the doctor",
  }];
}

const csp: Check = {
  id: "csp",
  profiles: ["store", "release"],
  run: async (p, profile) => {
    if (!p.webDir) return noExport(p, "csp");
    const html = await readText(join(p.webDir, "index.html"));
    if (html === null || /<meta[^>]+http-equiv\s*=\s*["']?content-security-policy/i.test(html)) {
      return [];
    }
    return [{
      check: "csp",
      level: profile === "release" ? "error" : "warning",
      message: `${p.webDirName}/index.html has no Content-Security-Policy meta tag`,
      fix: 'add <meta http-equiv="Content-Security-Policy" content="default-src \'self\' ' +
        "capacitor://localhost https://localhost; connect-src 'self' https://api.example.com\"> " +
        "(e.g. through spa.head in denext.config)",
    }];
  },
};

/** Text files of the export worth scanning (skips binaries and anything over 8 MB). */
async function* exportTexts(webDir: string): AsyncGenerator<{ rel: string; text: string }> {
  for await (
    const e of walk(webDir, {
      includeDirs: false,
      exts: [".js", ".mjs", ".html", ".css", ".json", ".map", ".txt"],
    })
  ) {
    const size = (await Deno.stat(e.path)).size;
    if (size > 8 * 1024 * 1024) continue;
    yield { rel: posixRelative(webDir, e.path), text: await Deno.readTextFile(e.path) };
  }
}

const sourceMaps: Check = {
  id: "source-maps",
  profiles: ["store"],
  run: async (p) => {
    if (!p.webDir) return noExport(p, "source-maps");
    const hits: string[] = [];
    for await (const { rel, text } of exportTexts(p.webDir)) {
      if (rel.endsWith(".map") || /\/\/# sourceMappingURL=/.test(text)) hits.push(rel);
    }
    return hits.length === 0 ? [] : [{
      check: "source-maps",
      level: "warning",
      message: `${p.webDirName}/ ships source maps or sourceMappingURL references (${
        hits.slice(0, 5).join(", ")
      }${hits.length > 5 ? ", …" : ""}): your original source is readable from the app package`,
      fix: "export with `denext export --sourcemaps hidden` (maps go to .denext/sourcemaps for " +
        "your crash reporter, not into the app)",
    }];
  },
};

/** Secret shapes: the name, and a pattern that rarely matches anything else. */
const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["a PEM private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ["a Stripe live secret key", /\b[sr]k_live_[0-9a-zA-Z]{16,}/],
  ["an AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["a Sentry auth token", /\bsntr[ysu]_[A-Za-z0-9+/=_-]{20,}/],
  ["an OpenAI / Anthropic API key", /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}/],
  ["a Google API service-account key", /"private_key_id"\s*:\s*"[0-9a-f]{40}"/],
];

const secrets: Check = {
  id: "secrets",
  profiles: ["store", "release"],
  run: async (p) => {
    if (!p.webDir) return noExport(p, "secrets");
    const out: MobileDoctorFinding[] = [];
    for await (const { rel, text } of exportTexts(p.webDir)) {
      for (const [name, pattern] of SECRET_PATTERNS) {
        if (!pattern.test(text)) continue;
        out.push({
          check: "secrets",
          level: "error",
          message: `${p.webDirName}/${rel} contains what looks like ${name}; anything in the ` +
            "export can be read from the app package",
          fix: "keep the secret on a server the app calls, rotate it, and re-export",
        });
      }
    }
    return out;
  },
};

// ---- store checks -----------------------------------------------------------------------------

const usageStrings: Check = {
  id: "usage-strings",
  profiles: ["store"],
  run: async (p) => {
    if (!p.hasIos || !p.infoPlist) return [];
    const installed = await detectInstalledCapabilities(p.root, MOBILE_CAPABILITIES);
    const out: MobileDoctorFinding[] = [];
    for (const name of installed) {
      for (const key of Object.keys(MOBILE_CAPABILITIES[name]?.iosPlist ?? {})) {
        const value = dictGet(p.infoPlist, key);
        if (value?.kind === "string" && value.text.trim() !== "") continue;
        out.push({
          check: "usage-strings",
          level: "error",
          message: `${INFO_PLIST} has no ${key}, which ${name} needs (iOS terminates the app ` +
            "when the permission is asked for, and review rejects it)",
          fix: `re-run \`denext mobile add ${name}\`, or add ${key} with a sentence saying why`,
        });
      }
    }
    return out;
  },
};

/** A privacy finding as a doctor finding. */
function fromPrivacy(f: PrivacyFinding): MobileDoctorFinding {
  return {
    check: "privacy-manifest",
    level: f.level,
    message: `${f.file}: ${f.message}`,
    fix: f.fix,
  };
}

const privacyManifest: Check = {
  id: "privacy-manifest",
  profiles: ["store"],
  run: async (p) => {
    if (!p.hasIos) return [];
    return (await checkPrivacyManifest(p.root, MOBILE_CAPABILITIES)).findings.map(fromPrivacy);
  },
};

/** The image files an asset catalog set names that exist, or null without the set. */
async function catalogImages(dir: string): Promise<string[] | null> {
  const text = await readText(join(dir, "Contents.json"));
  if (text === null) return null;
  try {
    const images = (JSON.parse(text) as { images?: Array<{ filename?: unknown }> }).images ?? [];
    const names = images.flatMap((i) => typeof i.filename === "string" ? [i.filename] : []);
    const present: string[] = [];
    for (const name of names) if (await isFile(join(dir, name))) present.push(name);
    return present;
  } catch {
    return [];
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/** Whether any `res/<prefix>*` folder holds a file starting with `name`. */
async function androidRes(root: string, prefix: string, name: string): Promise<boolean> {
  const res = join(root, "android/app/src/main/res");
  if (!(await isDir(res))) return false;
  for await (const dir of Deno.readDir(res)) {
    if (!dir.isDirectory || !dir.name.startsWith(prefix)) continue;
    for await (const f of Deno.readDir(join(res, dir.name))) {
      if (f.name.startsWith(name)) return true;
    }
  }
  return false;
}

const ASSET_FIX = "generate every size from one 1024×1024 icon and a splash image (e.g. " +
  "`npx @capacitor/assets generate`), then rebuild";

const appIcons: Check = {
  id: "app-icons",
  profiles: ["store"],
  run: async (p) => {
    const out: MobileDoctorFinding[] = [];
    if (p.hasIos) {
      const icons = await catalogImages(
        join(p.root, "ios/App/App/Assets.xcassets/AppIcon.appiconset"),
      );
      if (!icons || icons.length === 0) {
        out.push({
          check: "app-icons",
          level: "error",
          message: "ios/App/App/Assets.xcassets/AppIcon.appiconset has no icon image",
          fix: ASSET_FIX,
        });
      }
    }
    if (p.hasAndroid && !(await androidRes(p.root, "mipmap", "ic_launcher"))) {
      out.push({
        check: "app-icons",
        level: "error",
        message: "android/app/src/main/res has no mipmap*/ic_launcher icon",
        fix: ASSET_FIX,
      });
    }
    return out;
  },
};

const splash: Check = {
  id: "splash",
  profiles: ["store"],
  run: async (p) => {
    const out: MobileDoctorFinding[] = [];
    if (p.hasIos) {
      const images = await catalogImages(
        join(p.root, "ios/App/App/Assets.xcassets/Splash.imageset"),
      );
      const storyboard = await isFile(
        join(p.root, "ios/App/App/Base.lproj/LaunchScreen.storyboard"),
      );
      if (!storyboard && (!images || images.length === 0)) {
        out.push({
          check: "splash",
          level: "warning",
          message: "iOS has no launch screen (LaunchScreen.storyboard or a Splash image set)",
          fix: ASSET_FIX,
        });
      }
    }
    if (p.hasAndroid && !(await androidRes(p.root, "drawable", "splash"))) {
      out.push({
        check: "splash",
        level: "warning",
        message: "android/app/src/main/res has no drawable*/splash image",
        fix: ASSET_FIX,
      });
    }
    return out;
  },
};

/** Folders the source scan never enters: dependencies, builds, native projects, the export. */
const SKIPPED_SOURCE_DIRS = new Set([
  "node_modules",
  ".denext",
  ".git",
  "ios",
  "android",
  "out",
  "dist",
  "build",
]);
const SOURCE_FILE = /\.(?:tsx?|jsx?|mjs)$/;

/**
 * The project-relative (`/`-separated) source files under `dir`. The skip list is matched per
 * folder name inside the project only, so a project that itself lives under a `dist` / `build` /
 * `out` folder is still scanned. Symlinks are not followed.
 */
async function* sourceFiles(dir: string, rel = ""): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(rel ? join(dir, rel) : dir)) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory && !SKIPPED_SOURCE_DIRS.has(entry.name)) yield* sourceFiles(dir, path);
    else if (entry.isFile && SOURCE_FILE.test(entry.name)) yield path;
  }
}

/** The app's own source files (not dependencies, builds, native projects or the export). */
async function* appSources(dir: string): AsyncGenerator<{ rel: string; text: string }> {
  for await (const rel of sourceFiles(dir)) {
    const path = join(dir, rel);
    if ((await Deno.stat(path)).size > 1024 * 1024) continue;
    yield { rel, text: await Deno.readTextFile(path) };
  }
}

/** What the app's sources say about sign-in and account deletion. */
async function authFacts(
  dir: string,
): Promise<{ auth: boolean; deletion: boolean; google: boolean; apple: boolean }> {
  const facts = { auth: false, deletion: false, google: false, apple: false };
  for await (const { text } of appSources(dir)) {
    facts.auth ||=
      /\b(?:denextAuth|nativeSession|signInWithApple|signInWithGoogle|signInNative)\s*\(/.test(
        text,
      );
    facts.deletion ||= /\bdeleteAccount\s*\(|account\/delete/.test(text);
    facts.google ||= /\bsignInWithGoogle\s*\(|providers\s*:[^\]]*\bgoogle\s*\(/.test(text);
    facts.apple ||= /\bsignInWithApple\s*\(|providers\s*:[^\]]*\bapple\s*\(/.test(text);
  }
  return facts;
}

const accountDeletion: Check = {
  id: "account-deletion",
  profiles: ["store"],
  run: async (p) => {
    const facts = await authFacts(p.appDir);
    const out: MobileDoctorFinding[] = [];
    if (facts.auth && !facts.deletion) {
      out.push({
        check: "account-deletion",
        level: "error",
        message: "the app signs users in but nothing calls account deletion: guideline 5.1.1(v) " +
          "requires apps with account creation to let users delete the account in the app",
        fix: "add a Delete account action that calls session.deleteAccount() (nativeSession) or " +
          "POST {basePath}/account/delete (denextAuth serves it when the adapter has deleteUser)",
      });
    }
    if (facts.google && !facts.apple) {
      out.push({
        check: "account-deletion",
        level: "warning",
        message:
          "Google sign-in without Sign in with Apple: guideline 4.8 asks for an equivalent " +
          "privacy-focused login option when an app offers a third-party one",
        fix: "add signInWithApple() (`denext mobile add social-login`), or check that a 4.8 " +
          "exemption applies",
      });
    }
    return out;
  },
};

// ---- storage ----------------------------------------------------------------------------------

/**
 * Web storage an app keeps data in: `localStorage`, IndexedDB, and redux-persist's web storage
 * (localStorage). iOS and Android may clear a WebView's storage under disk pressure
 * (https://capacitorjs.com/docs/guides/storage: "must be considered transient").
 */
const WEB_STORAGE =
  /\blocalStorage\b|\bindexedDB\s*\.\s*open\s*\(|["']redux-persist\/lib\/storage["']/;

/** Where `denext mobile add storage` puts the DenextStorage plugin. */
const IOS_STORAGE_PLUGIN = "ios/App/App/DenextStoragePlugin.swift";
const ANDROID_STORAGE_PLUGIN =
  "android/app/src/main/java/dev/denext/storage/DenextStoragePlugin.java";

/** Packages whose data denext keeps in its durable store when one is installed. */
const DURABLE_STORE_USERS = ["@react-native-async-storage/async-storage", "react-native-mmkv"];

/** Whether the project has a durable native store: DenextStorage, or @capacitor-community/sqlite. */
async function hasDurableStore(p: MobileProject): Promise<boolean> {
  if (await isFile(join(p.root, IOS_STORAGE_PLUGIN))) return true;
  if (await isFile(join(p.root, ANDROID_STORAGE_PLUGIN))) return true;
  return (await detectInstalledCapabilities(p.root, MOBILE_CAPABILITIES)).includes("sqlite");
}

/** The dependency names of the project's (and the app's) `package.json`. */
async function dependencies(p: MobileProject): Promise<Set<string>> {
  const names = new Set<string>();
  for (const dir of new Set([p.root, p.appDir])) {
    const text = await readText(join(dir, "package.json"));
    try {
      const pkg = JSON.parse(text ?? "{}") as Record<string, unknown>;
      for (const deps of [pkg.dependencies, pkg.devDependencies]) {
        if (deps && typeof deps === "object") Object.keys(deps).forEach((n) => names.add(n));
      }
    } catch {
      // An unreadable package.json lists nothing.
    }
  }
  return names;
}

const webStorage: Check = {
  id: "web-storage",
  profiles: ["store", "release"],
  run: async (p) => {
    const files: string[] = [];
    let kvStore = false;
    for await (const { rel, text } of appSources(p.appDir)) {
      if (WEB_STORAGE.test(text)) files.push(rel);
      kvStore ||= /\bopenKeyValueStore\s*\(/.test(text);
    }
    const out: MobileDoctorFinding[] = [];
    if (files.length > 0) {
      out.push({
        check: "web-storage",
        level: "warning",
        message: `${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""} keep data in ` +
          "localStorage / IndexedDB, which iOS and Android may clear from the WebView under " +
          'storage pressure (Capacitor: WebView storage "must be considered transient")',
        fix: "keep what must survive in openKeyValueStore() from denext/mobile (`denext mobile " +
          "add storage`: a SQLite file in the app's data folder), or AsyncStorage / MMKV in " +
          "React Native mode, which run on it; secrets go in secureStore",
      });
    }
    const deps = await dependencies(p);
    const needs = DURABLE_STORE_USERS.filter((n) => deps.has(n));
    if (kvStore) needs.push("openKeyValueStore()");
    if (needs.length > 0 && !(await hasDurableStore(p))) {
      out.push({
        check: "web-storage",
        level: "warning",
        message: `${needs.join(", ")} fall back to the WebView's IndexedDB (evictable): the ` +
          "project has no durable native store",
        fix: "run `denext mobile add storage` (the DenextStorage plugin), then rebuild the app",
      });
    }
    return out;
  },
};

/**
 * Absolute css→shim import-map entries an interrupted `denext dev` / `mobile dev` / export left
 * in the app's committed `deno.json`: machine-specific paths that break every other checkout
 * (and CI) building the app.
 */
const cssShimLeak: Check = {
  id: "css-shim-imports",
  profiles: ["store", "release"],
  run: async (p) => {
    for (const name of ["deno.json", "deno.jsonc"]) {
      if ((await readText(join(p.appDir, name))) === null) continue;
      // The committed state: a live run's backup when it has its redirects injected.
      const keys = await leakedCssShimKeys(join(p.appDir, name), join(p.appDir, ".denext"));
      if (keys.length === 0) return [];
      return [{
        check: "css-shim-imports",
        level: "error",
        message: `${name} has ${keys.length} leaked css-shim import entr${
          keys.length === 1 ? "y" : "ies"
        } (${keys[0]}${keys.length > 1 ? ", …" : ""}) from an interrupted build or dev run`,
        fix: "run `denext export` (or `denext dev`) once, which removes them, or delete those " +
          "`imports` entries by hand before committing",
      }];
    }
    return [];
  },
};

/** The source capacitor.config's `appId` (the first config read), when it is a string. */
function sourceAppId(p: MobileProject): string | undefined {
  const id = p.configs[0]?.config.appId;
  return typeof id === "string" ? id : undefined;
}

/**
 * fastlane (`denext mobile add fastlane`, or a team's own): only when `fastlane/` exists. The
 * Appfile's ids against capacitor.config, the Gemfile and its lock, a Fastfile that bypasses
 * `denext export` + `cap sync`, and secrets kept in or written into `fastlane/`.
 */
const fastlane: Check = {
  id: "fastlane",
  profiles: ["release"],
  applies: (p) => isDir(join(p.root, "fastlane")),
  run: async (p) =>
    ((await fastlaneFindings(p.root, sourceAppId(p))) ?? []).map((f) => ({
      check: "fastlane",
      ...f,
    })),
};

/** Every check, in report order. */
const CHECKS: readonly Check[] = [
  serverUrl,
  webviewDebugging,
  cleartext,
  mixedContent,
  legacyBridge,
  allowNavigation,
  bridgeFrameGuard,
  androidDebuggable,
  productionLogging,
  csp,
  sourceMaps,
  secrets,
  usageStrings,
  privacyManifest,
  appIcons,
  splash,
  accountDeletion,
  webStorage,
  cssShimLeak,
  fastlane,
];

/** The ids of the checks a profile runs (for docs and `--json`). */
export function mobileDoctorChecks(profile: MobileDoctorProfile): string[] {
  return CHECKS.filter((c) => c.profiles.includes(profile)).map((c) => c.id);
}

/**
 * Run the doctor over a Capacitor project.
 *
 * @param opts The project, the profile, and the denext app to scan for auth.
 * @returns The checks run and what they found.
 * @throws When `root` holds no `capacitor.config.*`.
 */
export async function runMobileDoctor(opts: MobileDoctorOptions): Promise<MobileDoctorReport> {
  if (!(await capacitorConfigFile(opts.root))) {
    throw new Error(`no Capacitor project (capacitor.config.*) in ${opts.root}`);
  }
  const project = await readMobileProject(opts.root, opts.appDir ?? opts.root);
  const checks: Check[] = [];
  for (const check of CHECKS) {
    if (!check.profiles.includes(opts.profile)) continue;
    if (!check.applies || await check.applies(project)) checks.push(check);
  }
  const findings: MobileDoctorFinding[] = [];
  for (const check of checks) findings.push(...await check.run(project, opts.profile));
  return { root: opts.root, profile: opts.profile, checks: checks.map((c) => c.id), findings };
}

/**
 * The report as the lines `denext mobile doctor` prints.
 *
 * @param report A report from {@linkcode runMobileDoctor}.
 * @returns The text, without a trailing newline.
 */
export function formatMobileDoctor(report: MobileDoctorReport): string {
  const lines = report.checks.map((id) => {
    const found = report.findings.filter((f) => f.check === id);
    const mark = found.some((f) => f.level === "error") ? "✖" : found.length > 0 ? "!" : "✔";
    return `  ${mark} ${id}`;
  });
  for (const f of report.findings) {
    lines.push(
      "",
      `  ${f.level === "error" ? "ERROR  " : "WARNING"} [${f.check}] ${f.message}`,
      `          fix: ${f.fix}`,
    );
  }
  const errors = report.findings.filter((f) => f.level === "error").length;
  const warnings = report.findings.length - errors;
  lines.push(
    "",
    errors + warnings === 0
      ? "  All checks passed."
      : `  ${errors} error(s), ${warnings} warning(s).`,
  );
  return lines.join("\n");
}
