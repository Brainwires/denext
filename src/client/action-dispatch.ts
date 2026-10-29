// The browser half of a Server Action call: encode the arguments, POST them to the action
// endpoint, and handle the reply (a redirect, an error, a refresh, a codec-encoded result).
//
// On demand only: the generic stub (src/runtime/action-stub.ts) imports it when a page creates
// its first action reference, and a Flight page's action call (action-call.ts) through the
// entry's loader, so a page with no Server Action never loads it. It imports nothing: the bundler
// places code by FILE, so an on-demand chunk that used a module the startup graph reaches would
// pull that module's code into the startup chunks (or split them). What it needs — the refresh
// handler, the wire decoder and encoder — its caller hands it with each call.

/** The wire encoder's pre-stringify half (wire-encode.ts's `prepareWire`). */
type Prepare = (value: unknown) => { value: unknown; tagged: boolean };

/** The reserved URL prefix actions are dispatched under (server-action.ts's `ACTION_PREFIX`). */
const ACTION_PREFIX = "/_denext/action/";

/** The `enc` envelope value of a codec-encoded field (wire-codec.ts's `WIRE_ENC`). */
const WIRE_ENC = 1;

/** Reserved FormData field carrying non-FormData args (server-action.ts's decoder reads it). */
const META_FIELD = "__denext_meta";

/**
 * The sessionStorage flag set before the page reloads itself on an unknown action id (a page from
 * an older build posting to a newer one) — the guard against reloading again when the reloaded
 * page's actions are unknown too. Cleared by the next action call that succeeds.
 */
const RELOAD_FLAG = "denext:action-reload";

/** `sessionStorage` access that never throws (a sandboxed frame, a private window). */
function storage(): Storage | undefined {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * The server doesn't know the action's id, so this page was rendered by an older build: reload
 * it once (the fresh page carries the new ids), and never again until an action succeeds.
 *
 * @returns Whether a reload was started.
 */
function reloadOnceForStaleBuild(): boolean {
  const store = storage();
  if (store?.getItem(RELOAD_FLAG)) return false;
  store?.setItem(RELOAD_FLAG, "1");
  if (typeof location === "undefined") return false;
  location.reload();
  return true;
}

/** The JSON an action endpoint replies with. */
interface ActionReply {
  result?: unknown;
  enc?: number;
  redirect?: string;
  replace?: boolean;
  error?: string;
  /** A `notFound()` / `forbidden()` / `unauthorized()` the action threw (action-handler.ts). */
  signal?: string;
  refresh?: true;
  updatedTags?: string[];
}

/**
 * Call the Server Action `id` with `args` from the browser.
 *
 * @param id The action id.
 * @param args The call's arguments (a `FormData` among them rides as multipart).
 * @param refresh Re-renders the current route; run when the action revalidated or refreshed.
 * @param decode The wire decoder, for a result the server flagged `enc`.
 * @param prepare The wire encoder, for the arguments.
 * @returns The action's result (`undefined` after a redirect).
 * @throws When the endpoint answers with an error.
 */
export async function dispatchAction(
  id: string,
  args: unknown[],
  refresh: (() => void) | null,
  decode: (value: unknown) => unknown,
  prepare: Prepare,
): Promise<unknown> {
  const { body, headers } = encodeActionArgs(args, prepare);
  headers["x-denext-action"] = "1";
  const res = await fetch(ACTION_PREFIX + encodeURIComponent(id), {
    method: "POST",
    headers,
    body,
    // Never attach credentials cross-origin; same-origin cookies still flow.
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as ActionReply;
  if (data.redirect) {
    navigate(data.redirect, data.replace);
    return undefined;
  }
  const signal = accessSignal(data.signal);
  if (signal) throw signal;
  failIfRefused(res, data);
  storage()?.removeItem(RELOAD_FLAG);
  // Read-your-writes: if the action revalidated tags or asked for a refresh,
  // re-render the current route so the client reflects the new server state.
  if ((data.refresh || (data.updatedTags && data.updatedTags.length > 0)) && refresh) {
    refresh();
  }
  // A result the server flagged `enc` carries wire-codec tags (Date/Map/Set/BigInt/…).
  return data.enc === WIRE_ENC ? decode(data.result) : data.result;
}

/** Each access signal's HTTP status (the `NEXT_HTTP_ERROR_FALLBACK;<status>` digest). */
const SIGNAL_STATUS: Record<string, number> = { notFound: 404, forbidden: 403, unauthorized: 401 };

/**
 * The reply's `signal` as the error `notFound()` / `forbidden()` / `unauthorized()` throws: the
 * same message, Next's `digest`, and denext's global brand (`Symbol.for("denext.<signal>")`, what
 * `isNotFound()` and friends test), so `unstable_rethrow` passes it on; and marked as a Server
 * Action's (`Symbol.for("denext.actionSignal")`), for which the client renders the nearest
 * `not-found.tsx` / `forbidden.tsx` / `unauthorized.tsx`. Built here rather than
 * imported: this on-demand chunk imports nothing (see the top of the file).
 *
 * @param signal The reply's `signal` field.
 * @returns The branded error, or `undefined` for no (or an unknown) signal.
 */
function accessSignal(signal: string | undefined): Error | undefined {
  if (!signal || !Object.hasOwn(SIGNAL_STATUS, signal)) return undefined;
  const err = new Error(
    "NEXT_" + signal.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase(),
  ) as Error & { digest: string };
  err.name = signal[0].toUpperCase() + signal.slice(1) + "Error";
  err.digest = "NEXT_HTTP_ERROR_FALLBACK;" + SIGNAL_STATUS[signal];
  const brands = err as unknown as Record<symbol, boolean>;
  brands[Symbol.for("denext." + signal)] = true;
  // Raised by a Server Action: the client tree renders it (fiber/boundaries.ts).
  brands[Symbol.for("denext.actionSignal")] = true;
  return err;
}

/**
 * A `replace`-type redirect swaps the current history entry (no back-stack entry); otherwise push
 * a new one. Both are full navigations from a Server Action (none outside a browser).
 */
function navigate(url: string, replace: boolean | undefined): void {
  if (typeof location === "undefined") return;
  if (replace) location.replace(url);
  else location.href = url;
}

/**
 * Throw for an answer that refused the call: an unknown action id (a deploy re-minted the ids
 * this page carries: reload once, and still fail this call, since the reloaded page has nothing
 * to resume it with), or any other error status / `error` field.
 */
function failIfRefused(res: Response, data: ActionReply): void {
  if (res.status === 409 && res.headers.get("x-denext-action") === "unknown") {
    reloadOnceForStaleBuild();
    throw new Error("unknown action (the page is from an older build)");
  }
  if (!res.ok || data.error) {
    throw new Error(data.error ?? `server action failed (${res.status})`);
  }
}

/**
 * Encode action arguments for transport. When one argument is a `FormData`, the
 * request is multipart (the form fields ride along) and the other arguments are
 * JSON-encoded in a reserved meta field; otherwise the arguments are sent as
 * JSON. The server's `decodeActionArgs` (src/runtime/server-action.ts) mirrors it.
 *
 * @param args The call's arguments.
 * @param prepare The wire encoder (wire-encode.ts's `prepareWire`).
 * @returns The request body and its headers.
 */
export function encodeActionArgs(
  args: unknown[],
  prepare: Prepare,
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
      body: JSON.stringify(wireEnvelope("args", args, prepare)),
      headers: { "content-type": "application/json" },
    };
  }
  // A copy: the caller's FormData is theirs (it may be read again, or sent again with other
  // arguments, and the server reads the FIRST meta field).
  const fd = new FormData();
  for (const [name, value] of args[fdIndex] as FormData) fd.append(name, value);
  const others = args.map((a, i) => (i === fdIndex ? null : a));
  fd.append(META_FIELD, JSON.stringify({ fdIndex, ...wireEnvelope("others", others, prepare) }));
  return { body: fd, headers: {} };
}

/**
 * `{ [field]: value }` through the wire codec, plus `enc: 1` only when a tag was needed — so
 * a plain-JSON argument list is byte-identical to before and the decoder skips the walk.
 */
function wireEnvelope(field: string, value: unknown, prepare: Prepare): Record<string, unknown> {
  const p = prepare(value);
  return p.tagged ? { [field]: p.value, enc: WIRE_ENC } : { [field]: p.value };
}
