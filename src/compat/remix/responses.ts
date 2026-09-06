// The isomorphic Remix data helpers: `json()`, `redirect()`, `replace()`, `redirectDocument()`,
// `data()`. Pure `Response`/value constructors with no server dependency, so BOTH runtimes
// export them — `@remix-run/react` re-exports them for client code (an action module may
// `import { redirect } from "@remix-run/react"`), and `@remix-run/node` is where server
// code gets them. The server runtime is what interprets them (a returned/thrown redirect
// becomes denext's redirect signal, `data()`'s init is applied to the response).

/** Remix `json()` — a JSON `Response` (unwrapped back to its value by {@link runLoader}). */
export function json<T>(data: T, init?: number | ResponseInit): Response {
  const responseInit: ResponseInit = typeof init === "number" ? { status: init } : { ...init };
  const headers = new Headers(responseInit.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...responseInit, headers });
}

/** Remix `redirect()` — a redirect `Response` (turned into a denext redirect by the runner). */
export function redirect(url: string, init?: number | ResponseInit): Response {
  const responseInit: ResponseInit = typeof init === "number" ? { status: init } : { ...init };
  const status = responseInit.status ?? 302;
  const headers = new Headers(responseInit.headers);
  headers.set("Location", url);
  return new Response(null, { ...responseInit, status, headers });
}

/** Response header carrying a redirect's soft-nav history mode (Remix `replace()`). */
export const REDIRECT_MODE_HEADER = "x-denext-redirect-mode";

/**
 * Remix `replace()` — like {@link redirect}, but a client soft navigation REPLACES the
 * current history entry instead of pushing one (e.g. after a login you don't want in the
 * back stack). Marks the redirect `Response` so the runner threads
 * {@link RedirectType.replace} to the client (which then uses `location.replace`). On a
 * full document load it's a normal HTTP redirect, exactly like `redirect()`.
 */
export function replace(url: string, init?: number | ResponseInit): Response {
  const res = redirect(url, init);
  res.headers.set(REDIRECT_MODE_HEADER, "replace");
  return res;
}

/**
 * Remix `redirectDocument()` — a redirect the client follows with a full document load
 * (`X-Remix-Reload-Document`), not a soft navigation.
 */
export function redirectDocument(url: string, init?: number | ResponseInit): Response {
  const res = redirect(url, init);
  res.headers.set("x-remix-reload-document", "true");
  return res;
}

/**
 * Remix `DataWithResponseInit` — the wrapper {@link data} returns: a value plus an optional
 * `ResponseInit`. Unlike {@link json} it does NOT serialize the value to a body — the runner
 * passes `data` through as the loader/action value (so `useLoaderData`/`useActionData` see it
 * as-is) and applies `init`'s status/headers to the response.
 */
export class DataWithResponseInit<D> {
  readonly type = "DataWithResponseInit" as const;
  constructor(readonly data: D, readonly init: ResponseInit | null) {}
}

/**
 * Remix `data()` — return a value with a custom status/headers without forcing JSON
 * serialization (the single-fetch-friendly alternative to {@link json}). The value reaches
 * `useLoaderData`/`useActionData` unchanged; the runner applies `init.status`/`init.headers`.
 */
export function data<D>(value: D, init?: number | ResponseInit): DataWithResponseInit<D> {
  return new DataWithResponseInit(
    value,
    typeof init === "number" ? { status: init } : (init ?? null),
  );
}
