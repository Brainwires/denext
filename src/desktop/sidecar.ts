/**
 * Deno Desktop sidecars, the declaration side: the {@linkcode SidecarDefinition} shape a
 * `desktop.sidecars` entry (`denext.config.ts`) or a `runDesktop({ sidecars })` entry takes, the
 * {@linkcode defineSidecar} helper, its validation, and the defaults the supervisor runs with.
 *
 * A sidecar is a backend the desktop app runs and supervises next to its window, as an Electron app
 * spawns its server. Two kinds:
 *
 * - `run: { module }`: a JavaScript / TypeScript module run INSIDE the app's own Deno runtime, in a
 *   dedicated worker with Node compatibility. No second binary ships and the worker ends with the
 *   app, whatever ends it. A Node backend (`nodeModules`) is bundled at packaging into one file, its
 *   native addons copied beside it (`.deno-desktop/sidecars/<name>/`) and embedded into the app.
 * - `run: { exec }`: a separate program (a Go / Rust server, a CLI), spawned with `Deno.Command`.
 *
 * Runtime-safe (no Deno APIs at import): the config validator, the packaging code and the runtime
 * all read it.
 *
 * @module
 */

/** The Deno permissions a sidecar needs, as `--allow-*` scopes (baked into the packaged app). */
export interface SidecarPermissions {
  /** `--allow-read` paths. */
  readonly read?: readonly string[];
  /** `--allow-write` paths; any entry bakes a broad `--allow-write`. */
  readonly write?: readonly string[];
  /** `--allow-net` hosts (the loopback baseline is always there). */
  readonly net?: readonly string[];
  /** `--allow-run` programs; `["*"]` is unscoped. */
  readonly run?: readonly string[];
  /** `--allow-ffi` libraries; `["*"]` is unscoped (what a Node-API addon needs). */
  readonly ffi?: readonly string[];
  /** `--allow-env` variable names. */
  readonly env?: readonly string[];
  /** `--allow-sys` kinds; `["*"]` is unscoped. */
  readonly sys?: readonly string[];
}

/**
 * What runs: a module in the app's runtime, or a program.
 *
 * `module` is relative to the project (`"./server/main.ts"`). Without `nodeModules` it is part of
 * the app's own module graph (resolved through the app's `deno.json`) and embedded as it is. With
 * `nodeModules` (a Node backend, e.g. `"apps/server/dist/bin.mjs"` and its package's
 * `node_modules`) denext bundles it at packaging, every npm import inlined, except the packages
 * with a native addon (`.node`) and those listed in `external`, which are copied whole beside the
 * bundle and loaded with `require`.
 *
 * `exec` is a program path: absolute, a bare name found on `PATH`, or relative to the project
 * (`"./bin/server"`), which the package scripts copy into the app.
 */
export type SidecarRun =
  | {
    /** The module to run, relative to the project. */
    readonly module: string;
    /** The `node_modules` folder the module's bare imports resolve from (bundled at packaging). */
    readonly nodeModules?: string;
    /** Packages copied whole rather than bundled (they read their own files at run time). */
    readonly external?: readonly string[];
    /**
     * Further entry modules the sidecar starts itself (worker scripts), bundled beside the main one
     * under the same relative paths. Relative to the module's folder.
     */
    readonly entries?: readonly string[];
  }
  | {
    /** The program to spawn. */
    readonly exec: string;
  };

/** What makes a sidecar ready: every check given must pass. Without any it is ready once started. */
export interface SidecarReady {
  /** A path polled on the sidecar's port (`"/health"`) until it answers 2xx. Needs `port`. */
  readonly http?: string;
  /** A regular expression (source) a line of the sidecar's output must match. */
  readonly stdout?: string;
  /**
   * The sidecar says so itself: a module sidecar calls `globalThis.denextSidecar.ready()`.
   */
  readonly signal?: boolean;
  /** A check the app runs (`runDesktop({ sidecars })` only; a function is not config data). */
  readonly probe?: (info: SidecarInfo) => boolean | Promise<boolean>;
  /** How long a start may take before it counts as a failure (default 30 000 ms). */
  readonly timeoutMs?: number;
  /** How often `http` and `probe` are retried (default 100 ms). */
  readonly intervalMs?: number;
}

/** When a sidecar that ended is started again, and how fast. */
export interface SidecarRestart {
  /**
   * `"crash"` (default): after a failure (a non-zero exit, an uncaught error, a failed start);
   * `"always"`: after any end the app did not ask for; `"never"`.
   */
  readonly on?: "crash" | "always" | "never";
  /** The first retry's delay; each further one doubles it (default 500 ms). */
  readonly backoffMs?: number;
  /** The longest delay between retries (default 30 000 ms). */
  readonly maxBackoffMs?: number;
  /** Consecutive failed starts before it is given up as `failed` (default 5). */
  readonly maxAttempts?: number;
  /** A run that stays ready this long resets the attempt count (default 30 000 ms). */
  readonly resetAfterMs?: number;
}

/** How a sidecar is stopped. */
export interface SidecarShutdown {
  /**
   * How long it may take to finish after being asked to stop (default 5 000 ms): a module sidecar
   * gets its `denextSidecar.onShutdown` handlers and `process`'s `SIGTERM` listeners run, a program
   * `SIGTERM`. Past it, the worker is terminated / the program killed.
   */
  readonly graceMs?: number;
}

/**
 * Where a sidecar's output goes: `"inherit"` (default: the app's stderr, each line prefixed
 * `[sidecar:<name>]`), `"file"` (`<app data>/logs/sidecar-<name>.log`, rotated at 5 MB), `"both"`,
 * or `"none"`.
 */
export type SidecarLogs = "inherit" | "file" | "both" | "none";

/**
 * {@linkcode SidecarDefinition.loginShellEnv} with options: `timeoutMs` bounds the login shell
 * (default 3 000 ms), `keys` names variables to take from it besides `PATH`.
 */
export interface SidecarLoginShellEnv {
  /** How long the login shell may take before the inherited environment is used (3 000 ms). */
  readonly timeoutMs?: number;
  /** Variables to take from the login shell besides `PATH` (never `DENO_*` / `DENEXT_*`). */
  readonly keys?: readonly string[];
}

/** A value a sidecar shares with the page ({@linkcode SidecarDefinition.expose}). */
export type SidecarExposedValue = string | number | boolean | null;

/**
 * One sidecar. Data-only fields can live in `desktop.sidecars` (`denext.config.ts`); `probe`,
 * `bootstrap` and `secrets` as functions only in `runDesktop({ sidecars })`, which also overrides a
 * config entry of the same name field by field.
 */
export interface SidecarDefinition {
  /** A unique name: lower-case letters, digits and `-` (`"server"`). */
  readonly name: string;
  /** What runs. */
  readonly run: SidecarRun;
  /**
   * Arguments: the module's `process.argv.slice(2)`, or the program's argv. `{port}` is replaced
   * with the sidecar's port.
   */
  readonly args?: readonly string[];
  /**
   * Environment variables. A module sidecar sees them in `process.env` (its own copy: the app's
   * environment is not changed); a program gets them on top of the app's environment.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Start it with the user's login-shell environment (macOS and Linux; nothing on Windows): an app
   * opened from the Dock or a desktop launcher inherits a minimal `PATH`, so a backend would not
   * find what Homebrew, nvm, asdf or mise installed (`git`, `node`, `codex`). Once per launch of the
   * app, when the first sidecar that sets it starts, the user's `$SHELL` runs as a login and
   * interactive shell and its `PATH` (ahead of the inherited one) and the `keys` asked for are laid
   * under this sidecar's {@linkcode env}. A shell that fails or takes longer than `timeoutMs`
   * (default 3 000 ms) logs a warning and the sidecar starts with the inherited environment. The
   * variables reach only the sidecars that set this, never the page or the app's own environment.
   * A module sidecar sees them in `process.env` (and so `node:child_process`); a program in its
   * environment, and a bare `run.exec` name is looked up on that `PATH`.
   */
  readonly loginShellEnv?: boolean | SidecarLoginShellEnv;
  /** A program's working directory (relative to the app's data folder, or absolute). */
  readonly cwd?: string;
  /**
   * A loopback port for the sidecar: `"auto"` picks a free one at launch (kept across restarts), a
   * number is fixed. Published as `PORT` (see {@linkcode portEnv}), `{port}` in {@linkcode args},
   * `denextSidecar.port`, and to the page through `sidecarInfo`.
   */
  readonly port?: "auto" | number;
  /** The environment variable the port is published under (default `PORT`). */
  readonly portEnv?: string;
  /**
   * Values the sidecar needs and nothing else may see: never in its environment or argv. A module
   * sidecar reads them from `denextSidecar.secrets`; a program from the first line of its stdin
   * (`{"name","port","bootstrap","secrets"}`). A value `"$random"` is replaced with 32 random bytes
   * (base64url), new on every launch of the app; a function (code only) computes them.
   */
  readonly secrets?:
    | Readonly<Record<string, string>>
    | (() => Record<string, string> | Promise<Record<string, string>>);
  /**
   * A JSON value handed to the sidecar at every start (`denextSidecar.bootstrap`, or the program's
   * first stdin line): what an Electron app passes on an extra file descriptor. A function (code
   * only) computes it per start.
   */
  readonly bootstrap?: unknown | ((info: SidecarInfo) => unknown | Promise<unknown>);
  /** When it counts as ready. */
  readonly ready?: SidecarReady;
  /** The restart policy. */
  readonly restart?: SidecarRestart;
  /** How it is stopped. */
  readonly shutdown?: SidecarShutdown;
  /** Where its output goes. */
  readonly logs?: SidecarLogs;
  /**
   * Make `spa.proxy` forward to this sidecar's port (one sidecar at most): the page keeps calling
   * its proxied prefixes, and requests wait while the sidecar starts or restarts.
   */
  readonly proxy?: boolean;
  /**
   * Values the page may read with `sidecarInfo(name)` (token-gated, like every bridge call). A
   * value `"$secret:<NAME>"` exposes that secret, e.g. a per-launch token the page presents to the
   * sidecar.
   */
  readonly expose?: Readonly<Record<string, SidecarExposedValue>>;
  /**
   * What the sidecar needs beyond the app's baseline permissions, baked into the packaged app. A
   * module sidecar runs with the app's permissions (one process); this widens them.
   */
  readonly permissions?: SidecarPermissions;
}

/** A sidecar's lifecycle state. */
export type SidecarState =
  | "idle"
  | "starting"
  | "ready"
  | "backoff"
  | "stopping"
  | "stopped"
  | "failed";

/** How one run of a sidecar ended. */
export interface SidecarExit {
  /** The exit code (`process.exit(n)`, a program's status). */
  readonly code?: number;
  /** The signal that ended a program. */
  readonly signal?: string;
  /** An uncaught error, or why the start failed. */
  readonly error?: string;
}

/** A sidecar's status: what `sidecar(name).status`, `sidecarStatus` and `onSidecarStatus` report. */
export interface SidecarStatus {
  /** The sidecar's name. */
  readonly name: string;
  /** The lifecycle state. */
  readonly state: SidecarState;
  /** The loopback port, when it has one. */
  readonly port?: number;
  /** A program's process id. */
  readonly pid?: number;
  /** Failed starts since the last good run (reset by {@linkcode SidecarRestart.resetAfterMs}). */
  readonly attempts: number;
  /** Starts after the first one, for any reason. */
  readonly restarts: number;
  /** When it entered this state (epoch ms). */
  readonly since: number;
  /** How the previous run ended. */
  readonly lastExit?: SidecarExit;
  /** When the next start is due, while in `backoff` (epoch ms). */
  readonly retryAt?: number;
}

/** What the page (and a `ready.probe`) learns about a sidecar: `sidecarInfo(name)`. */
export interface SidecarInfo {
  /** The sidecar's name. */
  readonly name: string;
  /** The lifecycle state. */
  readonly state: SidecarState;
  /** The loopback port, when it has one. */
  readonly port?: number;
  /** `http://127.0.0.1:<port>`, when it has a port. */
  readonly url?: string;
  /** The {@linkcode SidecarDefinition.expose} values, secrets resolved. */
  readonly values: Readonly<Record<string, SidecarExposedValue>>;
}

/**
 * Declare a sidecar with its type checked (an identity function, for `runDesktop({ sidecars })`).
 *
 * @param definition The sidecar.
 * @returns The same definition.
 * @example
 * ```ts
 * import { defineSidecar, runDesktop } from "denext/desktop";
 *
 * const api = defineSidecar({
 *   name: "api",
 *   run: { module: "./server/main.ts" },
 *   port: "auto",
 *   ready: { http: "/health" },
 *   proxy: true,
 * });
 * const app = await runDesktop({ importMetaUrl: import.meta.url, sidecars: [api] });
 * app.sidecar("api").onStatus((s) => console.log(s.state));
 * ```
 */
export function defineSidecar<const D extends SidecarDefinition>(definition: D): D {
  return definition;
}

/** A sidecar name: lower-case letters, digits and `-`, starting with a letter, at most 64. */
const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
/** An environment variable name. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The keys {@linkcode SidecarDefinition} takes (anything else is a typo). */
const DEFINITION_KEYS = new Set([
  "name",
  "run",
  "args",
  "env",
  "loginShellEnv",
  "cwd",
  "port",
  "portEnv",
  "secrets",
  "bootstrap",
  "ready",
  "restart",
  "shutdown",
  "logs",
  "proxy",
  "expose",
  "permissions",
]);

/** The permission kinds {@linkcode SidecarPermissions} takes. */
const PERMISSION_KINDS = ["read", "write", "net", "run", "ffi", "env", "sys"];

/** `value` is a plain object (not an array, not null). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` is an array of strings. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** A non-negative integer of milliseconds. */
function isMs(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** A check: the problem with one value, or `null`. */
type Check = () => string | null;

/** The first problem of `checks`, or `null`. */
function first(checks: readonly Check[]): string | null {
  for (const check of checks) {
    const problem = check();
    if (problem) return problem;
  }
  return null;
}

/** The first key of `obj` not in `allowed`, as `<prefix>.<key> is not an option`, or `null`. */
function unknownOption(obj: Record<string, unknown>, prefix: string, allowed: readonly string[]) {
  const key = Object.keys(obj).find((k) => !allowed.includes(k));
  return key === undefined ? null : `${prefix}.${key} is not an option (${allowed.join(", ")})`;
}

/** `obj[key]`, when set, must be milliseconds. */
function msField(obj: Record<string, unknown>, prefix: string, key: string): Check {
  return () =>
    obj[key] !== undefined && !isMs(obj[key]) ? `${prefix}.${key} must be milliseconds` : null;
}

/** The problem with an exec sidecar's `run`, or `null`. */
function execRunError(run: Record<string, unknown>): string | null {
  if (typeof run.exec !== "string" || run.exec === "") return "run.exec must be a program path";
  const extra = Object.keys(run).find((k) => k !== "exec");
  return extra ? `run.${extra} is not an option of an exec sidecar` : null;
}

/** The problem with a module sidecar's `run`, or `null`. */
function moduleRunError(run: Record<string, unknown>): string | null {
  const bundled = run.nodeModules !== undefined;
  return first([
    () => typeof run.module === "string" && run.module !== "" ? null : "run.module must be a path",
    () => unknownOption(run, "run", ["module", "nodeModules", "external", "entries"]),
    () =>
      !bundled || (typeof run.nodeModules === "string" && run.nodeModules !== "")
        ? null
        : "run.nodeModules must be a folder path",
    () =>
      run.external === undefined || isStringArray(run.external)
        ? null
        : "run.external must be a string array",
    () =>
      run.entries === undefined || isStringArray(run.entries)
        ? null
        : "run.entries must be a string array",
    () =>
      bundled || (run.external === undefined && run.entries === undefined)
        ? null
        : "run.external and run.entries need run.nodeModules (they shape the bundle)",
  ]);
}

/** The problem with `run`, or `null`. */
function runError(run: unknown): string | null {
  if (!isObject(run)) return "run must be { module } or { exec }";
  if (("module" in run) === ("exec" in run)) return "run must have exactly one of module and exec";
  return "exec" in run ? execRunError(run) : moduleRunError(run);
}

/** The problem with `ready.stdout`, or `null`. */
function stdoutPatternError(pattern: unknown): string | null {
  if (pattern === undefined) return null;
  if (typeof pattern !== "string") return "ready.stdout must be a regular expression source";
  try {
    new RegExp(pattern);
    return null;
  } catch (err) {
    return `ready.stdout is not a valid regular expression: ${(err as Error).message}`;
  }
}

/** The problem with `ready.http`, or `null`. */
function httpCheckError(path: unknown, hasPort: boolean): string | null {
  if (path === undefined) return null;
  if (typeof path !== "string" || !path.startsWith("/")) {
    return 'ready.http must be a path starting with "/"';
  }
  return hasPort ? null : "ready.http needs a port";
}

/** The problem with `ready`, or `null`. */
function readyError(ready: unknown, hasPort: boolean): string | null {
  if (ready === undefined) return null;
  if (!isObject(ready)) return "ready must be an object";
  return first([
    () =>
      unknownOption(ready, "ready", [
        "http",
        "stdout",
        "signal",
        "probe",
        "timeoutMs",
        "intervalMs",
      ]),
    () => httpCheckError(ready.http, hasPort),
    () => stdoutPatternError(ready.stdout),
    () =>
      ready.signal === undefined || typeof ready.signal === "boolean"
        ? null
        : "ready.signal must be a boolean",
    () =>
      ready.probe === undefined || typeof ready.probe === "function"
        ? null
        : "ready.probe must be a function",
    msField(ready, "ready", "timeoutMs"),
    msField(ready, "ready", "intervalMs"),
  ]);
}

/** The problem with `restart`, or `null`. */
function restartError(restart: unknown): string | null {
  if (restart === undefined) return null;
  if (!isObject(restart)) return "restart must be an object";
  const max = restart.maxAttempts;
  return first([
    () =>
      unknownOption(restart, "restart", [
        "on",
        "backoffMs",
        "maxBackoffMs",
        "maxAttempts",
        "resetAfterMs",
      ]),
    () =>
      restart.on === undefined || ["crash", "always", "never"].includes(restart.on as string)
        ? null
        : 'restart.on must be "crash", "always" or "never"',
    msField(restart, "restart", "backoffMs"),
    msField(restart, "restart", "maxBackoffMs"),
    msField(restart, "restart", "resetAfterMs"),
    () =>
      max === undefined || (typeof max === "number" && Number.isInteger(max) && max >= 1)
        ? null
        : "restart.maxAttempts must be a whole number of at least 1",
  ]);
}

/** The problem with `shutdown`, or `null`. */
function shutdownError(shutdown: unknown): string | null {
  if (shutdown === undefined) return null;
  if (!isObject(shutdown)) return "shutdown must be an object";
  return unknownOption(shutdown, "shutdown", ["graceMs"]) ??
    msField(shutdown, "shutdown", "graceMs")();
}

/** The problem with `env`, or `null`. */
function envError(env: unknown): string | null {
  if (env === undefined) return null;
  if (!isObject(env)) return "env must be an object of strings";
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_NAME_RE.test(k)) return `env.${k} is not a variable name`;
    if (typeof v !== "string") return `env.${k} must be a string`;
  }
  return null;
}

/** The problem with `loginShellEnv`, or `null`. */
function loginShellEnvError(value: unknown): string | null {
  if (value === undefined || typeof value === "boolean") return null;
  if (!isObject(value)) return "loginShellEnv must be a boolean or { timeoutMs, keys }";
  return first([
    () => unknownOption(value, "loginShellEnv", ["timeoutMs", "keys"]),
    () =>
      value.timeoutMs === undefined ||
        (isMs(value.timeoutMs) && (value.timeoutMs as number) > 0 &&
          (value.timeoutMs as number) <= 60_000)
        ? null
        : "loginShellEnv.timeoutMs must be milliseconds between 1 and 60 000",
    () => {
      if (value.keys === undefined) return null;
      if (!isStringArray(value.keys)) return "loginShellEnv.keys must be a string array";
      const bad = value.keys.find((k) => !ENV_NAME_RE.test(k));
      if (bad !== undefined) return `loginShellEnv.keys: "${bad}" is not a variable name`;
      const reserved = value.keys.find((k) => /^(DENO|DENEXT)_/i.test(k));
      return reserved === undefined
        ? null
        : `loginShellEnv.keys: "${reserved}" is reserved (DENO_* / DENEXT_* are never taken)`;
    },
  ]);
}

/** The problem with `secrets`, or `null`. */
function secretsError(secrets: unknown): string | null {
  if (secrets === undefined || typeof secrets === "function") return null;
  if (!isObject(secrets)) return "secrets must be an object of strings (or a function)";
  const bad = Object.entries(secrets).find(([, v]) => typeof v !== "string");
  return bad ? `secrets.${bad[0]} must be a string` : null;
}

/** The problem with one `expose` value, or `null`. */
function exposedValueError(key: string, value: unknown, secrets: unknown): string | null {
  if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
    return `expose.${key} must be a string, number, boolean or null`;
  }
  if (typeof value !== "string" || !value.startsWith("$secret:") || typeof secrets === "function") {
    return null;
  }
  const name = value.slice(8);
  const names = isObject(secrets) ? Object.keys(secrets) : [];
  return names.includes(name) ? null : `expose.${key} names a secret "${name}" not in secrets`;
}

/** The problem with `expose`, or `null`. */
function exposeError(expose: unknown, secrets: unknown): string | null {
  if (expose === undefined) return null;
  if (!isObject(expose)) return "expose must be an object";
  for (const [k, v] of Object.entries(expose)) {
    const problem = exposedValueError(k, v, secrets);
    if (problem) return problem;
  }
  return null;
}

/** The problem with `permissions`, or `null`. */
function permissionsError(permissions: unknown): string | null {
  if (permissions === undefined) return null;
  if (!isObject(permissions)) return "permissions must be an object of permission lists";
  for (const [k, v] of Object.entries(permissions)) {
    if (!PERMISSION_KINDS.includes(k)) return `permissions.${k} is not a permission kind`;
    if (!isStringArray(v)) return `permissions.${k} must be a string array`;
  }
  return null;
}

/** The problem with `port`, or `null`. */
function portError(port: unknown): string | null {
  if (port === undefined || port === "auto") return null;
  const ok = typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
  return ok ? null : 'port must be "auto" or a port number';
}

/** The problem with `cwd`, or `null`. */
function cwdError(cwd: unknown, run: unknown): string | null {
  if (cwd === undefined) return null;
  if (typeof cwd !== "string" || cwd === "") return "cwd must be a folder path";
  return isObject(run) && "module" in run
    ? "cwd applies to an exec sidecar (a module sidecar shares the app's working directory)"
    : null;
}

/** The problem with the scalar fields (`args`, `cwd`, `port`, `portEnv`, `logs`, `proxy`). */
function scalarsError(d: Record<string, unknown>): string | null {
  return first([
    () => d.args === undefined || isStringArray(d.args) ? null : "args must be a string array",
    () => cwdError(d.cwd, d.run),
    () => portError(d.port),
    () =>
      d.portEnv === undefined || (typeof d.portEnv === "string" && ENV_NAME_RE.test(d.portEnv))
        ? null
        : "portEnv must be an environment variable name",
    () =>
      d.logs === undefined || ["inherit", "file", "both", "none"].includes(d.logs as string)
        ? null
        : 'logs must be "inherit", "file", "both" or "none"',
    () => d.proxy === undefined || typeof d.proxy === "boolean" ? null : "proxy must be a boolean",
    () => d.proxy === true && d.port === undefined ? "proxy needs a port" : null,
  ]);
}

/**
 * The problem with one sidecar definition, or `null` when it is valid. The message names the field
 * (`ready.http needs a port`); the caller prefixes where it sits.
 *
 * @param definition The definition.
 * @returns The problem, or `null`.
 */
export function sidecarDefinitionError(definition: unknown): string | null {
  if (!isObject(definition)) return "must be an object";
  const d = definition;
  if (typeof d.name !== "string" || !NAME_RE.test(d.name)) {
    return "name must be lower-case letters, digits and - (starting with a letter)";
  }
  const unknownKey = Object.keys(d).find((k) => !DEFINITION_KEYS.has(k));
  if (unknownKey) return `${unknownKey} is not a sidecar option`;
  return first([
    () => runError(d.run),
    () => scalarsError(d),
    () => readyError(d.ready, d.port !== undefined),
    () => restartError(d.restart),
    () => shutdownError(d.shutdown),
    () => envError(d.env),
    () => loginShellEnvError(d.loginShellEnv),
    () => secretsError(d.secrets),
    () => exposeError(d.expose, d.secrets),
    () => permissionsError(d.permissions),
  ]);
}

/**
 * The problem with a list of sidecars (each one, then the names unique and one `proxy` at most),
 * or `null`. Each message starts with the entry's index or name.
 *
 * @param sidecars The list.
 * @returns The problem, or `null`.
 */
export function sidecarListError(sidecars: unknown): string | null {
  if (!Array.isArray(sidecars)) return " must be an array of sidecars";
  const names = new Set<string>();
  let proxied: string | undefined;
  for (const [i, entry] of sidecars.entries()) {
    const err = sidecarDefinitionError(entry);
    if (err) return `[${i}] ${err}`;
    const { name, proxy } = entry as SidecarDefinition;
    if (names.has(name)) return `[${i}] name "${name}" is used twice`;
    names.add(name);
    if (proxy === true) {
      if (proxied) return `[${i}] only one sidecar may set proxy (already "${proxied}")`;
      proxied = name;
    }
  }
  return null;
}

/**
 * The config's sidecars with the code's laid over them: an entry of `code` replaces the fields it
 * sets on the config entry of the same name (`ready`, `restart`, … as whole objects), and adds a
 * sidecar the config does not have.
 *
 * @param config `desktop.sidecars` (config data).
 * @param code `runDesktop({ sidecars })`.
 * @returns The merged list, config order first.
 */
export function mergeSidecars(
  config: readonly SidecarDefinition[] = [],
  code: readonly SidecarDefinition[] = [],
): SidecarDefinition[] {
  const out = config.map((d) => ({ ...d }));
  for (const d of code) {
    const at = out.findIndex((c) => c.name === d.name);
    if (at < 0) out.push({ ...d });
    else out[at] = { ...out[at], ...d };
  }
  return out;
}

/** The defaults the supervisor runs a sidecar with. */
export const SIDECAR_DEFAULTS = {
  readyTimeoutMs: 30_000,
  readyIntervalMs: 100,
  restartOn: "crash",
  backoffMs: 500,
  maxBackoffMs: 30_000,
  maxAttempts: 5,
  resetAfterMs: 30_000,
  graceMs: 5_000,
  logs: "inherit",
  portEnv: "PORT",
} as const;

/** Where a bundled module sidecar lives in the project (and the app), relative to the project. */
export const SIDECAR_BUNDLE_DIR = ".deno-desktop/sidecars";
/** The bundled main module's file name inside {@linkcode SIDECAR_BUNDLE_DIR}`/<name>/`. */
export const SIDECAR_BUNDLE_MAIN = "main.mjs";

/**
 * The project-relative path the app loads a module sidecar from: the bundle
 * (`.deno-desktop/sidecars/<name>/main.mjs`) for a Node backend, else the module itself.
 *
 * @param definition A module sidecar.
 * @returns The path, `./`-prefixed.
 */
export function sidecarModulePath(definition: SidecarDefinition): string {
  const run = definition.run as { module: string; nodeModules?: string };
  if (run.nodeModules !== undefined) {
    return `./${SIDECAR_BUNDLE_DIR}/${definition.name}/${SIDECAR_BUNDLE_MAIN}`;
  }
  return run.module.startsWith("./") || run.module.startsWith("../") ||
      /^[a-z][a-z0-9+.-]*:/i.test(run.module)
    ? run.module
    : `./${run.module}`;
}
