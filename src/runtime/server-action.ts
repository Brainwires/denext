// Server Actions — call a server function from the client over an RPC endpoint.
//
// denext has no bundler transform of `"use server"`, so actions are registered
// at runtime by id: `serverAction("id", handler)`. On the server the returned
// reference runs the handler directly (and registers it for dispatch); in the
// browser it returns a stub that POSTs to `/_denext/action/<id>`.
//
// SECURITY: the dispatch endpoint runs with the visitor's ambient cookies, so it
// is a CSRF target. The server enforces same-origin on every action request
// (see `handleAction`). Actions themselves must still perform their own
// authorization and input validation — being registered makes an action
// callable by anyone who is same-origin.

/** The reserved URL prefix under which server actions are dispatched. */
export const ACTION_PREFIX = "/_denext/action/";

/** A reference to a server action: callable, and tagged with its stable id. */
export interface ServerActionRef<A extends unknown[], R> {
  (...args: A): Promise<R>;
  /** Stable id identifying this action across the server/client boundary. */
  readonly denextActionId: string;
}

// Registry of server-side handlers, keyed by id. Populated only on the server
// (when a module calls serverAction during import/render); unused in the browser.
const registry = new Map<string, (...args: unknown[]) => unknown>();

/**
 * Define a server action. Give it a **stable, explicit id** (unique per app) so
 * the client stub and the server handler agree across the boundary.
 *
 * On the server the returned function runs `handler` directly and registers it
 * for RPC dispatch. In the browser it returns a stub that POSTs the arguments to
 * the action endpoint and resolves with the JSON result.
 *
 * The handler runs with the request's async context, so it may read
 * `cookies()`/`headers()`, call `revalidatePath`/`revalidateTag`, or `redirect()`.
 * It **must** authorize and validate its own input — registration alone exposes
 * it to any same-origin caller.
 *
 * @param id A stable, app-unique identifier for this action.
 * @param handler The server-side implementation.
 * @returns A {@link ServerActionRef} usable as a `<form action>` or called directly.
 */
export function serverAction<A extends unknown[], R>(
  id: string,
  handler: (...args: A) => R | Promise<R>,
): ServerActionRef<A, R> {
  if (typeof document !== "undefined") return clientActionStub<A, R>(id);
  return registerServerReference(id, handler);
}

/**
 * Register a handler as a server reference under `id` and return a callable ref
 * tagged with that id. The building block behind {@link serverAction} and the
 * auto-registration of `"use server"` module exports.
 *
 * @param id The stable server-reference id.
 * @param handler The server-side implementation.
 * @returns A {@link ServerActionRef} that runs the handler directly.
 */
export function registerServerReference<A extends unknown[], R>(
  id: string,
  handler: (...args: A) => R | Promise<R>,
): ServerActionRef<A, R> {
  registry.set(id, handler as (...args: unknown[]) => unknown);
  const ref = (...args: A) => Promise.resolve(handler(...args));
  return Object.assign(ref, { denextActionId: id }) as ServerActionRef<A, R>;
}

/**
 * Auto-register every function exported by a `"use server"` module as a server
 * reference, tagging each exported function in place (so it serializes as an
 * action reference when passed as a prop, e.g. `<form action={save}>`). Ids are
 * `moduleId#exportName`. Idempotent per function.
 *
 * @param mod The imported `"use server"` module namespace.
 * @param moduleId The module's stable id.
 */
export function tagServerExports(mod: Record<string, unknown>, moduleId: string): void {
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value !== "function" || isServerAction(value)) continue;
    const id = `${moduleId}#${name}`;
    registry.set(id, value as (...args: unknown[]) => unknown);
    Object.defineProperty(value, "denextActionId", {
      value: id,
      enumerable: false,
      configurable: true,
    });
  }
}

/**
 * Build a browser dispatch stub for a server-reference id. Used by the Flight
 * client to rehydrate a `{$:"a"}` reference into a callable that POSTs to the
 * action endpoint. The returned function is tagged with `denextActionId` so it
 * round-trips (e.g. when re-serialized as a `<form action>`).
 *
 * @param id The server-reference / action id.
 */
export function clientActionStub<A extends unknown[], R>(id: string): ServerActionRef<A, R> {
  const ref = (...args: A) => dispatchFromClient(id, args) as Promise<R>;
  return Object.assign(ref, { denextActionId: id }) as ServerActionRef<A, R>;
}

// Server module ids already imported + tagged this process.
const taggedServers = new Set<string>();

/**
 * Import each `"use server"` module and auto-register its exports as server
 * references (see {@link tagServerExports}). Safe to call repeatedly; each module
 * is imported at most once per process.
 *
 * @param servers Map of module id → `{ url }` (the boundary manifest's servers).
 */
export async function tagServerModules(
  servers: Iterable<[string, { url: string }]>,
): Promise<void> {
  await Promise.all(
    [...servers].map(async ([moduleId, ref]) => {
      if (taggedServers.has(moduleId)) return;
      const mod = await import(ref.url);
      tagServerExports(mod as Record<string, unknown>, moduleId);
      taggedServers.add(moduleId);
    }),
  );
}

/** Look up a registered server action handler by id (server-side). */
export function getServerAction(
  id: string,
): ((...args: unknown[]) => unknown) | undefined {
  return registry.get(id);
}

/** The dispatch URL for an action id. */
export function actionEndpoint(id: string): string {
  return ACTION_PREFIX + encodeURIComponent(id);
}

/** True if `value` is a {@link ServerActionRef}. */
export function isServerAction(
  value: unknown,
): value is ServerActionRef<unknown[], unknown> {
  return (
    typeof value === "function" &&
    typeof (value as { denextActionId?: unknown }).denextActionId === "string"
  );
}

/** Reserved FormData field carrying non-FormData args alongside a FormData arg. */
const META_FIELD = "__denext_meta";

// ---- Client dispatch -------------------------------------------------------

async function dispatchFromClient(id: string, args: unknown[]): Promise<unknown> {
  const { body, headers } = encodeActionArgs(args);
  headers["x-denext-action"] = "1";
  const res = await fetch(actionEndpoint(id), {
    method: "POST",
    headers,
    body,
    // Never attach credentials cross-origin; same-origin cookies still flow.
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as {
    result?: unknown;
    redirect?: string;
    error?: string;
  };
  if (data.redirect) {
    if (typeof location !== "undefined") location.href = data.redirect;
    return undefined;
  }
  if (!res.ok || data.error) {
    throw new Error(data.error ?? `server action failed (${res.status})`);
  }
  return data.result;
}

/**
 * Encode action arguments for transport. When one argument is a `FormData`, the
 * request is multipart (the form fields ride along) and the other arguments are
 * JSON-encoded in a reserved meta field; otherwise the arguments are sent as
 * JSON. Exported for the server decoder to mirror.
 */
export function encodeActionArgs(
  args: unknown[],
): { body: BodyInit; headers: Record<string, string> } {
  const hasFormData = typeof FormData !== "undefined";
  let fdIndex = -1;
  if (hasFormData) {
    for (let i = 0; i < args.length; i++) {
      if (args[i] instanceof FormData) {
        fdIndex = i;
        break;
      }
    }
  }
  if (fdIndex === -1) {
    return {
      body: JSON.stringify({ args }),
      headers: { "content-type": "application/json" },
    };
  }
  const fd = args[fdIndex] as FormData;
  const others = args.map((a, i) => (i === fdIndex ? null : a));
  fd.append(META_FIELD, JSON.stringify({ fdIndex, others }));
  return { body: fd, headers: {} };
}

/**
 * Decode action arguments from a request body (mirror of {@link encodeActionArgs}).
 * A native (no-JS) form post with no meta field yields a single `FormData` arg.
 *
 * @param request The incoming action request.
 * @returns The argument list to apply to the handler.
 */
export async function decodeActionArgs(request: Request): Promise<unknown[]> {
  const ct = request.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as { args?: unknown };
    return Array.isArray(body.args) ? body.args : [];
  }
  const fd = await request.formData();
  const metaRaw = fd.get(META_FIELD);
  if (typeof metaRaw === "string") {
    fd.delete(META_FIELD);
    let meta: { fdIndex: number; others: unknown[] };
    try {
      meta = JSON.parse(metaRaw);
    } catch {
      return [fd];
    }
    // `fdIndex` is attacker-controlled. It must name a real in-range slot of
    // `others`; otherwise `args[fdIndex] = fd` could inflate the array to an
    // arbitrary length, and the handler spread (`handler(...args)`) would then
    // iterate every hole — an unbounded-work DoS (CVE-2026-64641 / CWE-834 class).
    // Reject anything but a valid index and fall back to treating the request as a
    // native single-FormData submission.
    if (
      !Array.isArray(meta.others) ||
      !Number.isInteger(meta.fdIndex) ||
      meta.fdIndex < 0 ||
      meta.fdIndex >= meta.others.length
    ) {
      return [fd];
    }
    const args = [...meta.others];
    args[meta.fdIndex] = fd;
    return args;
  }
  // Native progressive-enhancement post: the raw form is the single argument.
  return [fd];
}
