// Edge Functions: `backend({ functions })` serves `functions/<name>.ts` (or
// `functions/<name>/index.ts`) at `/functions/v1/<name>` — the path and request shape
// supabase-js's `functions.invoke(name, { body, headers, method })` uses, so a Supabase function
// runs unchanged: a module that calls `Deno.serve(handler)`, or one that default-exports a
// handler.
//
// Isolation: each function runs in a Deno Worker of its own (`functions-worker.ts`), started on
// its first request and kept warm — its own globals, its own module graph (a function cannot
// reach the app's in-memory state, nor another function's), and with `permissions` (behind
// Deno's `--unstable-worker-options`) its own sandbox. A worker that throws outside a request
// is replaced on the next one; under `denext dev` an edit in the functions directory restarts
// the workers.
//
// Like Supabase, a function requires a valid caller by default (`verifyJwt`): a request with no
// identity gets 401 before the function runs. `verifyJwt: false` (for the whole directory or one
// function) lets anyone call it — a webhook receiver, say. A CORS preflight (`OPTIONS`) is always
// passed through unchecked, as Supabase does: the function answers it (see the docs' corsHeaders
// recipe). A cookie-authenticated write follows denext's Server Actions rule (`csrf()`), so a
// cross-site page cannot invoke a function with a visitor's cookies.

import { join, resolve, toFileUrl } from "@std/path";
import {
  clientIp,
  csrf,
  nativeBearerToken,
  type PluginContext,
  readCappedBody,
  STALLED,
  TOO_LARGE,
} from "@denext/denext/server";
import type { HostMessage, WorkerMessage } from "./functions-protocol.ts";
import { positiveOption } from "./options.ts";
import { isIdentityError, resolveIdentity } from "./identity.ts";

/** One function's settings, `backend({ functions: { functions: { <name>: … } } })`. */
export interface FunctionConfig {
  /**
   * Require a valid caller (a signed-in session, or — once the Supabase-compatible keys are
   * configured — a valid access token or API key) before the function runs. Default: the
   * directory's `verifyJwt` (itself `true`).
   */
  verifyJwt?: boolean;
  /** The longest one request may run, in milliseconds (default: the directory's). */
  timeoutMs?: number;
  /** Environment variables this function reads from `Deno.env`, over the process's own. */
  env?: Record<string, string>;
  /**
   * The worker's permissions (`Deno.PermissionOptions`, e.g. `{ net: true, env: true, read:
   * false }`); by default the worker has the server's. Needs Deno's worker options: list
   * `"worker-options"` in `deno.json`'s `unstable` (the plugin refuses to start otherwise —
   * without it Deno would exit the process on the first request).
   */
  permissions?: "inherit" | "none" | Record<string, unknown>;
}

/** `backend({ functions })`: Edge Functions. */
export interface FunctionsOptions {
  /**
   * The directory holding the functions, relative to the project (default `"functions"`, or
   * `"supabase/functions"` when only that exists). A function is `<dir>/<name>.ts` or
   * `<dir>/<name>/index.ts`; entries starting with `_` or `.` (`_shared/`) are not functions.
   */
  dir?: string;
  /** Where the functions are served, app-relative (default `"/functions/v1"`). */
  basePath?: string;
  /** Require a valid caller for every function unless it says otherwise (default `true`). */
  verifyJwt?: boolean;
  /** The longest one request may run, in milliseconds (default 150 000, Supabase's free tier). */
  timeoutMs?: number;
  /** The largest request body passed to a function, in bytes (default 20 MiB). */
  maxBodyBytes?: number;
  /** Environment variables every function reads from `Deno.env`, over the process's own. */
  env?: Record<string, string>;
  /**
   * The app's public URL, which functions read as `SUPABASE_URL` (default: the origin of the
   * request that starts the worker, plus the app's `basePath`).
   */
  url?: string;
  /** Per-function settings, by name. */
  functions?: Record<string, FunctionConfig>;
}

/** Validated `functions` options. */
export interface ResolvedFunctions {
  /** The directory as configured (relative), or `undefined` for the default. */
  dir: string | undefined;
  /** The route prefix (leading `/`, no trailing one). */
  basePath: string;
  /** The default for `verifyJwt`. */
  verifyJwt: boolean;
  /** The default timeout (ms). */
  timeoutMs: number;
  /** The body cap. */
  maxBodyBytes: number;
  /** The shared env overlay. */
  env: Record<string, string>;
  /** The public URL, when configured. */
  url: string | undefined;
  /** Per-function settings. */
  functions: Record<string, FunctionConfig>;
}

/** A function name: what Supabase allows in a slug. */
const FUNCTION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function checkEnv(env: unknown, where: string): Record<string, string> {
  if (env === undefined) return {};
  if (
    typeof env !== "object" || env === null ||
    Object.values(env).some((v) => typeof v !== "string")
  ) {
    throw new TypeError(`backend(): ${where} must map names to strings`);
  }
  return { ...env as Record<string, string> };
}

/**
 * Validate `backend({ functions })` and apply the defaults.
 *
 * @param o The options.
 * @returns The resolved options.
 * @throws {TypeError} For a bad path, limit, name or env map.
 */
export function resolveFunctions(o: FunctionsOptions): ResolvedFunctions {
  const basePath = (o.basePath ?? "/functions/v1").replace(/\/+$/, "");
  if (!/^\/[A-Za-z0-9._~\-/]*$/.test(basePath) || basePath === "") {
    throw new TypeError(
      `backend(): functions.basePath must be an absolute path such as "/functions/v1"`,
    );
  }
  if (o.dir !== undefined && (typeof o.dir !== "string" || o.dir === "")) {
    throw new TypeError("backend(): functions.dir must be a directory path");
  }
  const functions: Record<string, FunctionConfig> = {};
  for (const [name, config] of Object.entries(o.functions ?? {})) {
    if (!FUNCTION_NAME.test(name)) {
      throw new TypeError(`backend(): functions.functions: ${JSON.stringify(name)} is not a name`);
    }
    functions[name] = {
      ...config,
      env: checkEnv(config.env, `functions.functions.${name}.env`),
      ...(config.timeoutMs === undefined ? {} : {
        timeoutMs: positiveOption(
          config.timeoutMs,
          1,
          `backend(): functions.functions.${name}.timeoutMs`,
        ),
      }),
    };
  }
  return {
    dir: o.dir,
    basePath,
    verifyJwt: o.verifyJwt ?? true,
    timeoutMs: positiveOption(o.timeoutMs, 150_000, "backend(): functions.timeoutMs"),
    maxBodyBytes: positiveOption(
      o.maxBodyBytes,
      20 * 1024 * 1024,
      "backend(): functions.maxBodyBytes",
    ),
    env: checkEnv(o.env, "functions.env"),
    url: o.url?.replace(/\/+$/, ""),
    functions,
  };
}

// ── Discovery ────────────────────────────────────────────────────────────────

const ENTRY_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

/**
 * The functions directory: the configured one, else `functions/`, else `supabase/functions/`
 * when only that exists (a project moved from the Supabase CLI layout).
 *
 * @param projectRoot The project.
 * @param dir The configured directory.
 * @returns The absolute directory (it may not exist).
 */
export async function functionsDir(projectRoot: string, dir: string | undefined): Promise<string> {
  if (dir !== undefined) return resolve(projectRoot, dir);
  const plain = join(projectRoot, "functions");
  if (await isDirectory(plain)) return plain;
  const supabase = join(projectRoot, "supabase", "functions");
  return (await isDirectory(supabase)) ? supabase : plain;
}

/**
 * The functions in `dir`: `<name>.ts` (or `.tsx`, `.js`, `.jsx`, `.mjs`) and `<name>/index.ts`
 * (same extensions), by name. Names starting with `_` or `.` and names that are not slugs are
 * skipped. A missing directory has none.
 *
 * @param dir The directory.
 * @returns Each function's entry module path, sorted by name.
 */
export async function discoverFunctions(dir: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) entries.push(entry);
  } catch {
    return found;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    const named = entry.isDirectory
      ? await directoryFunction(dir, entry.name)
      : fileFunction(dir, entry.name);
    if (named && !found.has(named[0])) found.set(named[0], named[1]);
  }
  return found;
}

/** `<dir>/<name>/index.<ext>` as `[name, path]`, or `null`. */
async function directoryFunction(dir: string, name: string): Promise<[string, string] | null> {
  if (!FUNCTION_NAME.test(name)) return null;
  for (const ext of ENTRY_EXTENSIONS) {
    const path = join(dir, name, `index${ext}`);
    if (await isFile(path)) return [name, path];
  }
  return null;
}

/** `<dir>/<name>.<ext>` as `[name, path]`, or `null` (not a module, a test or a `.d.ts`). */
function fileFunction(dir: string, file: string): [string, string] | null {
  const ext = ENTRY_EXTENSIONS.find((e) => file.endsWith(e));
  if (!ext || file.endsWith(".d.ts") || /\.(test|spec)\./.test(file)) return null;
  const name = file.slice(0, -ext.length);
  return FUNCTION_NAME.test(name) ? [name, join(dir, file)] : null;
}

// ── The worker host ──────────────────────────────────────────────────────────

/** How a function host starts a worker (injectable for tests). */
export type WorkerFactory = (url: URL, options: WorkerOptions) => Worker;

/** The worker's bootstrap module. */
const WORKER_URL = new URL("./functions-worker.ts", import.meta.url);

/** What a caller is told when the function threw or its worker died. */
const WORKER_ERROR_MESSAGE = "Function exited due to an error (please check logs)";

/** A JSON error response, in the shape Supabase's relay answers with. */
function relayError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

interface Pending {
  resolve(response: Response): void;
  stream?: ReadableStreamDefaultController<Uint8Array>;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
  /** Fail this request (no response yet) or end its stream with an error. */
  fail(status: number, code: string, message: string): void;
}

/** What one request carries into the worker. */
export interface FunctionCall {
  url: string;
  method: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
  remote?: string;
  signal?: AbortSignal;
}

/**
 * One function's worker: started on the first call, kept warm, replaced after it dies. Calls
 * are multiplexed over the one worker by id.
 */
export class FunctionHost {
  readonly name: string;
  readonly #module: string;
  readonly #permissions: FunctionConfig["permissions"];
  readonly #spawn: WorkerFactory;
  #worker: Worker | undefined;
  #ready: Promise<void> | undefined;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();

  /**
   * A host for one function.
   *
   * @param name The function's name.
   * @param modulePath Its entry module (absolute path).
   * @param permissions The worker's permissions (`undefined`: inherit).
   * @param spawn Starts a worker.
   */
  constructor(
    name: string,
    modulePath: string,
    permissions: FunctionConfig["permissions"],
    spawn: WorkerFactory = (url, options) => new Worker(url, options),
  ) {
    this.name = name;
    this.#module = toFileUrl(modulePath).href;
    this.#permissions = permissions;
    this.#spawn = spawn;
  }

  /** Whether a worker is running (or starting). */
  get running(): boolean {
    return this.#worker !== undefined;
  }

  #start(env: Record<string, string>): Promise<void> {
    const options: WorkerOptions & { deno?: { permissions?: unknown } } = {
      type: "module",
      name: `function:${this.name}`,
    };
    if (this.#permissions !== undefined) options.deno = { permissions: this.#permissions };
    const worker = this.#spawn(WORKER_URL, options);
    this.#worker = worker;
    const ready = new Promise<void>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        const message = event.data;
        if (message.t === "ready") resolve();
        else if (message.t === "fail") {
          reject(new Error(message.message));
          this.#die(worker);
        } else this.#onMessage(message);
      };
      worker.onerror = (event: ErrorEvent) => {
        event.preventDefault();
        console.error(`[@denext/backend] function ${this.name}: ${event.message}`);
        reject(new Error(event.message));
        this.#die(worker);
      };
      worker.onmessageerror = () => {
        reject(new Error("unreadable message from the worker"));
        this.#die(worker);
      };
    });
    ready.catch(() => {});
    worker.postMessage({ t: "init", module: this.#module, env } satisfies HostMessage);
    return ready;
  }

  /** The worker is gone: fail what it was serving; the next call starts a new one. */
  #die(worker: Worker): void {
    if (this.#worker !== worker) return;
    this.#worker = undefined;
    this.#ready = undefined;
    worker.terminate();
    for (const pending of this.#pending.values()) {
      pending.fail(500, "WORKER_ERROR", WORKER_ERROR_MESSAGE);
    }
    this.#pending.clear();
  }

  #onMessage(message: WorkerMessage): void {
    if (!("id" in message)) return;
    const pending = this.#pending.get(message.id);
    if (pending) this.#handlers[message.t]?.(pending, message as never);
  }

  /** What each per-request message does to its request. */
  readonly #handlers: {
    [T in Exclude<WorkerMessage["t"], "ready" | "fail">]: (
      pending: Pending,
      message: Extract<WorkerMessage, { t: T }>,
    ) => void;
  } = {
    head: (pending, message) => {
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          pending.stream = controller;
        },
        cancel: () => this.#abort(message.id),
      });
      pending.settled = true;
      pending.resolve(
        new Response(nullBodyStatus(message.status) ? null : body, {
          status: message.status,
          statusText: message.statusText,
          headers: message.headers,
        }),
      );
    },
    chunk: (pending, message) => quietly(() => pending.stream?.enqueue(message.data)),
    end: (pending, message) => {
      this.#finish(message.id);
      quietly(() => pending.stream?.close());
    },
    error: (pending, message) => {
      console.error(`[@denext/backend] function ${this.name}: ${message.message}`);
      pending.fail(500, "WORKER_ERROR", WORKER_ERROR_MESSAGE);
      this.#finish(message.id);
    },
  };

  #finish(id: number): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    this.#stopIfRetired();
  }

  #retiring = false;
  /** Calls waiting for the worker to start (not yet in `#pending`). */
  #booting = 0;

  #stopIfRetired(): void {
    if (this.#retiring && this.#pending.size === 0 && this.#booting === 0) this.stop();
  }

  /**
   * Stop the worker once the requests it is serving finish (an edit under `denext dev`: the next
   * request goes to a new host, and nothing in flight is cut off).
   */
  retire(): void {
    this.#retiring = true;
    this.#stopIfRetired();
  }

  #abort(id: number): void {
    if (!this.#pending.has(id)) return;
    this.#finish(id);
    this.#worker?.postMessage({ t: "abort", id } satisfies HostMessage);
  }

  /**
   * Run one request on the function.
   *
   * @param call The request, its body buffered.
   * @param env The env overlay a new worker starts with.
   * @param timeoutMs The wall-clock limit.
   * @returns The function's response (its body streams), or a relay error.
   */
  async call(
    call: FunctionCall,
    env: Record<string, string>,
    timeoutMs: number,
  ): Promise<Response> {
    if (!this.#ready) this.#ready = this.#start(env);
    this.#booting++;
    try {
      await this.#ready;
    } catch (error) {
      console.error(`[@denext/backend] function ${this.name} failed to start:`, error);
      return relayError(503, "BOOT_ERROR", "Function failed to start (please check logs)");
    } finally {
      this.#booting--;
    }
    if (call.signal?.aborted) {
      this.#stopIfRetired();
      return relayError(499, "CLIENT_CLOSED", "the client closed the request");
    }
    const worker = this.#worker!;
    const id = this.#nextId++;
    return await new Promise<Response>((resolve) => {
      const pending: Pending = {
        resolve,
        settled: false,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
        fail: (status, code, message) => {
          if (!pending.settled) {
            pending.settled = true;
            resolve(relayError(status, code, message));
          } else {
            try {
              pending.stream?.error(new Error(message));
            } catch {
              // Already closed.
            }
          }
        },
      };
      pending.timer = setTimeout(() => {
        pending.fail(504, "WORKER_TIMEOUT", "Function exceeded its wall-clock limit");
        this.#abort(id);
      }, timeoutMs);
      this.#pending.set(id, pending);
      call.signal?.addEventListener("abort", () => {
        pending.fail(499, "CLIENT_CLOSED", "the client closed the request");
        this.#abort(id);
      }, { once: true });
      const message: HostMessage = {
        t: "req",
        id,
        url: call.url,
        method: call.method,
        headers: call.headers,
        body: call.body,
        remote: call.remote,
      };
      worker.postMessage(message, call.body ? [call.body] : []);
    });
  }

  /** Stop the worker (it starts again on the next call). */
  stop(): void {
    if (this.#worker) this.#die(this.#worker);
  }
}

/** Run `fn`, ignoring a throw (a stream the client already cancelled or closed). */
function quietly(fn: () => void): void {
  try {
    fn();
  } catch {
    // Already closed or cancelled.
  }
}

/** Statuses whose response cannot carry a body. */
function nullBodyStatus(status: number): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304;
}

// ── Callers ──────────────────────────────────────────────────────────────────

/** Who is calling a function. */
interface FunctionCaller {
  /** The caller's role. */
  role: "anon" | "authenticated" | "service_role";
  /** The user's id, for a signed-in caller. */
  userId?: string;
  /** Whether the identity came from the page's cookie (so a cross-site write is refused). */
  cookie: boolean;
}

/**
 * The caller of a function request through the shared identity function (`resolveIdentity`):
 * a user's access token, an API key (the anon key counts, as with Supabase's `verify_jwt`), or
 * a denext session. `null` when the request carries no credential at all.
 *
 * @param request The request.
 * @returns The caller, or `null`.
 * @throws {IdentityError} For a credential that was presented and refused.
 */
async function functionCaller(request: Request): Promise<FunctionCaller | null> {
  const identity = await resolveIdentity(request);
  if (identity.source === "none") return null;
  return {
    role: identity.role,
    userId: identity.userId,
    cookie: identity.source === "session" && nativeBearerToken(request) === undefined,
  };
}

const checkCsrf = csrf();

// ── The request handler ──────────────────────────────────────────────────────

/** The functions the handler serves, and how it finds them. */
interface FunctionRegistry {
  /** The function named `name`, or `undefined`. */
  lookup(name: string): Promise<FunctionHost | undefined>;
  /** Every host started so far. */
  hosts(): Iterable<FunctionHost>;
}

/**
 * A registry over a functions directory. In dev a miss re-reads the directory (a function
 * created while the server runs gets its route); `reset()` stops every worker (teardown), and
 * `reset(false)` retires them once their requests finish (an edit).
 *
 * @param dir The directory.
 * @param config The resolved options (per-function permissions).
 * @param dev Re-read the directory on a miss.
 * @param spawn Starts a worker.
 * @returns The registry.
 */
function directoryRegistry(
  dir: string,
  config: ResolvedFunctions,
  dev: boolean,
  spawn?: WorkerFactory,
): FunctionRegistry & { reset(hard?: boolean): void } {
  let found: Promise<Map<string, string>> | undefined;
  const hosts = new Map<string, FunctionHost>();
  const read = () => found ??= discoverFunctions(dir);
  return {
    async lookup(name) {
      let paths = await read();
      if (!paths.has(name) && dev) {
        found = undefined;
        paths = await read();
      }
      const path = paths.get(name);
      if (!path) return undefined;
      let host = hosts.get(name);
      if (!host) {
        host = new FunctionHost(name, path, config.functions[name]?.permissions, spawn);
        hosts.set(name, host);
      }
      return host;
    },
    hosts: () => hosts.values(),
    reset(hard = true) {
      for (const host of hosts.values()) hard ? host.stop() : host.retire();
      hosts.clear();
      found = undefined;
    },
  };
}

/** The env a new worker starts with: `SUPABASE_URL`, `SUPABASE_DB_URL`, then the configured. */
function workerEnv(
  config: ResolvedFunctions,
  name: string,
  request: Request,
  appBasePath: string,
  readEnv: (name: string) => string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  env.SUPABASE_URL = readEnv("SUPABASE_URL") ??
    config.url ?? new URL(request.url).origin + appBasePath;
  const database = readEnv("SUPABASE_DB_URL") ?? readEnv("DATABASE_URL");
  if (database) env.SUPABASE_DB_URL = database;
  return { ...env, ...keyEnv(readEnv), ...config.env, ...config.functions[name]?.env };
}

/** The keys under Supabase's names, from the backend's own (the first of a rotation list). */
function keyEnv(readEnv: (name: string) => string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [names, from] of KEY_ENV) {
    const value = readEnv(from)?.split(",")[0]?.trim();
    if (!value) continue;
    for (const target of names.filter((n) => !readEnv(n))) env[target] = value;
  }
  return env;
}

/** Supabase's key variables, filled from `DENEXT_PUBLISHABLE_KEY` / `DENEXT_SECRET_KEY`. */
const KEY_ENV: Array<[string[], string]> = [
  [["SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY"], "DENEXT_PUBLISHABLE_KEY"],
  [["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY"], "DENEXT_SECRET_KEY"],
];

function readProcessEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name) || undefined;
  } catch {
    return undefined;
  }
}

/** Split `<name>[/rest]` off the path after the prefix; `null` for a malformed name. */
function routeOf(sub: string): { name: string; rest: string } | null {
  const slash = sub.indexOf("/");
  const raw = slash < 0 ? sub : sub.slice(0, slash);
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!FUNCTION_NAME.test(name)) return null;
  return { name, rest: slash < 0 ? "" : sub.slice(slash) };
}

/**
 * The Edge Functions request handler. Answers only paths under `config.basePath`; everything
 * else passes (`null`).
 *
 * @param config The resolved options.
 * @param registry The functions.
 * @param appBasePath The app's `basePath` (for `SUPABASE_URL`).
 * @param readEnv Reads the process environment.
 * @returns The handler.
 */
function functionsHandler(
  config: ResolvedFunctions,
  registry: FunctionRegistry,
  appBasePath = "",
  readEnv: (name: string) => string | undefined = readProcessEnv,
): (request: Request) => Promise<Response | null> {
  const prefix = `${config.basePath}/`;
  return async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(prefix)) return null;
    const target = await targetOf(registry, config, url.pathname.slice(prefix.length));
    if (!target) return relayError(404, "NOT_FOUND", "Requested function was not found");
    const { route, host, verifyJwt, timeoutMs } = target;
    const refused = await refusal(request, verifyJwt);
    if (refused) return refused;
    const body = await bufferedBody(request, config.maxBodyBytes);
    if (body instanceof Response) return body;
    return await host.call(
      {
        url: `${url.origin}/${route.name}${route.rest}${url.search}`,
        method: request.method,
        headers: [...request.headers],
        body,
        remote: remoteAddress(),
        signal: request.signal,
      },
      workerEnv(config, route.name, request, appBasePath, readEnv),
      timeoutMs,
    );
  };
}

/** The function a path names, with its effective settings; `undefined` when there is none. */
async function targetOf(
  registry: FunctionRegistry,
  config: ResolvedFunctions,
  sub: string,
): Promise<
  | {
    route: { name: string; rest: string };
    host: FunctionHost;
    verifyJwt: boolean;
    timeoutMs: number;
  }
  | undefined
> {
  const route = routeOf(sub);
  const host = route && await registry.lookup(route.name);
  if (!route || !host) return undefined;
  const settings = config.functions[route.name] ?? {};
  return {
    route,
    host,
    verifyJwt: settings.verifyJwt ?? config.verifyJwt,
    timeoutMs: settings.timeoutMs ?? config.timeoutMs,
  };
}

/** Whether a method carries no body (and no CSRF risk). */
function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

/**
 * Why a request may not reach the function (`401`, or `403` for a cross-site cookie write), or
 * `null`. A preflight and a function with `verifyJwt: false` are never refused.
 */
async function refusal(request: Request, verify: boolean): Promise<Response | null> {
  if (request.method === "OPTIONS" || !verify) return null;
  let caller: FunctionCaller | null;
  try {
    caller = await functionCaller(request);
  } catch (error) {
    if (!isIdentityError(error)) throw error;
    return relayError(401, "UNAUTHORIZED", error.message);
  }
  if (!caller) return relayError(401, "UNAUTHORIZED", "Missing authorization header");
  if (!caller.cookie || isSafeMethod(request.method)) return null;
  try {
    await checkCsrf({ request, params: {}, ctx: {}, method: request.method as "POST" });
    return null;
  } catch {
    return relayError(403, "CSRF_FAILED", "cross-site request refused");
  }
}

/** The request body, buffered up to `max` bytes; `null` for none; an error response past it. */
async function bufferedBody(request: Request, max: number): Promise<ArrayBuffer | null | Response> {
  if (!request.body || isSafeMethod(request.method)) return null;
  const bytes = await readCappedBody(request, max);
  if (bytes === TOO_LARGE) {
    return relayError(413, "PAYLOAD_TOO_LARGE", "the request body is too large");
  }
  if (bytes === STALLED) return relayError(408, "REQUEST_TIMEOUT", "the request body stalled");
  return bytes.slice().buffer as ArrayBuffer;
}

/** The client's address, when the request context knows it. */
function remoteAddress(): string | undefined {
  try {
    return clientIp();
  } catch {
    return undefined;
  }
}

/**
 * Whether the project enables Deno's worker options (`"unstable": ["worker-options"]` in
 * `deno.json` / `deno.jsonc`), which per-function `permissions` need.
 */
async function workerOptionsEnabled(projectRoot: string): Promise<boolean> {
  for (const file of ["deno.json", "deno.jsonc"]) {
    let text: string;
    try {
      text = await Deno.readTextFile(join(projectRoot, file));
    } catch {
      continue;
    }
    return /"unstable"\s*:\s*\[[^\]]*"worker-options"/.test(text);
  }
  return false;
}

/**
 * Wire Edge Functions into the plugin: the request handler, and under `denext dev` a watcher
 * that restarts the workers when a file in the functions directory changes.
 *
 * @param ctx The plugin context.
 * @param config The resolved options.
 */
export async function setupFunctions(ctx: PluginContext, config: ResolvedFunctions): Promise<void> {
  const withPermissions = Object.entries(config.functions)
    .filter(([, f]) => f.permissions !== undefined && f.permissions !== "inherit")
    .map(([name]) => name);
  if (withPermissions.length && !(await workerOptionsEnabled(ctx.projectRoot))) {
    throw new TypeError(
      `backend(): functions ${withPermissions.join(", ")} set permissions, which need Deno's ` +
        `worker options: add "unstable": ["worker-options"] to deno.json`,
    );
  }
  const dir = await functionsDir(ctx.projectRoot, config.dir);
  const dev = ctx.mode === "dev";
  const registry = directoryRegistry(dir, config, dev);
  const appBasePath = (ctx.config.basePath ?? "").replace(/\/$/, "");
  ctx.addRequestHandler(functionsHandler(config, registry, appBasePath));
  ctx.addTeardown(() => registry.reset());
  if (dev) watchFunctions(ctx, dir, () => registry.reset(false));
}

/** Options for {@linkcode serveFunctions}. */
export interface ServeFunctionsOptions {
  /** The port (default 54321, the Supabase CLI's). */
  port?: number;
  /** The interface (default `127.0.0.1`). */
  hostname?: string;
  /** Stops the server. */
  signal?: AbortSignal;
  /** Called once it listens. */
  onListen?: (addr: Deno.NetAddr) => void;
}

/**
 * `denext functions serve`: only the functions host, on its own port — `/functions/v1/<name>`
 * answered from the functions directory (re-read on a miss, workers restarted on an edit),
 * everything else a 404.
 *
 * @param projectRoot The project.
 * @param config The resolved options.
 * @param options Where to listen.
 * @returns The server.
 */
export async function serveFunctions(
  projectRoot: string,
  config: ResolvedFunctions,
  options: ServeFunctionsOptions = {},
): Promise<Deno.HttpServer<Deno.NetAddr>> {
  const dir = await functionsDir(projectRoot, config.dir);
  const registry = directoryRegistry(dir, config, true);
  const handle = functionsHandler(config, registry);
  let watcher: Deno.FsWatcher | undefined;
  try {
    watcher = Deno.watchFs(dir, { recursive: true });
    (async () => {
      for await (const _event of watcher!) registry.reset(false);
    })().catch(() => {});
  } catch { /* no directory yet */ }
  const server = Deno.serve(
    {
      port: options.port ?? 54321,
      hostname: options.hostname ?? "127.0.0.1",
      ...(options.signal ? { signal: options.signal } : {}),
      onListen: (addr) => options.onListen?.(addr),
    },
    async (request) =>
      (await handle(request)) ?? relayError(404, "NOT_FOUND", "Requested function was not found"),
  );
  server.finished.then(() => {
    registry.reset();
    try {
      watcher?.close();
    } catch { /* closed */ }
  });
  return server;
}

/** Restart the workers after an edit under `dir` (debounced). */
function watchFunctions(ctx: PluginContext, dir: string, reset: () => void): void {
  let watcher: Deno.FsWatcher;
  try {
    watcher = Deno.watchFs(dir, { recursive: true });
  } catch {
    return; // No directory yet: a function added later is found on its first request.
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  (async () => {
    try {
      for await (const _event of watcher) {
        clearTimeout(timer);
        timer = setTimeout(reset, 100);
      }
    } catch {
      // Closed.
    }
  })();
  ctx.addTeardown(() => {
    clearTimeout(timer);
    try {
      watcher.close();
    } catch {
      // Already closed.
    }
  });
}
