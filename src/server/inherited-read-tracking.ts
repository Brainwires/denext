// Tracks a route handler's reads of the request it inherited from its caller — a self-call
// (the typed client called during a render, see `sub-request.ts`) runs under the visitor's own
// cookie, authorization and client headers. A handler that reads any of them answers per
// visitor, exactly like a page that calls `headers()`: the caller's render must not be stored
// for other visitors. `cookies()` / `headers()` already mark a render dynamic; this catches the
// raw reads (`request.headers.get("cookie")`, `has`, iteration, `forEach`, a `NextRequest`'s
// `cookies`). Reads the framework itself makes while routing go to the untracked original
// request; only the request handed to the handler is tracked. The app's own `middleware.ts`
// runs inside the self-call too, and what it reads it can hand on (a rewrite, a request header
// it sets): its handler's request is tracked the same way, and so is a matcher's `has` /
// `missing` condition on an inherited header or the cookie.

import { copyRemoteAddr } from "./remote-addr.ts";
import {
  currentContext,
  markInheritedRequestRead,
  type RequestContext,
} from "./request-context.ts";
import { SUB_REQUEST_HEADER_ALLOWLIST } from "./sub-request.ts";

/** The `Headers` read methods that reveal a value or presence. */
const NAMED_READS = new Set(["get", "has", "getSetCookie"]);
/** The `Headers` read methods that enumerate every header. */
const ENUMERATING_READS = new Set(["entries", "keys", "values", "forEach"]);

/**
 * `headers` with every read of an inherited header (by name, or by enumerating a set that holds
 * one) reported to `onRead` first. The report may throw (a prerender postpones), aborting the
 * read before it returns anything.
 */
function trackedHeaders(
  headers: Headers,
  inherited: ReadonlySet<string>,
  onRead: (api: string) => void,
): Headers {
  const holdsInherited = () => [...inherited].some((name) => headers.has(name));
  return new Proxy(headers, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (typeof prop === "string" && NAMED_READS.has(prop)) {
        return (name: string, ...rest: unknown[]) => {
          if (inherited.has(String(name).toLowerCase())) onRead("headers");
          return value.call(target, name, ...rest);
        };
      }
      if (
        (typeof prop === "string" && ENUMERATING_READS.has(prop)) || prop === Symbol.iterator
      ) {
        return (...args: unknown[]) => {
          if (holdsInherited()) onRead("headers");
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
}

/** A `NextRequest`'s cookie jar whose every read reports to `onRead` first. */
function trackedCookies(jar: object, onRead: (api: string) => void): object {
  return new Proxy(jar, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "size") onRead("cookies");
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        onRead("cookies");
        return value.apply(target, args);
      };
    },
  });
}

/**
 * Make `request`'s reads of the headers in `inherited` (and of a `NextRequest`'s `cookies`)
 * count as the handler reading the visitor's request. Mutates and returns `request`.
 *
 * @param request The request handed to the route handler.
 * @param inherited The lower-case names the self-call inherited from its caller.
 * @returns The same request.
 */
export function trackInheritedReads(request: Request, inherited: ReadonlySet<string>): Request {
  const headers = trackedHeaders(request.headers, inherited, markInheritedRequestRead);
  Object.defineProperty(request, "headers", { value: headers, configurable: true });
  const jar = (request as { cookies?: unknown }).cookies;
  if (jar && typeof jar === "object") {
    Object.defineProperty(request, "cookies", {
      value: trackedCookies(jar, markInheritedRequestRead),
      configurable: true,
    });
  }
  return request;
}

/**
 * The lower-case names a self-call inherited from its caller (the sub-request allowlist plus
 * the app's `rateLimitHeader`), or `null` outside a self-call.
 *
 * @param ctx The request context (the current one by default).
 * @returns The inherited names, or `null`.
 */
export function selfCallInheritedHeaders(
  ctx: RequestContext | undefined = currentContext(),
): ReadonlySet<string> | null {
  if (!ctx?.subRequestDepth) return null;
  const inherited = new Set<string>(SUB_REQUEST_HEADER_ALLOWLIST);
  const limitHeader = ctx.limitPolicy?.header;
  if (limitHeader) inherited.add(limitHeader.toLowerCase());
  return inherited;
}

/**
 * The request a middleware handler receives inside a self-call: its own copy (so the
 * framework's later reads of the routed request stay untracked) whose reads of an inherited
 * header count as the visitor's request read. Outside a self-call, `handed` as is.
 *
 * @param original The request the pipeline routes.
 * @param handed What the handler would receive (`original`, or its `NextRequest` adaptation).
 * @returns The request to hand the handler.
 */
export function trackMiddlewareReads(original: Request, handed: Request): Request {
  const inherited = selfCallInheritedHeaders();
  if (!inherited) return handed;
  let own = handed;
  if (own === original) {
    own = original.body ? original.clone() : new Request(original);
    copyRemoteAddr(original, own);
  }
  return trackInheritedReads(own, inherited);
}

/**
 * A middleware matcher condition read header `name` (`cookie` for a cookie condition): inside
 * a self-call, when that header was inherited, the caller's render is per-visitor.
 *
 * @param name The header the condition reads.
 */
export function noteMatcherHeaderRead(name: string): void {
  const lower = name.toLowerCase();
  if (selfCallInheritedHeaders()?.has(lower)) {
    markInheritedRequestRead(lower === "cookie" ? "cookies" : "headers");
  }
}
