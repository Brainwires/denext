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

import { join, resolve } from "@std/path";
import { commit, objectDeleteEdits, objectSetEdits, unwrap } from "./config-edit.ts";
import { type Node, parseModule } from "./swc-ast.ts";
import { CAPACITOR_CONFIGS, type CommandRunner } from "./mobile-capabilities.ts";

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
 * Put a config a previous session edited back to its original bytes, if a backup is left.
 *
 * @param root The Capacitor project.
 * @returns The file restored, or `null` when there was nothing to restore.
 */
export async function restoreCapacitorConfig(root: string): Promise<string | null> {
  let backup: { file?: unknown; original?: unknown };
  try {
    backup = JSON.parse(await Deno.readTextFile(backupPath(root)));
  } catch {
    return null;
  }
  const file = typeof backup.file === "string" ? resolve(root, backup.file) : null;
  // Only ever a capacitor.config.* inside this project: the backup is a file on disk, and a
  // planted one must not turn "restore" into "write anywhere".
  const known = file !== null && CAPACITOR_CONFIGS.some((name) => file === join(root, name));
  if (!known || typeof backup.original !== "string") {
    throw new Error(`${backupPath(root)} is not a mobile dev backup; remove it by hand`);
  }
  await Deno.writeTextFile(file, backup.original);
  await Deno.remove(backupPath(root));
  return file;
}

/** Back up `file`'s bytes, then write the dev-server edit over it. */
async function applyDevServerUrl(root: string, file: string, url: string): Promise<void> {
  const original = await Deno.readTextFile(file);
  const edited = await withDevServerUrl(file, original, url);
  await Deno.mkdir(join(root, ".denext"), { recursive: true });
  await Deno.writeTextFile(
    backupPath(root),
    JSON.stringify({ file: file.slice(root.length + 1), original }),
  );
  await Deno.writeTextFile(file, edited);
}

/** `npx cap copy`: pushes the (edited or restored) config into the native projects. */
async function capCopy(deps: MobileDevDeps, root: string): Promise<void> {
  const { code } = await deps.run({ cmd: "npx", args: ["cap", "copy"], cwd: root });
  if (code !== 0) {
    throw new Error(
      `\`npx cap copy\` exited with ${code} (it needs the web assets built once: ` +
        "run your build / `denext export` into the config's webDir first)",
    );
  }
}

/** What to do on the device once the config points at the dev server. */
function nextSteps(server: MobileDevServer): string {
  const loopback = /\/\/(localhost|127\.)/.test(server.url);
  return [
    "",
    `  denext mobile dev  ▸  the app now loads ${server.url}` +
    (server.attached ? " (attached to the running dev server)" : ""),
    "",
    "  Run the app on the device:",
    "    iOS      open ios/App/App.xcworkspace in Xcode and Run (or `npx cap run ios`)",
    "    Android  `npx cap run android` (or Run in Android Studio)",
    loopback
      ? "  The URL is loopback: only the iOS simulator (or Android with `adb reverse tcp:PORT " +
        "tcp:PORT`) reaches it. Use --lan for a physical device on your network."
      : "  The device must be on the same network as this machine.",
    "  Edits reload on the device. Ctrl-C restores capacitor.config and runs `cap copy` again.",
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
    await applyDevServerUrl(root, file, server.url);
    await capCopy(deps, root);
    deps.log(nextSteps(server));
    await Promise.race([stopped, server.finished]);
  } finally {
    try {
      await restoreCapacitorConfig(root);
      await capCopy(deps, root).catch((err) =>
        deps.log(`  warning: ${err.message}; run \`npx cap copy\` before building a release`)
      );
    } finally {
      await server.stop();
    }
  }
}
