/**
 * The sidecars of one desktop app: `runDesktop` creates the host from the merged sidecar list
 * (`desktop.sidecars` + `runDesktop({ sidecars })`), registers its bridge capability (`sidecars`,
 * which `denext/desktop/client`'s `sidecarStatus` / `onSidecarStatus` / `restartSidecar` /
 * `sidecarInfo` call), points `spa.proxy` at the `proxy: true` sidecar, and starts them once the
 * window's server is up.
 *
 * Per launch of the app, before anything starts: an `"auto"` port is picked (a free loopback port,
 * kept across restarts), the secrets are resolved (`"$random"` → 32 random bytes), and the
 * page-visible values (`expose`, `"$secret:<NAME>"` resolved).
 *
 * Orphan safety: a module sidecar is a worker of the app's process and cannot outlive it; a program
 * sidecar is sent `SIGTERM` when the app exits (`unload`) or installs a full-app update, and its
 * stdin (a pipe from the app) reaches end-of-file whenever the app's process ends.
 *
 * Runtime-only (imported by `runDesktop`, never a client bundle).
 *
 * @module
 */

import { dirname, fromFileUrl, join, toFileUrl } from "@std/path";
import { prepareSidecarModules } from "./sidecar-modules.ts";
import { encodeBase64Url } from "@std/encoding/base64url";
import { type DesktopCapability, DesktopCapError } from "./extension.ts";
import {
  SIDECAR_DEFAULTS,
  type SidecarDefinition,
  type SidecarExposedValue,
  sidecarListError,
  sidecarModulePath,
  type SidecarStatus,
} from "./sidecar.ts";
import {
  createSidecarSupervisor,
  type SidecarClock,
  type SidecarHandle,
  type SidecarLauncher,
  type SidecarSupervisor,
} from "./sidecar-supervisor.ts";
import {
  execSidecarLauncher,
  killExecSidecars,
  resolveSidecarProgram,
  workerSidecarLauncher,
} from "./sidecar-launch.ts";
import { registerSidecarStopper } from "./sidecar-registry.ts";

/** The bridge capability name the page side calls. */
const SIDECARS_CAPABILITY = "sidecars";

/** Options for {@linkcode createSidecarHost}. */
export interface SidecarHostOptions {
  /** The sidecars (already merged). */
  readonly sidecars: readonly SidecarDefinition[];
  /** The entry's `import.meta.url`: module and program paths resolve against it. */
  readonly importMetaUrl?: string;
  /** The app's data folder (log files, a program's relative `cwd`). */
  readonly dataDir?: string;
  /** The app's cache folder (a packaged app's program sidecars are copied out there). */
  readonly cacheDir?: string;
  /** Push an event to the page (the bridge's `emit`). */
  readonly emit?: (cap: string, event: string, data: unknown) => void;
  /** Override how a sidecar starts (tests). */
  readonly launcher?: (definition: SidecarDefinition) => SidecarLauncher | Promise<SidecarLauncher>;
  /** Pick a free loopback port (tests). */
  readonly pickPort?: () => number;
  /** The clock (tests). */
  readonly clock?: SidecarClock;
  /** `fetch` for `ready.http` (tests). */
  readonly fetch?: typeof fetch;
  /** The log file size that rotates it to `.1` (default 5 MB; tests pass a small one). */
  readonly logRotateBytes?: number;
}

/** The sidecars of the app, as `runDesktop` drives them. */
export interface SidecarHost {
  /** The `sidecars` bridge capability. */
  readonly capability: DesktopCapability;
  /** The names, in declaration order. */
  readonly names: readonly string[];
  /** The handle of one sidecar; throws for an unknown name. */
  handle(name: string): SidecarHandle;
  /** The `proxy: true` sidecar's name and port, if there is one. */
  readonly proxied?: { readonly name: string; readonly port: number };
  /** Start every sidecar. */
  startAll(): void;
  /** Stop every sidecar (gracefully, in parallel). */
  stopAll(): Promise<void>;
  /** End every sidecar now (synchronously). */
  killAll(): void;
}

/** A free loopback port (bound, read, released). */
function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

/** The secrets of one launch: `"$random"` values replaced, a function called. */
async function resolveSecrets(def: SidecarDefinition): Promise<Record<string, string>> {
  const raw = typeof def.secrets === "function" ? await def.secrets() : def.secrets ?? {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = v === "$random" ? encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))) : v;
  }
  return out;
}

/** The page-visible values: `expose` with `"$secret:<NAME>"` resolved. */
function resolveValues(
  def: SidecarDefinition,
  secrets: Readonly<Record<string, string>>,
): Record<string, SidecarExposedValue> {
  const out: Record<string, SidecarExposedValue> = {};
  for (const [k, v] of Object.entries(def.expose ?? {})) {
    out[k] = typeof v === "string" && v.startsWith("$secret:") ? secrets[v.slice(8)] ?? null : v;
  }
  return out;
}

/** Whether this process is a compiled (packaged) app. */
function isStandalone(): boolean {
  return (Deno.build as { standalone?: boolean }).standalone === true;
}

/** The default launcher of `def`: a worker for a module, a spawned program for `exec`. */
async function defaultLauncher(
  def: SidecarDefinition,
  options: SidecarHostOptions,
): Promise<SidecarLauncher> {
  const base = options.importMetaUrl ?? `${toFileUrl(Deno.cwd()).href}/`;
  if ("module" in def.run) {
    const path = sidecarModulePath(def);
    const entry = /^[a-z][a-z0-9+.-]*:/i.test(path) ? path : new URL(path, base).href;
    if (def.run.nodeModules === undefined) return workerSidecarLauncher({ entry });
    return bundledLauncher(def.name, entry, options.cacheDir);
  }
  const program = await resolveSidecarProgram(
    def.run.exec,
    def.name,
    options.importMetaUrl,
    options.cacheDir,
    isStandalone(),
  );
  const cwd = def.cwd === undefined
    ? undefined
    : /^([A-Za-z]:)?[\\/]/.test(def.cwd) || !options.dataDir
    ? def.cwd
    : join(options.dataDir, def.cwd);
  return execSidecarLauncher({ program, ...(cwd ? { cwd } : {}) });
}

/**
 * A bundled Node backend's launcher: its archived packages are unpacked into the cache folder on
 * its first start (once per version), and its `require()` resolves from there.
 */
function bundledLauncher(
  name: string,
  entry: string,
  cacheDir: string | undefined,
): SidecarLauncher {
  let modules: Promise<string | undefined> | undefined;
  return async (ctx) => {
    modules ??= (async () =>
      await prepareSidecarModules(
        dirname(fromFileUrl(entry)),
        name,
        cacheDir ?? await Deno.makeTempDir({ prefix: "denext-sidecar-cache-" }),
      ))();
    let root: string | undefined;
    try {
      root = await modules;
    } catch (err) {
      modules = undefined; // retried on the next start
      throw err;
    }
    const requireBase = root === undefined ? undefined : join(root, "sidecar.cjs");
    return await workerSidecarLauncher({ entry, ...(requireBase ? { requireBase } : {}) })(ctx);
  };
}

/** The largest log file before it is rotated to `.1`. */
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

/** A sidecar's output sink per its `logs` setting. */
function logSink(
  def: SidecarDefinition,
  dataDir: string | undefined,
  rotateBytes = LOG_ROTATE_BYTES,
): (stream: "stdout" | "stderr", line: string) => void {
  const mode = def.logs ?? SIDECAR_DEFAULTS.logs;
  const toConsole = mode === "inherit" || mode === "both";
  const toFile = (mode === "file" || mode === "both") && dataDir !== undefined;
  const path = toFile ? join(dataDir!, "logs", `sidecar-${def.name}.log`) : "";
  let pending: string[] = [];
  let flushing = false;
  const flush = async () => {
    if (flushing || pending.length === 0) return;
    flushing = true;
    const text = pending.join("");
    pending = [];
    try {
      await Deno.mkdir(join(dataDir!, "logs"), { recursive: true });
      const size = await Deno.stat(path).then((s) => s.size, () => 0);
      if (size + text.length > rotateBytes) {
        await Deno.rename(path, `${path}.1`).catch(() => {});
      }
      await Deno.writeTextFile(path, text, { append: true });
    } catch (err) {
      console.error(`sidecar ${def.name}: cannot write ${path}: ${(err as Error).message}`);
    } finally {
      flushing = false;
      if (pending.length > 0) void flush();
    }
  };
  return (stream, line) => {
    if (toConsole) console.error(`[sidecar:${def.name}]${stream === "stderr" ? "!" : ""} ${line}`);
    if (toFile) {
      pending.push(`${new Date().toISOString()} ${stream} ${line}\n`);
      void flush();
    }
  };
}

/** One sidecar's supervisor: its launcher, secrets and values, logs, and status reporting. */
async function buildSupervisor(
  def: SidecarDefinition,
  port: number | undefined,
  options: SidecarHostOptions,
): Promise<SidecarSupervisor> {
  const secrets = await resolveSecrets(def);
  const launch = await (options.launcher?.(def) ?? defaultLauncher(def, options));
  const supervisor = createSidecarSupervisor({
    definition: def,
    launch,
    ...(port !== undefined ? { port } : {}),
    secrets,
    values: resolveValues(def, secrets),
    onLine: logSink(def, options.dataDir, options.logRotateBytes),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const where = port !== undefined ? ` on 127.0.0.1:${port}` : "";
  supervisor.onStatus((status) => {
    options.emit?.(SIDECARS_CAPABILITY, "status", status);
    if (status.state === "ready") console.error(`desktop: sidecar ${def.name} ready${where}`);
  });
  return supervisor;
}

/** The `{ name }` argument of a page call, checked. */
function nameArg(args: unknown): string {
  const name = (args as { name?: unknown } | null)?.name;
  if (typeof name !== "string" || name === "") {
    throw new DesktopCapError("validation", "name must be a sidecar name");
  }
  return name;
}

/**
 * Create the app's sidecar host: validate the list, pick ports, resolve secrets and values, and
 * build one supervisor per sidecar. Nothing starts until {@linkcode SidecarHost.startAll}.
 *
 * @param options The sidecars and the app's folders.
 * @returns The host.
 */
export async function createSidecarHost(options: SidecarHostOptions): Promise<SidecarHost> {
  const problem = sidecarListError(options.sidecars);
  if (problem) throw new Error(`desktop: sidecars${problem}`);
  const pick = options.pickPort ?? freePort;
  const supervisors = new Map<string, SidecarSupervisor>();
  let proxied: { name: string; port: number } | undefined;
  for (const def of options.sidecars) {
    const port = def.port === "auto" ? pick() : def.port;
    supervisors.set(def.name, await buildSupervisor(def, port, options));
    if (def.proxy === true && port !== undefined) proxied = { name: def.name, port };
  }

  const get = (name: string): SidecarSupervisor => {
    const s = supervisors.get(name);
    if (!s) throw new DesktopCapError("not_found", `no sidecar named "${name}"`, { status: 404 });
    return s;
  };

  const killAll = () => {
    for (const s of supervisors.values()) void s.stop();
    killExecSidecars();
  };
  const stopAll = async () => {
    await Promise.all([...supervisors.values()].map((s) => s.stop()));
  };

  const capability: DesktopCapability = {
    name: SIDECARS_CAPABILITY,
    events: ["status"],
    methods: {
      list: { handler: (): SidecarStatus[] => [...supervisors.values()].map((s) => s.status) },
      status: { handler: (args) => get(nameArg(args)).status },
      info: { handler: (args) => get(nameArg(args)).info },
      restart: {
        timeoutMs: false,
        handler: async (args) => {
          const s = get(nameArg(args));
          await s.restart();
          return s.status;
        },
      },
    },
  };

  return {
    capability,
    names: [...supervisors.keys()],
    handle: (name) => {
      const s = supervisors.get(name);
      if (!s) throw new Error(`desktop: no sidecar named "${name}"`);
      return s;
    },
    ...(proxied ? { proxied } : {}),
    startAll() {
      registerSidecarStopper({ kill: killAll, stop: stopAll });
      for (const s of supervisors.values()) s.start();
    },
    stopAll,
    killAll,
  };
}
