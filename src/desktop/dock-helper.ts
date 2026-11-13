/**
 * The runtime half of `desktop.app.dock: "while-window-open"` (macOS): an accessory app gets a Dock
 * icon and a Cmd-Tab entry while one of its windows is showing, and never a tile in the Dock's
 * recent apps.
 *
 * The Dock adds a recent-apps tile when the running tile of an app it does not keep goes away (the
 * app quits, or a regular app turns accessory), only for a bundle under `/Applications`. So the app
 * itself stays accessory from launch to quit, and a helper app holds the icon: packaging builds it
 * into `Contents/Helpers/<Name>.app` (src/build/desktop-dock-helper.ts); the app copies it into its
 * data folder (`<data>/dock-helper/<Name>.app`, refreshed whenever the bundled copy's files differ,
 * staged beside it and renamed into place) and runs it as a child while a window shows: a regular
 * app with no window, named and iconed like the app.
 *
 * The two talk over the child's stdin / stdout pipes, newline-delimited JSON
 * (`{"t":"activate"}` and `{"t":"quit"}` from the helper, `{"t":"exit"}` to it): nothing another
 * process can reach, so no token and no socket. The helper exits on `exit` or when its stdin
 * closes, so it never outlives the app. Activating it (a Dock click, Cmd-Tab) hands the activation
 * back to the app, which brings its key window up; its Quit (the Dock menu, Cmd-Q while it is
 * frontmost) asks the app to quit, through the quit guards. Where the helper cannot be had (not a
 * packaged build, the copy or the launch failed, it kept crashing) the app keeps the accessory
 * behaviour: its windows, no Dock icon.
 *
 * Runtime-only (imported by `runDesktop` through app-windows.ts).
 *
 * @module
 */

import { dirname, join } from "@std/path";
import {
  DOCK_HELPER_BUNDLE_FOLDER,
  DOCK_HELPER_ENV,
  DOCK_HELPER_FOLDER,
  DOCK_HELPER_OWNER_KEY,
} from "../build/desktop-dock-helper.ts";

/** A message from the helper. */
export type DockHelperMessage = "ready" | "activate" | "quit";

/** A running helper, as the app drives it. */
export interface DockHelperChild {
  /** Ask it to leave (`{"t":"exit"}`, then its stdin is closed). */
  exit(): void;
  /** End it (SIGTERM): it did not leave when asked. */
  kill(): void;
  /** Its exit code, once it ended. */
  readonly exited: Promise<number>;
}

/** The helper inside the app's bundle. */
export interface DockHelperSource {
  /** The helper's `.app` (in the app's `Contents/Helpers`). */
  readonly bundle: string;
  /** Its folder name without `.app`, which is also its executable's name. */
  readonly fileName: string;
}

/**
 * The `.app` an executable runs from: `/Applications/X.app/Contents/MacOS/x` → `/Applications/X.app`.
 *
 * @param execPath The executable (`Deno.execPath()`).
 * @returns The bundle, or `undefined` for an executable outside one.
 */
export function bundleOfExecutable(execPath: string): string | undefined {
  const macos = dirname(execPath);
  const contents = dirname(macos);
  const bundle = dirname(contents);
  const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  if (base(macos) !== "MacOS" || base(contents) !== "Contents" || !bundle.endsWith(".app")) {
    return undefined;
  }
  return bundle;
}

/**
 * The Dock helper packaging built into `appBundle` (`Contents/Helpers/<Name>.app`, its Info.plist
 * naming {@linkcode DOCK_HELPER_OWNER_KEY}, its executable `Contents/MacOS/<Name>`).
 *
 * @param appBundle The app's `.app`.
 * @returns The helper, or `undefined` when the bundle has none.
 */
export async function findDockHelperSource(
  appBundle: string,
): Promise<DockHelperSource | undefined> {
  const helpers = join(appBundle, DOCK_HELPER_BUNDLE_FOLDER);
  let entries: Deno.DirEntry[];
  try {
    entries = [...await Array.fromAsync(Deno.readDir(helpers))];
  } catch {
    return undefined;
  }
  for (const e of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (!e.isDirectory || !e.name.endsWith(".app")) continue;
    const bundle = join(helpers, e.name);
    const fileName = e.name.slice(0, -".app".length);
    try {
      const plist = await Deno.readTextFile(join(bundle, "Contents", "Info.plist"));
      if (!plist.includes(`<key>${DOCK_HELPER_OWNER_KEY}</key>`)) continue;
      if (!(await Deno.stat(join(bundle, "Contents", "MacOS", fileName))).isFile) continue;
      return { bundle, fileName };
    } catch { /* not this one */ }
  }
  return undefined;
}

/** SHA-256 of `bytes`, lowercase hex. */
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Every entry under `dir`, sorted by path, relative and `/`-separated. */
async function listTree(
  dir: string,
  rel = "",
): Promise<Array<{ rel: string; info: Deno.FileInfo }>> {
  const out: Array<{ rel: string; info: Deno.FileInfo }> = [];
  const names = (await Array.fromAsync(Deno.readDir(join(dir, rel)))).map((e) => e.name).sort();
  for (const name of names) {
    const path = rel === "" ? name : `${rel}/${name}`;
    const info = await Deno.lstat(join(dir, path));
    out.push({ rel: path, info });
    if (info.isDirectory) out.push(...await listTree(dir, path));
  }
  return out;
}

/**
 * A fingerprint of a bundle's tree: every folder and file by path, each file's bytes and whether it
 * is executable. Two trees with the same fingerprint are the same helper. A symbolic link (the
 * helper has none) or any other kind of entry is refused.
 *
 * @param dir The bundle.
 * @returns The fingerprint (SHA-256, hex).
 * @throws When the tree cannot be read or holds a link.
 */
export async function treeFingerprint(dir: string): Promise<string> {
  const lines: string[] = [];
  for (const { rel, info } of await listTree(dir)) {
    if (info.isDirectory) lines.push(`d ${rel}`);
    else if (info.isFile) {
      const exec = ((info.mode ?? 0) & 0o111) !== 0 ? "x" : "-";
      lines.push(`f ${rel} ${exec} ${await sha256(await Deno.readFile(join(dir, rel)))}`);
    } else throw new Error(`${join(dir, rel)} is not a file or a folder`);
  }
  return await sha256(new TextEncoder().encode(lines.join("\n")));
}

/** Copy `from`'s tree into `to` (new), byte for byte: no extended attributes, no quarantine. */
async function copyTree(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true, mode: 0o700 });
  for (const { rel, info } of await listTree(from)) {
    const target = join(to, rel);
    if (info.isDirectory) await Deno.mkdir(target, { mode: 0o755 });
    else if (info.isFile) {
      const mode = ((info.mode ?? 0) & 0o111) !== 0 ? 0o755 : 0o644;
      await Deno.writeFile(target, await Deno.readFile(join(from, rel)), { mode });
      await Deno.chmod(target, mode);
    } else throw new Error(`${join(from, rel)} is not a file or a folder`);
  }
  await Deno.chmod(to, 0o755);
}

/**
 * Copy the helper into the app's data folder unless the copy there is already the same tree
 * (`<data>/dock-helper/<Name>.app`): staged in a new folder beside it, checked against the bundled
 * copy, then renamed into place (the app may not write the executable's own path: the run grant
 * denies it). The folder is the user's own (0700) and must not be a link.
 *
 * @param source The bundled helper.
 * @param dataDir The app's data folder.
 * @returns The copy's executable.
 * @throws When the copy cannot be made or does not match.
 */
export async function installDockHelper(
  source: DockHelperSource,
  dataDir: string,
): Promise<string> {
  const root = join(dataDir, DOCK_HELPER_FOLDER);
  await Deno.mkdir(root, { recursive: true, mode: 0o700 });
  const info = await Deno.lstat(root);
  if (info.isSymlink || !info.isDirectory) throw new Error(`${root} is not a folder`);
  await Deno.chmod(root, 0o700);
  const name = `${source.fileName}.app`;
  const dest = join(root, name);
  const exe = join(dest, "Contents", "MacOS", source.fileName);
  const want = await treeFingerprint(source.bundle);
  if (await treeFingerprint(dest).catch(() => undefined) === want) return exe;
  const stage = join(root, `.stage-${crypto.randomUUID()}`);
  try {
    await copyTree(source.bundle, join(stage, name));
    if (await treeFingerprint(join(stage, name)) !== want) {
      throw new Error("the staged copy differs from the bundled helper");
    }
    await Deno.remove(dest, { recursive: true }).catch((e) => {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    });
    await Deno.rename(join(stage, name), dest);
  } finally {
    await Deno.remove(stage, { recursive: true }).catch(() => {});
  }
  if (await treeFingerprint(dest) !== want) {
    throw new Error(`${dest} differs from the bundled helper`);
  }
  return exe;
}

/** The messages the helper sends. */
const MESSAGES: ReadonlySet<string> = new Set(["ready", "activate", "quit"]);

/**
 * The helper's message on one line of its stdout, or `undefined` for anything else.
 *
 * @param line One line.
 * @returns The message.
 */
export function parseDockHelperLine(line: string): DockHelperMessage | undefined {
  try {
    const t = (JSON.parse(line) as { t?: unknown } | null)?.t;
    return typeof t === "string" && MESSAGES.has(t) ? t as DockHelperMessage : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run the helper's executable as a child: stdin / stdout piped (its messages go to `onMessage`),
 * stderr dropped, and only {@linkcode DOCK_HELPER_ENV} in its environment.
 *
 * @param exe The copy's executable.
 * @param onMessage Called with each message.
 * @returns The child.
 */
function spawnDockHelper(
  exe: string,
  onMessage: (message: DockHelperMessage) => void,
): DockHelperChild {
  const child = new Deno.Command(exe, {
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
    clearEnv: true,
    env: { [DOCK_HELPER_ENV]: "1" },
  }).spawn();
  const writer = child.stdin.getWriter();
  (async () => {
    let rest = "";
    for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
      rest += chunk;
      for (let nl = rest.indexOf("\n"); nl >= 0; nl = rest.indexOf("\n")) {
        const message = parseDockHelperLine(rest.slice(0, nl));
        rest = rest.slice(nl + 1);
        if (message) onMessage(message);
      }
    }
  })().catch(() => {});
  let leaving = false;
  return {
    exit: () => {
      if (leaving) return;
      leaving = true;
      writer.write(new TextEncoder().encode('{"t":"exit"}\n'))
        .then(() => writer.close())
        .catch(() => {});
    },
    kill: () => {
      try {
        child.kill("SIGTERM");
      } catch { /* gone */ }
    },
    exited: child.status.then((s) => s.code),
  };
}

/** What {@linkcode createDockPresence} needs. */
export interface DockPresenceOptions {
  /** Whether the app has a window showing (the helper should run). */
  readonly wanted: () => boolean;
  /**
   * Install and start the helper, its messages to `onMessage`; `undefined` (or a throw) when it
   * cannot run, which ends the presence for this launch.
   */
  readonly launch: (
    onMessage: (message: DockHelperMessage) => void,
  ) => Promise<DockHelperChild | undefined>;
  /** The user activated the helper: bring the app's window up. */
  readonly onActivate: () => void;
  /** The user chose the helper's Quit: quit the app. */
  readonly onQuit: () => void;
  /** Where warnings go. */
  readonly warn: (message: string) => void;
  /** How long the helper stays after the last window went away (default 400 ms). */
  readonly stopDelayMs?: number;
  /** How often the windows are looked at besides their events (default 500 ms; 0: never). */
  readonly pollMs?: number;
  /** How long a helper asked to leave gets before it is ended (default 3 s). */
  readonly exitGraceMs?: number;
  /** Clock (tests). */
  readonly now?: () => number;
}

/** What {@linkcode createDockPresence} returns. */
export interface DockPresence {
  /** Look at the windows now: start or stop the helper to match. */
  sync(): void;
  /** Stop the helper and the polling for good. */
  dispose(): void;
  /** Where it is (tests and diagnostics). */
  state(): "idle" | "starting" | "running" | "stopping" | "failed" | "disposed";
}

/** A helper that ended this many times within {@link CRASH_WINDOW_MS} is given up on. */
const MAX_CRASHES = 3;
/** The window the crashes are counted in. */
const CRASH_WINDOW_MS = 60_000;

/**
 * Keep the helper running exactly while the app has a window showing: started when the first
 * window shows, asked to leave shortly after the last one went away (a window replaced by another
 * keeps it), started again after a crash, and given up on (a warning; the accessory behaviour
 * stays) once it fails to start or ends by itself {@link MAX_CRASHES} times within a minute.
 *
 * @param o The windows, the launcher, the handlers.
 * @returns The presence.
 */
export function createDockPresence(o: DockPresenceOptions): DockPresence {
  const now = o.now ?? Date.now;
  const stopDelay = o.stopDelayMs ?? 400;
  const grace = o.exitGraceMs ?? 3_000;
  let state: ReturnType<DockPresence["state"]> = "idle";
  let child: DockHelperChild | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const crashes: number[] = [];
  const give = (why: string) => {
    if (state === "disposed") return;
    state = "failed";
    o.warn(
      `desktop.app.dock "while-window-open": ${why}; the app's windows open without a Dock icon`,
    );
  };
  const onMessage = (m: DockHelperMessage) => {
    if (state !== "running" && state !== "starting") return;
    try {
      if (m === "activate") o.onActivate();
      else if (m === "quit") o.onQuit();
    } catch (err) {
      o.warn(`the Dock helper's ${m} failed: ${err instanceof Error ? err.message : err}`);
    }
  };
  const ended = (which: DockHelperChild) => {
    if (child !== which) return;
    child = undefined;
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
      killTimer = undefined;
    }
    if (state === "disposed" || state === "failed") return;
    if (state === "running") {
      const t = now();
      crashes.push(t);
      while (crashes.length > 0 && t - crashes[0] > CRASH_WINDOW_MS) crashes.shift();
      if (crashes.length >= MAX_CRASHES) {
        give(`the Dock helper ended by itself ${crashes.length} times within a minute`);
        return;
      }
    }
    state = "idle";
    sync();
  };
  const start = () => {
    state = "starting";
    o.launch(onMessage).then((c) => {
      if (state !== "starting") {
        c?.exit();
        return;
      }
      if (!c) return give("the Dock helper is not available");
      child = c;
      state = "running";
      c.exited.then(() => ended(c), () => ended(c));
      if (!o.wanted()) sync();
    }, (err) => {
      if (state === "starting") {
        give(`the Dock helper could not start (${err instanceof Error ? err.message : err})`);
      }
    });
  };
  const stop = () => {
    stopTimer = undefined;
    const c = child;
    if (state !== "running" || !c) return;
    state = "stopping";
    c.exit();
    const kill = setTimeout(() => {
      killTimer = undefined;
      if (child === c) c.kill();
    }, grace);
    Deno.unrefTimer(kill);
    killTimer = kill;
  };
  const sync = () => {
    if (state === "failed" || state === "disposed") return;
    let want: boolean;
    try {
      want = o.wanted();
    } catch {
      want = false;
    }
    if (want) {
      if (stopTimer !== undefined) {
        clearTimeout(stopTimer);
        stopTimer = undefined;
      }
      if (state === "idle") start();
      return;
    }
    if (state === "running" && stopTimer === undefined) {
      const timer = setTimeout(stop, stopDelay);
      Deno.unrefTimer(timer);
      stopTimer = timer;
    }
  };
  const pollMs = o.pollMs ?? 500;
  const poll = pollMs > 0 ? setInterval(sync, pollMs) : undefined;
  if (poll !== undefined) Deno.unrefTimer(poll);
  return {
    sync,
    dispose: () => {
      if (poll !== undefined) clearInterval(poll);
      if (stopTimer !== undefined) clearTimeout(stopTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      state = "disposed";
      child?.exit();
    },
    state: () => state,
  };
}

/** The slice of a registered window the presence reads. */
export interface DockWindow {
  readonly kind: string;
  readonly overlay?: boolean;
  readonly window: {
    isVisible?(): boolean;
    isMinimized?(): boolean;
    restore?(): void;
    show?(): void;
    focus?(): void;
  };
}

/**
 * Whether a window holds the Dock icon: showing, and neither the tray panel nor an overlay. A
 * minimized window still counts, as it does for a regular app.
 *
 * @param w The window.
 * @returns Whether it counts.
 */
export function holdsDockIcon(w: DockWindow): boolean {
  if (w.kind === "panel" || w.overlay === true) return false;
  try {
    return w.window.isVisible?.() ?? true;
  } catch {
    return false;
  }
}

/**
 * Bring the app's window up for an activation of the helper: the key window when it counts, else
 * the last one that does; un-minimized, then focused (which activates the app without changing its
 * policy).
 *
 * @param key The key window (the registry's).
 * @param windows The open windows, in opening order.
 */
export function focusForDock(key: DockWindow | undefined, windows: readonly DockWindow[]): void {
  const target = key && holdsDockIcon(key) ? key : windows.filter(holdsDockIcon).at(-1);
  if (!target) return;
  try {
    if (target.window.isMinimized?.()) target.window.restore?.();
    target.window.focus?.();
  } catch { /* closing */ }
}

/** What {@linkcode startDockHelper} needs. */
export interface DockHelperStartOptions {
  /** The app's open windows. */
  readonly windows: () => readonly DockWindow[];
  /** The key window. */
  readonly keyWindow: () => DockWindow | undefined;
  /** Quit the app (through the quit guards). */
  readonly quit: () => void;
  /** The app's data folder (`undefined`: none known, no helper). */
  readonly dataDir: string | undefined;
  /** Where warnings go. */
  readonly warn: (message: string) => void;
  /** The app's executable (default `Deno.execPath()`). */
  readonly execPath?: string;
}

/**
 * Start the Dock presence of a packaged macOS app with `desktop.app.dock: "while-window-open"`:
 * find the helper in the app's bundle, and run its copy in the data folder while a window shows.
 * Without a helper (`denext desktop run` / `dev` builds have none) or a data folder: a note, and
 * `undefined` (the accessory behaviour).
 *
 * @param o The windows, the quit, the data folder.
 * @returns The presence, or `undefined`.
 */
export async function startDockHelper(
  o: DockHelperStartOptions,
): Promise<DockPresence | undefined> {
  let execPath: string;
  try {
    execPath = o.execPath ?? Deno.execPath();
  } catch {
    return undefined;
  }
  const bundle = bundleOfExecutable(execPath);
  const source = bundle ? await findDockHelperSource(bundle) : undefined;
  if (!source || !o.dataDir) {
    o.warn(
      'desktop.app.dock "while-window-open": this build has no Dock helper (a packaged app has ' +
        "one), so its windows open without a Dock icon",
    );
    return undefined;
  }
  const dataDir = o.dataDir;
  let exe: string | undefined;
  const presence = createDockPresence({
    wanted: () => o.windows().some(holdsDockIcon),
    launch: async (onMessage) => {
      // Copied once per launch of the app, again if the copy went away since.
      if (exe === undefined || !(await Deno.stat(exe).then((i) => i.isFile, () => false))) {
        exe = await installDockHelper(source, dataDir);
      }
      return spawnDockHelper(exe, onMessage);
    },
    onActivate: () => focusForDock(o.keyWindow(), o.windows()),
    onQuit: o.quit,
    warn: o.warn,
  });
  presence.sync();
  return presence;
}
