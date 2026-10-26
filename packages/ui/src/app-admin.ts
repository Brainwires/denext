// How the Database section reaches the RUNNING app, for what only its process knows: realtime's
// live channels and presence, Edge Functions' recent invocations and the `services/` supervision
// tree (the backend's admin endpoint, `/_denext/backend/admin/*`), and the app's own
// `/_denext/health` probe.
//
// Where the app is: in the stack's dashboard, `DASHBOARD_APP_URL` (`http://web:3000`, set by the
// compose file); in `denext ui`, the dev server `.denext/dev.json` names. The admin endpoint
// answers only the secret key (`DENEXT_SECRET_KEY`: the environment, else the project's `.env`),
// sent as the `apikey` header and never rendered, logged or put in a URL.

import { join } from "@std/path";
import { parseEnv, readDevInfo } from "@denext/denext/internal/ui-host";

/** Where the running app is, and the key its admin endpoint wants. */
export interface AppTarget {
  /** Its origin (`http://web:3000`). */
  readonly url: string;
  /** The secret key, when one is known (else the admin endpoint is not asked). */
  readonly key: string | null;
}

/** The admin endpoint's path. */
const ADMIN = "/_denext/backend/admin";

/** How long one call to the app may take. */
const APP_DEADLINE_MS = 8_000;

/** How a page reaches the app (tests answer in-process). */
export type AppFetch = (url: string, init: RequestInit) => Promise<Response>;

let appFetch: AppFetch = (url, init) => fetch(url, init);

/**
 * Swap how the app is reached (tests).
 *
 * @internal
 * @param next The fetch.
 * @returns The one installed before.
 */
export function setAppFetch(next: AppFetch): AppFetch {
  const previous = appFetch;
  appFetch = next;
  return previous;
}

/** An environment variable, or `undefined`. */
function env(name: string): string | undefined {
  try {
    return Deno.env.get(name) || undefined;
  } catch {
    return undefined;
  }
}

/** The first of a comma-separated key list (the current key; rotations list the old one after). */
function firstKey(value: string | undefined): string | null {
  return value?.split(",").map((k) => k.trim()).find((k) => k !== "") ?? null;
}

/**
 * The secret key: the environment's `DENEXT_SECRET_KEY`, else the project's `.env`.
 *
 * @param dir The project.
 * @returns The key, or `null`.
 */
export async function secretKey(dir: string): Promise<string | null> {
  const fromEnv = firstKey(env("DENEXT_SECRET_KEY"));
  if (fromEnv) return fromEnv;
  try {
    return firstKey(parseEnv(await Deno.readTextFile(join(dir, ".env"))).DENEXT_SECRET_KEY);
  } catch {
    return null;
  }
}

/**
 * Where this request's pages reach the running app: the dashboard's configured app, else the
 * project's running dev server.
 *
 * @param ctx The request's project and configured app.
 * @returns The target, or `null` when no app is known to be running.
 */
export async function appTarget(
  ctx: { readonly dir: string; readonly app?: AppTarget },
): Promise<AppTarget | null> {
  if (ctx.app) return ctx.app;
  const dev = await readDevInfo(ctx.dir);
  return dev ? { url: dev.origin, key: await secretKey(ctx.dir) } : null;
}

/** A deadline for one call, tied to the server's shutdown. */
function deadline(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(APP_DEADLINE_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Is `res` a redirect? A call to the app never follows one (`redirect: "manual"`): fetch would
 * carry the `apikey` header (the backend's secret key) to wherever it points, another origin
 * included. A manual redirect reads as a 3xx, or as an opaque redirect (status 0) in a browser.
 */
function isRedirect(res: Response): boolean {
  return res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400);
}

/** A JSON GET against the app, as `{ ok: false, reason }` for anything but a JSON 2xx. */
async function getJson<T>(
  target: AppTarget,
  path: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<T | { ok: false; reason: string }> {
  let res: Response;
  try {
    res = await appFetch(`${target.url.replace(/\/+$/, "")}${path}`, {
      headers,
      redirect: "manual",
      signal: deadline(signal),
    });
  } catch {
    return { ok: false, reason: `the app at ${target.url} did not answer` };
  }
  if (isRedirect(res)) {
    await res.body?.cancel();
    return {
      ok: false,
      reason: `the app answered a redirect (${res.status}) for ${path}; the admin endpoint is ` +
        "not followed elsewhere (its secret key would go with it)",
    };
  }
  const body = await res.json().catch(() => null) as (T & { reason?: string }) | null;
  if (!res.ok || body === null) {
    return { ok: false, reason: `the app answered ${res.status}: ${body?.reason ?? "no reason"}` };
  }
  return body;
}

/** One function the app serves. */
export interface AdminFunction {
  readonly name: string;
  readonly verifyJwt: boolean;
  readonly modified: number | null;
}

/** One recent invocation. */
export interface AdminInvocation {
  readonly name: string;
  readonly status: number;
  readonly ms: number;
  readonly at: number;
}

/** A supervised child's status, as `supervisionStatus()` reports it. */
export interface AdminChildStatus {
  readonly name: string;
  readonly path: string;
  readonly kind: string;
  readonly state: string;
  readonly restarts: number;
  readonly since: number;
  readonly lastError?: { readonly message: string; readonly at: number };
  readonly children?: readonly AdminChildStatus[];
}

/** What `/status` answers. */
export interface AdminStatus {
  readonly ok: true;
  readonly realtime: {
    readonly connections: number;
    readonly channels: { topic: string; private: boolean; subscribers: number }[];
    readonly bindings: {
      topic: string;
      tables: string[];
      filter: string | null;
      events: string[];
    }[];
  } | null;
  readonly functions: {
    readonly functions: AdminFunction[];
    readonly invocations: AdminInvocation[];
  } | null;
  readonly services: AdminChildStatus[];
}

/** The admin endpoint's headers: the secret key, as `apikey`. */
function adminHeaders(target: AppTarget): Record<string, string> {
  return target.key ? { apikey: target.key } : {};
}

/** Why the admin endpoint cannot be asked, when there is no key. */
const NO_KEY = "the app's admin endpoint needs the backend's secret key: set DENEXT_SECRET_KEY " +
  "(denext backend keys) where this UI runs";

/**
 * The running app's admin status: realtime, functions, services.
 *
 * @param target The app.
 * @param signal The server's shutdown.
 * @returns The status, or why not.
 */
export function adminStatus(
  target: AppTarget,
  signal?: AbortSignal,
): Promise<AdminStatus | { ok: false; reason: string }> {
  if (!target.key) return Promise.resolve({ ok: false, reason: NO_KEY });
  return getJson<AdminStatus>(target, `${ADMIN}/status`, adminHeaders(target), signal);
}

/**
 * A live topic's presence keys, or (with `key`) the payloads tracked under that one key.
 *
 * @param target The app.
 * @param topic The topic.
 * @param isPrivate A private channel's.
 * @param key The presence key to expand.
 * @param signal The server's shutdown.
 * @returns The keys (key → presences), or the payloads.
 */
export function adminPresence(
  target: AppTarget,
  topic: string,
  isPrivate: boolean,
  key: string | null,
  signal?: AbortSignal,
): Promise<
  | { ok: true; keys?: Record<string, number>; payloads?: unknown[] }
  | { ok: false; reason: string }
> {
  if (!target.key) return Promise.resolve({ ok: false, reason: NO_KEY });
  const query = new URLSearchParams({ topic, private: isPrivate ? "1" : "0" });
  if (key !== null) query.set("key", key);
  return getJson(target, `${ADMIN}/presence?${query}`, adminHeaders(target), signal);
}

/** The app's `/_denext/health` answer. */
export interface AppProbe {
  /** `ok`, `degraded`, or `unreachable`. */
  readonly status: "ok" | "degraded" | "unreachable";
  /** Its HTTP status, when it answered. */
  readonly httpStatus?: number;
  /** Each readiness check: `ok` / `down`. */
  readonly checks: Record<string, string>;
}

/**
 * The app's public readiness probe, as `denext stack health` reads it.
 *
 * @param target The app.
 * @param signal The server's shutdown.
 * @returns The verdict.
 */
export async function appProbe(target: AppTarget, signal?: AbortSignal): Promise<AppProbe> {
  try {
    const res = await appFetch(`${target.url.replace(/\/+$/, "")}/_denext/health`, {
      redirect: "manual",
      signal: deadline(signal),
    });
    if (isRedirect(res)) {
      await res.body?.cancel();
      return { status: "degraded", httpStatus: res.status, checks: {} };
    }
    const body = await res.json().catch(() => ({})) as { checks?: Record<string, string> };
    return {
      status: res.ok ? "ok" : "degraded",
      httpStatus: res.status,
      checks: body.checks && typeof body.checks === "object" ? body.checks : {},
    };
  } catch {
    return { status: "unreachable", checks: {} };
  }
}
