// A browser for the `next-auth` shim's tests: a cookie jar over `Set-Cookie`, requests to the
// app's origin (an `Origin` on every non-GET unless told otherwise), and a request context to run
// a handler or server-side call in, its cookies merged into the jar.

import {
  createRequestContext,
  runDeferred,
  runWithContext,
} from "../../src/server/request-context.ts";

/** The test app's origin. */
export const ORIGIN = "https://app.test";

/** A cookie jar over `Set-Cookie` headers. */
export class Jar {
  cookies = new Map<string, string>();
  take(headers: Headers): void {
    for (const line of headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === "";
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

export interface CallInit {
  method?: string;
  form?: Record<string, string>;
  json?: unknown;
  origin?: string | null;
  headers?: Record<string, string>;
}

/** Run `fn` inside a request context for `request`, merging its cookies into the answer. */
export async function inRequest<T>(
  request: Request,
  jar: Jar,
  fn: () => Promise<T>,
): Promise<{ value?: T; error?: unknown; cookies: Headers }> {
  const ctx = createRequestContext(request);
  let value: T | undefined;
  let error: unknown;
  try {
    value = await runWithContext(ctx, fn);
  } catch (err) {
    error = err;
  }
  await runDeferred(ctx);
  jar.take(ctx.outgoingHeaders);
  return { value, error, cookies: ctx.outgoingHeaders };
}

/** A request body and its content type. */
function bodyOf(init: CallInit): { type?: string; body?: BodyInit } {
  if (init.form) {
    return { type: "application/x-www-form-urlencoded", body: new URLSearchParams(init.form) };
  }
  if (init.json === undefined) return {};
  return { type: "application/json", body: JSON.stringify(init.json) };
}

/** Build a request to the app. */
export function request(jar: Jar, path: string, init: CallInit = {}): Request {
  const headers = new Headers({ host: "app.test", ...(init.headers ?? {}) });
  if (jar.cookies.size) headers.set("cookie", jar.header());
  const { type, body } = bodyOf(init);
  if (type) headers.set("content-type", type);
  const method = init.method ?? (body ? "POST" : "GET");
  if (method !== "GET" && init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
  return new Request(`${ORIGIN}${path}`, { method, headers, body });
}
