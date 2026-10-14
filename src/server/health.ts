// Readiness checks behind `/_denext/health`. The probe stays a liveness probe for the app
// itself (a cache outage degrades to live renders and keeps `200`), but a dependency the app
// cannot serve without — `@denext/backend`'s database — registers a check here: while one fails
// the probe answers `503` with `"status": "degraded"`, so a load balancer or a compose
// healthcheck stops sending traffic to an instance that can only answer errors. The registry is
// process-global (`Symbol.for`), so a plugin bundled with its own copy of this module shares it.

/** A check's verdict: `true` / `{ ok: true }` is healthy; anything else (or a throw) is down. */
export type HealthCheck = () =>
  | boolean
  | { ok: boolean }
  | Promise<boolean | { ok: boolean }>;

/** Options for {@linkcode registerHealthCheck}. */
export interface HealthCheckOptions {
  /** How long the check may take before it counts as down (default 2000 ms). */
  timeoutMs?: number;
}

interface Entry {
  check: HealthCheck;
  timeoutMs: number;
}

const SLOT = Symbol.for("denext.healthChecks");

function registry(): Map<string, Entry> {
  const holder = globalThis as { [SLOT]?: Map<string, Entry> };
  return holder[SLOT] ??= new Map();
}

/**
 * Register a readiness check `/_denext/health` runs on every probe. While it fails the probe
 * answers `503` with `"status": "degraded"` and `checks: { [name]: "down" }` (never the error
 * itself — the probe is public). Registering a name again replaces the check.
 *
 * @param name The check's name in the probe's `checks` (e.g. `"database"`).
 * @param check Resolves `true` (or `{ ok: true }`) when healthy.
 * @param options `timeoutMs`: how long it may take (default 2000).
 * @returns Unregisters it (a plugin calls this from its teardown).
 */
export function registerHealthCheck(
  name: string,
  check: HealthCheck,
  options: HealthCheckOptions = {},
): () => void {
  const entry = { check, timeoutMs: options.timeoutMs ?? 2000 };
  registry().set(name, entry);
  return () => {
    if (registry().get(name) === entry) registry().delete(name);
  };
}

async function passes(entry: Entry): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), entry.timeoutMs);
  });
  try {
    const verdict = await Promise.race([Promise.resolve().then(entry.check), timeout]);
    return verdict === true || (typeof verdict === "object" && verdict?.ok === true);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run every registered check (concurrently, each under its timeout).
 *
 * @returns `ok` when all pass, and each check's `"ok"` / `"down"`.
 */
export async function runHealthChecks(): Promise<
  { ok: boolean; checks: Record<string, "ok" | "down"> }
> {
  const entries = [...registry()];
  const results = await Promise.all(entries.map(([, entry]) => passes(entry)));
  const checks: Record<string, "ok" | "down"> = {};
  entries.forEach(([name], i) => checks[name] = results[i] ? "ok" : "down");
  return { ok: results.every(Boolean), checks };
}
