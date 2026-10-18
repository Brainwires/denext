// Tracks a route handler's reads of the request it inherited from its caller — a self-call
// (the typed client called during a render, see `sub-request.ts`) runs under the visitor's own
// cookie, authorization and client headers. A handler that reads any of them answers per
// visitor, exactly like a page that calls `headers()`: the caller's render must not be stored
// for other visitors. `cookies()` / `headers()` already mark a render dynamic; this catches the
// raw reads (`request.headers.get("cookie")`, `has`, iteration, `forEach`, a `NextRequest`'s
// `cookies`). Reads the framework itself makes while routing go to the untracked original
// request; only the request handed to the handler is tracked.

import { markInheritedRequestRead } from "./request-context.ts";

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
