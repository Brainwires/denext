// `denext mobile dev`: Capacitor live reload against `denext dev` (the Metro model).
//
// The phone's WebView loads the app from the dev server itself — `server.url` in the Capacitor
// config — so the page origin IS the dev server. That is what lets the existing live-reload
// stream and the dev origin gate work unchanged: the device's requests are same-origin, and
// the host they name is the one the dev server was bound to (and therefore allowed).
//
// The config edit is TEMPORARY. The original bytes are backed up to `.denext/` before the edit
// and written back on every exit path (normal end, Ctrl-C, SIGTERM, an error), followed by
// another `cap copy` so the native projects stop pointing at the dev server too. A run killed
// outright (SIGKILL, power loss) leaves the backup behind; the next `mobile dev` (or
// `mobile dev --restore`) puts the config back before doing anything else.
//
// iOS needs two Info.plist keys for the WebView to reach a LAN dev server at all (`cleartext`
// is Android-only): App Transport Security's `NSAllowsLocalNetworking`, and a
// `NSLocalNetworkUsageDescription` (without one, iOS 14+ silently denies local-network
// requests). They are added for the session the same way, backed up in the same file and put
// back with the config. Android needs nothing more: `cap copy` turns `server.cleartext` into
// `android:usesCleartextTraffic="true"` in the capacitor-cordova-android-plugins manifest,
// which the manifest merger carries into the app.
//
// `cap copy` also writes the config into the native projects (the two NATIVE_CONFIGS), and on
// exit it FAILS when the `webDir` export is missing, as it usually is during a dev session. So
// the restore never relies on it: it scrubs the native copies itself, putting back the `server`
// block each had at session start (recorded in the backup), then tries `cap copy` anyway.

import { join, resolve } from "@std/path";
import { commit, objectDeleteEdits, objectSetEdits, unwrap } from "./config-edit.ts";
import { type Node, parseModule } from "./swc-ast.ts";
import { CAPACITOR_CONFIGS, type CommandRunner } from "./mobile-capabilities.ts";
import { withPlistDefault, withPlistDictTrue } from "./mobile-native-config.ts";

/** A dev server `mobile dev` started or attached to. */
export interface MobileDevServer {
  /** The URL the device loads (`http://192.168.1.5:3000`). */
  readonly url: string;
  /** True when a server was already answering there (it is left running on exit). */
  readonly attached: boolean;
  /** Resolves when the server ends by itself. */
  readonly finished: Promise<void>;
  /** Stop the server (a no-op for an attached one). */
  stop(): Promise<void>;
}

/** The edges of {@linkcode runMobileDev}, injected so tests never spawn a server or `cap`. */
export interface MobileDevDeps {
  /** Runs `npx cap copy` in the Capacitor project. */
  readonly run: CommandRunner;
  /** Start `denext dev`, or attach to one already answering at the target URL. */
  readonly startServer: () => Promise<MobileDevServer>;
  /** Resolves when the developer stops the session (Ctrl-C / SIGTERM). */
  readonly waitForStop: () => Promise<void>;
  /** Progress output. */
  readonly log: (line: string) => void;
}

/** Options for {@linkcode runMobileDev}. */
export interface MobileDevOptions {
  /** The directory the command runs from. */
  readonly cwd: string;
  /** `--dir`: the Capacitor project (default: `cwd`). */
  readonly dir?: string;
}

/** The iOS app's Info.plist, relative to the Capacitor project. */
const IOS_INFO_PLIST = "ios/App/App/Info.plist";

/** The config copies `cap copy` writes into the native projects, relative to the project. */
const NATIVE_CONFIGS: readonly string[] = [
  "ios/App/App/capacitor.config.json",
  "android/app/src/main/assets/capacitor.config.json",
];

/** The `NSLocalNetworkUsageDescription` added when the app declares none. */
export const LOCAL_NETWORK_USAGE =
  "Connects to the denext dev server on your computer for live reload.";

/** Where the pre-edit config is kept while a session runs. */
function backupPath(root: string): string {
  return join(root, ".denext", "mobile-dev-backup.json");
}

/** The Capacitor config file of `root`, in Capacitor's own lookup order. */
export async function capacitorConfigFile(root: string): Promise<string | null> {
  for (const name of CAPACITOR_CONFIGS) {
    try {
      if ((await Deno.stat(join(root, name))).isFile) return join(root, name);
    } catch { /* not this one */ }
  }
  return null;
}

/** Top-level `const x = …` / `export const x = …` initialisers, by name. */
function topLevelBindings(body: Node[]): Map<string, Node> {
  const out = new Map<string, Node>();
  for (const item of body) {
    const decl = item.type === "ExportDeclaration" ? item.declaration : item;
    if (decl?.type !== "VariableDeclaration") continue;
    for (const d of decl.declarations ?? []) {
      if (d.id?.type === "Identifier" && d.init) out.set(d.id.value, d.init);
    }
  }
  return out;
}

/** The object literal an exported expression is: itself, a `const` it names, or a call's arg. */
function objectOf(expr: Node, bindings: Map<string, Node>): Node | null {
  let e = unwrap(expr ?? {});
  if (e.type === "Identifier") e = unwrap(bindings.get(e.value) ?? {});
  if (e.type === "CallExpression") e = unwrap(e.arguments?.[0]?.expression ?? {});
  return e.type === "ObjectExpression" ? e : null;
}

/** Whether `node` is `module.exports`. */
function isModuleExports(node: Node): boolean {
  const n = unwrap(node ?? {});
  return n.type === "MemberExpression" && n.object?.value === "module" &&
    n.property?.value === "exports";
}

/** The exported config object: `export default {…}` / `config` / `defineConfig({…})` / CJS. */
function exportedObject(body: Node[]): Node | null {
  const bindings = topLevelBindings(body);
  for (const item of body) {
    if (item.type === "ExportDefaultExpression") return objectOf(item.expression, bindings);
    const assign = item.type === "ExpressionStatement" ? item.expression : null;
    if (assign?.type === "AssignmentExpression" && isModuleExports(assign.left)) {
      return objectOf(assign.right, bindings);
    }
  }
  return null;
}

/** Set one key path in a JS/TS config module's exported object, splicing only that value. */
async function spliceModule(source: string, path: string[], value: unknown): Promise<string> {
  const parsed = await parseModule(source);
  const obj = parsed ? exportedObject(parsed.body) : null;
  if (!parsed || !obj) {
    throw new Error(
      "could not find the exported config object (expected `export default {…}`, " +
        "`export default config` with `const config = {…}`, or `module.exports = {…}`)",
    );
  }
  const edits = objectSetEdits(parsed.ctx, obj, path, value);
  if (!edits.ok) throw new Error(`cannot set ${path.join(".")}: ${edits.reason}`);
  const result = await commit(source, parsed.ctx, edits.edits, "capacitor.config");
  if (!result.ok) throw new Error(result.reason);
  return result.source;
}

/**
 * The config source with `server.url` set to `url` and `server.cleartext` to `true` (Android
 * refuses plain http without it), keeping every other byte for a JS/TS module.
 *
 * @param file The config file's path (its extension picks JSON or module editing).
 * @param source Its current content.
 * @param url The dev server URL.
 * @returns The edited source.
 */
export async function withDevServerUrl(file: string, source: string, url: string): Promise<string> {
  if (file.endsWith(".json")) {
    const config = JSON.parse(source) as { server?: Record<string, unknown> };
    config.server = { ...config.server, url, cleartext: true };
    return JSON.stringify(config, null, 2) + "\n";
  }
  const withUrl = await spliceModule(source, ["server", "url"], url);
  return await spliceModule(withUrl, ["server", "cleartext"], true);
}

/** `value` with every object's keys sorted, recursively (arrays keep their order). */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((k) => [k, sortedKeys((value as Record<string, unknown>)[k])]),
  );
}

/**
 * The config source without its top-level `server` block, the part `mobile dev` edits (and that
 * `denext mobile fingerprint` leaves out). JSON is re-serialised canonically (keys sorted,
 * two-space indent) without the key, so its formatting never matters; a JS/TS module has just
 * that property spliced out. A module with no `server` key, and a source this cannot parse, comes
 * back unchanged.
 *
 * @param file The config file's path (its extension picks JSON or module editing).
 * @param source Its content.
 * @returns The source without `server`.
 */
export async function withoutServerBlock(file: string, source: string): Promise<string> {
  if (file.endsWith(".json")) {
    try {
      const config = JSON.parse(source) as unknown;
      if (typeof config !== "object" || config === null || Array.isArray(config)) return source;
      const { server: _server, ...rest } = config as Record<string, unknown>;
      return JSON.stringify(sortedKeys(rest), null, 2) + "\n";
    } catch {
      return source;
    }
  }
  const parsed = await parseModule(source);
  const obj = parsed ? exportedObject(parsed.body) : null;
  if (!parsed || !obj) return source;
  const edits = objectDeleteEdits(parsed.ctx, obj, ["server"]);
  if (!edits.ok) return source;
  const result = await commit(source, parsed.ctx, edits.edits, "capacitor.config");
  return result.ok ? result.source : source;
}

/**
 * The Info.plist source with what a WebView needs to load a dev server on the LAN:
 * `NSAppTransportSecurity` → `NSAllowsLocalNetworking` = true (merged into an existing ATS
 * dict) and a `NSLocalNetworkUsageDescription` when the app has none (its own is kept).
 * Unchanged when both are already there; null when the plist has no top-level dict, or its
 * `NSAppTransportSecurity` is not a dict.
 *
 * @param plist The Info.plist text.
 * @returns The edited text.
 */
export function withLocalNetworkAccess(plist: string): string | null {
  const ats = withPlistDictTrue(plist, "NSAppTransportSecurity", "NSAllowsLocalNetworking");
  return ats && withPlistDefault(ats, "NSLocalNetworkUsageDescription", LOCAL_NETWORK_USAGE);
}

/** One backed-up file: its path relative to the project, and its original text. */
interface BackedUpFile {
  file: string;
  original: string;
}

/**
 * What `.denext/mobile-dev-backup.json` holds: the config, the Info.plist when edited, and the
 * native config copies that existed at session start.
 */
interface MobileDevBackup extends BackedUpFile {
  plist?: BackedUpFile;
  native?: BackedUpFile[];
}

/** A backup's parsed targets (absolute paths). */
interface BackupTargets {
  files: BackedUpFile[];
  native: BackedUpFile[];
}

/** `entry` as a backed-up file inside `root` that `allowed` accepts, or null. */
function backedUp(
  root: string,
  entry: unknown,
  allowed: (file: string) => boolean,
): BackedUpFile | null {
  if (typeof entry !== "object" || entry === null) return null;
  const { file, original } = entry as Record<string, unknown>;
  if (typeof file !== "string" || typeof original !== "string") return null;
  const path = resolve(root, file);
  return allowed(path) ? { file: path, original } : null;
}

/**
 * The files a backup restores. Only ever a capacitor.config.* and ios/App/App/Info.plist inside
 * this project: the backup is a file on disk, and a planted one must not turn "restore" into
 * "write anywhere".
 */
function backupTargets(root: string, backup: unknown): BackupTargets {
  const bad = new Error(`${backupPath(root)} is not a mobile dev backup; remove it by hand`);
  const config = backedUp(
    root,
    backup,
    (path) => CAPACITOR_CONFIGS.some((name) => path === join(root, name)),
  );
  if (!config) throw bad;
  const { plist: plistEntry, native: nativeEntries } = backup as Record<string, unknown>;
  const files = [config];
  if (plistEntry !== undefined) {
    const plist = backedUp(root, plistEntry, (path) => path === join(root, IOS_INFO_PLIST));
    if (!plist) throw bad;
    files.push(plist);
  }
  if (nativeEntries === undefined) return { files, native: [] };
  if (!Array.isArray(nativeEntries)) throw bad;
  const isNative = (path: string) => NATIVE_CONFIGS.some((name) => path === join(root, name));
  const native = nativeEntries.map((entry) => backedUp(root, entry, isNative));
  if (native.some((entry) => entry === null)) throw bad;
  return { files, native: native as BackedUpFile[] };
}

/** True for an `http:` URL on a loopback or private-LAN host: a dev server, never production. */
function isDevServerUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host.endsWith(".local") || host === "::1" ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
    /^f[cde][0-9a-f]{0,2}:/.test(host);
}

/** A native copy's `server` block with the dev-server keys a crashed session left removed. */
function withoutDevServer(server: unknown): unknown {
  if (typeof server !== "object" || server === null || Array.isArray(server)) return server;
  const block = server as Record<string, unknown>;
  if (!isDevServerUrl(block.url)) return server;
  const { url: _url, cleartext, ...rest } = block;
  if (cleartext !== undefined && cleartext !== true) rest.cleartext = cleartext;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** A JSON config's `server` value, or null when the text is not a JSON object. */
function jsonServer(text: string): { server: unknown } | null {
  try {
    const config = JSON.parse(text) as unknown;
    if (typeof config !== "object" || config === null || Array.isArray(config)) return null;
    return { server: (config as Record<string, unknown>).server };
  } catch {
    return null;
  }
}

/**
 * The native copy with its `server` block set to `server` (removed when undefined), keeping
 * the file's indent and trailing newline; unchanged text when the value already matches.
 */
function withServer(text: string, server: unknown): string {
  const config = JSON.parse(text) as Record<string, unknown>;
  if (JSON.stringify(config.server) === JSON.stringify(server)) return text;
  if (server === undefined) delete config.server;
  else config.server = server;
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
  return JSON.stringify(config, null, indent) + (text.endsWith("\n") ? "\n" : "");
}

/**
 * Take the dev server out of the native config copies `cap copy` wrote: each gets back the
 * `server` block its backed-up original had (none: the key goes). A copy with no backup entry
 * (an older backup, or none) loses a `server.url` that is a LAN/loopback `http` origin.
 * Written only when it changes. Resolves to the files written.
 */
async function scrubNativeConfigs(root: string, backedUpNative: BackedUpFile[]): Promise<string[]> {
  const written: string[] = [];
  for (const name of NATIVE_CONFIGS) {
    const path = join(root, name);
    let text: string;
    try {
      text = await Deno.readTextFile(path);
    } catch {
      continue;
    }
    const current = jsonServer(text);
    if (!current) continue;
    const entry = backedUpNative.find((e) => e.file === path);
    const original = entry ? jsonServer(entry.original) : null;
    const next = withServer(text, original ? original.server : withoutDevServer(current.server));
    if (next === text) continue;
    await Deno.writeTextFile(path, next);
    written.push(path);
  }
  return written;
}

/** The native config copies present now, as backup entries (paths relative to the project). */
async function nativeOriginals(root: string): Promise<BackedUpFile[]> {
  const entries: BackedUpFile[] = [];
  for (const file of NATIVE_CONFIGS) {
    try {
      entries.push({ file, original: await Deno.readTextFile(join(root, file)) });
    } catch {
      // not generated yet (no `cap add` for that platform)
    }
  }
  return entries;
}

/** What a restore changed: the files put back from the backup, and the native copies scrubbed. */
interface MobileDevRestore {
  /** The backup's config file, or null when no backup was left. */
  readonly config: string | null;
  /** The config / Info.plist files whose bytes were put back (unchanged ones are not written). */
  readonly restored: string[];
  /** The native config copies the dev server URL was taken out of. */
  readonly scrubbed: string[];
}

/** Write `original` over `file` unless it already holds exactly those bytes; true when written. */
async function writeIfChanged(file: string, original: string): Promise<boolean> {
  const bytes = new TextEncoder().encode(original);
  try {
    const current = await Deno.readFile(file);
    if (current.length === bytes.length && current.every((b, i) => b === bytes[i])) return false;
  } catch {
    // missing: write it
  }
  await Deno.writeFile(file, bytes);
  return true;
}

/**
 * Put a config (and Info.plist) a previous session edited back to its original bytes, if a
 * backup is left, and take the dev server out of the native config copies either way (they
 * are git-ignored, so a leftover `server.url` would ship silently in the next native build).
 *
 * @param root The Capacitor project.
 * @returns What changed.
 */
async function restoreMobileDev(root: string): Promise<MobileDevRestore> {
  let backup: unknown;
  try {
    backup = JSON.parse(await Deno.readTextFile(backupPath(root)));
  } catch {
    return { config: null, restored: [], scrubbed: await scrubNativeConfigs(root, []) };
  }
  const { files, native } = backupTargets(root, backup);
  const restored: string[] = [];
  for (const { file, original } of files) {
    if (await writeIfChanged(file, original)) restored.push(file);
  }
  const scrubbed = await scrubNativeConfigs(root, native);
  await Deno.remove(backupPath(root));
  return { config: files[0].file, restored, scrubbed };
}

/**
 * {@linkcode restoreMobileDev}, reduced to one path.
 *
 * @param root The Capacitor project.
 * @returns The config file restored (else the first native copy scrubbed), or `null` when
 * there was nothing to restore.
 */
export async function restoreCapacitorConfig(root: string): Promise<string | null> {
  const { config, scrubbed } = await restoreMobileDev(root);
  return config ?? scrubbed[0] ?? null;
}

/** One line per file a restore changed, or "nothing to restore". */
function restoreLines({ restored, scrubbed }: MobileDevRestore): string[] {
  const lines = [
    ...restored.map((file) => `  restored ${file}`),
    ...scrubbed.map((file) => `  scrubbed the dev server URL from ${file}`),
  ];
  return lines.length > 0 ? lines : ["  nothing to restore"];
}

/** `cap copy` after a restore: a failure (usually a missing webDir export) is only a note. */
async function copyAfterRestore(deps: Pick<MobileDevDeps, "run" | "log">, root: string) {
  await capCopy(deps, root).catch((err) =>
    deps.log(
      `  note: ${err.message}. The native projects no longer point at the dev server, but ` +
        "their web assets were not refreshed: run your export and `npx cap copy` before a " +
        "release build.",
    )
  );
}

/**
 * `denext mobile dev --restore`: put back what a killed session left, log one line per file
 * changed, and re-run `cap copy` when anything changed (a failure is a note, not an error).
 *
 * @param root The Capacitor project.
 * @param deps Runs `npx cap copy`, and prints.
 */
export async function restoreMobileDevSession(
  root: string,
  deps: Pick<MobileDevDeps, "run" | "log">,
): Promise<void> {
  const result = await restoreMobileDev(root);
  for (const line of restoreLines(result)) deps.log(line);
  if (result.restored.length + result.scrubbed.length > 0) await copyAfterRestore(deps, root);
}

/** The Info.plist's text, or null when there is none (or it is not UTF-8, e.g. binary). */
async function readPlist(path: string): Promise<string | null> {
  try {
    const bytes = await Deno.readFile(path);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The Info.plist edit for the session: its backup entry and edited text, or null for none. */
async function plistEdit(
  root: string,
  log: (line: string) => void,
): Promise<{ backup: BackedUpFile; edited: string } | null> {
  const original = await readPlist(join(root, IOS_INFO_PLIST));
  if (original === null) return null;
  const edited = withLocalNetworkAccess(original);
  if (edited === null) {
    log(
      `  warning: could not edit ${IOS_INFO_PLIST}; add NSAppTransportSecurity > ` +
        "NSAllowsLocalNetworking = true and an NSLocalNetworkUsageDescription by hand",
    );
    return null;
  }
  return edited === original ? null : { backup: { file: IOS_INFO_PLIST, original }, edited };
}

/**
 * Back up the config's bytes (and the Info.plist's, when it changes), then write the
 * dev-server edits over them. Resolves to whether the Info.plist changed.
 */
async function applyDevSession(
  root: string,
  file: string,
  url: string,
  log: (line: string) => void,
): Promise<boolean> {
  const original = await Deno.readTextFile(file);
  const edited = await withDevServerUrl(file, original, url);
  const plist = await plistEdit(root, log);
  const backup: MobileDevBackup = { file: file.slice(root.length + 1), original };
  if (plist) backup.plist = plist.backup;
  const native = await nativeOriginals(root);
  if (native.length > 0) backup.native = native;
  await Deno.mkdir(join(root, ".denext"), { recursive: true });
  await Deno.writeTextFile(backupPath(root), JSON.stringify(backup));
  await Deno.writeTextFile(file, edited);
  if (plist) await Deno.writeTextFile(join(root, IOS_INFO_PLIST), plist.edited);
  return plist !== null;
}

/**
 * A warning when the Android app declares its own `android:networkSecurityConfig`: on API 24+
 * that config overrides the `usesCleartextTraffic` `cap copy` writes, so the device may refuse
 * the dev server's plain http. Null when there is no manifest or it declares none.
 */
async function androidCleartextWarning(root: string, url: string): Promise<string | null> {
  let manifest: string;
  try {
    manifest = await Deno.readTextFile(join(root, "android/app/src/main/AndroidManifest.xml"));
  } catch {
    return null;
  }
  if (!/\bandroid:networkSecurityConfig\s*=/.test(manifest)) return null;
  const host = new URL(url).hostname;
  return [
    "  warning: android/app/src/main/AndroidManifest.xml declares android:networkSecurityConfig.",
    "  On Android 7+ (API 24+) that config overrides usesCleartextTraffic, so the device may",
    `  refuse ${url}. Allow cleartext for ${host} in your network security config`,
    `  (<domain-config cleartextTrafficPermitted="true"><domain>${host}</domain></domain-config>),`,
    "  or serve the dev server over https.",
  ].join("\n");
}

/** The Xcode project to open: the `.xcworkspace` (CocoaPods) if there is one, else the
 * `.xcodeproj` (Swift Package Manager projects have no workspace). */
async function xcodeProject(root: string): Promise<string> {
  try {
    await Deno.stat(join(root, "ios/App/App.xcworkspace"));
    return "ios/App/App.xcworkspace";
  } catch {
    return "ios/App/App.xcodeproj";
  }
}

/** `npx cap copy`: pushes the (edited or restored) config into the native projects. */
async function capCopy(deps: Pick<MobileDevDeps, "run">, root: string): Promise<void> {
  const { code } = await deps.run({ cmd: "npx", args: ["cap", "copy"], cwd: root });
  if (code !== 0) {
    throw new Error(
      `\`npx cap copy\` exited with ${code} (it needs the web assets built once: ` +
        "run your build / `denext export` into the config's webDir first)",
    );
  }
}

/** The iOS side of the next steps: which Xcode project, and whether the Info.plist changed. */
interface IosSession {
  readonly project: string;
  readonly plistChanged: boolean;
}

/** What to do on the device once the config points at the dev server. */
function nextSteps(server: MobileDevServer, ios: IosSession): string {
  const loopback = /\/\/(localhost|127\.)/.test(server.url);
  return [
    "",
    `  denext mobile dev  ▸  the app now loads ${server.url}` +
    (server.attached ? " (attached to the running dev server)" : ""),
    "",
    "  Run the app on the device:",
    `    iOS      open ${ios.project} in Xcode and Run (or \`npx cap run ios\`)`,
    "    Android  `npx cap run android` (or Run in Android Studio)",
    ...(ios.plistChanged
      ? [
        "  Info.plist changed: rebuild and run the app from Xcode (it now allows local-network",
        "  http and declares local-network use, a native change `cap copy` does not carry).",
      ]
      : []),
    loopback
      ? "  The URL is loopback: only the iOS simulator (or Android with `adb reverse tcp:PORT " +
        "tcp:PORT`) reaches it. Use --lan for a physical device on your network."
      : "  The device must be on the same network as this machine.",
    `  Edits reload on the device. Ctrl-C restores capacitor.config` +
    (ios.plistChanged ? " and Info.plist," : "") + " and runs `cap copy` again.",
    "",
  ].join("\n");
}

/**
 * Point a Capacitor app at `denext dev` for one session, and put everything back afterwards.
 *
 * @param options Where to run and the Capacitor project.
 * @param deps The process-touching edges.
 */
export async function runMobileDev(options: MobileDevOptions, deps: MobileDevDeps): Promise<void> {
  const root = resolve(options.cwd, options.dir ?? ".");
  const healed = await restoreCapacitorConfig(root);
  if (healed) deps.log(`  restored ${healed} from an earlier session that did not exit cleanly`);
  const file = await capacitorConfigFile(root);
  if (!file) throw new Error(`no Capacitor project (capacitor.config.*) in ${root}`);
  // Listen for Ctrl-C from the start, so one pressed during `cap copy` still ends in a restore
  // (rather than the default exit, which would leave the edited config for the next run).
  const stopped = deps.waitForStop();
  const server = await deps.startServer();
  try {
    const plistChanged = await applyDevSession(root, file, server.url, deps.log);
    await capCopy(deps, root);
    deps.log(nextSteps(server, { project: await xcodeProject(root), plistChanged }));
    const android = await androidCleartextWarning(root, server.url);
    if (android) deps.log(android);
    await Promise.race([stopped, server.finished]);
  } finally {
    try {
      await restoreMobileDev(root);
      await copyAfterRestore(deps, root);
    } finally {
      await server.stop();
    }
  }
}
