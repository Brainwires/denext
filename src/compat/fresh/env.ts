/**
 * `denext/fresh/env` — Vite's `import.meta.env` for a migrated Fresh app, in server and browser
 * code alike. `denext migrate --from fresh` rewrites the app's `import.meta.env` (and, in
 * islands, Fresh's inlined `Deno.env.get("FRESH_PUBLIC_…")` / `process.env.FRESH_PUBLIC_…`) to
 * this module's {@link env}.
 *
 * It holds Vite's mode flags (`MODE`, `DEV`, `PROD`, `SSR`, `BASE_URL`) and the public
 * variables only — those named `FRESH_PUBLIC_*`, `DENEXT_PUBLIC_*` or `NEXT_PUBLIC_*` — on the
 * server as in the browser, where they come from the page's public-env island (a production
 * build ships the ones its client code names). A server-only variable is never in it: read
 * those with `Deno.env.get()` in server code.
 *
 * @module
 */

import { publicEnv } from "../../runtime/public-env.ts";

/** Vite's `import.meta.env`: the mode flags, then the public variables by name. */
export interface ImportMetaEnv {
  /** `"development"` under `denext dev`, else `"production"`. */
  readonly MODE: string;
  /** Running under `denext dev`. */
  readonly DEV: boolean;
  /** Not running under `denext dev`. */
  readonly PROD: boolean;
  /** Running on the server (rendering), not in the browser. */
  readonly SSR: boolean;
  /** The base URL the app is served under. */
  readonly BASE_URL: string;
  /** A public variable (`FRESH_PUBLIC_*`, `DENEXT_PUBLIC_*`, `NEXT_PUBLIC_*`). */
  readonly [name: string]: string | boolean | undefined;
}

/** The browser's public variables, read from the page once. */
let clientVars: Record<string, string> | undefined;

/** The current values: the public variables, then the mode flags. */
function snapshot(): Record<string, string | boolean> {
  const ssr = typeof document === "undefined";
  const vars = ssr ? publicEnv() : (clientVars ??= publicEnv());
  const dev = (globalThis as { __denextDev?: boolean }).__denextDev === true;
  return {
    ...vars,
    MODE: dev ? "development" : "production",
    DEV: dev,
    PROD: !dev,
    SSR: ssr,
    BASE_URL: "/",
  };
}

/**
 * Vite's `import.meta.env`, read live: each property read (and a spread or `JSON.stringify` of
 * the whole) sees the current mode and public variables.
 */
export const env: ImportMetaEnv = new Proxy({} as ImportMetaEnv, {
  get: (_target, name) => typeof name === "string" ? snapshot()[name] : undefined,
  has: (_target, name) => typeof name === "string" && name in snapshot(),
  ownKeys: () => Object.keys(snapshot()),
  getOwnPropertyDescriptor: (_target, name) => {
    const values = snapshot();
    if (typeof name !== "string" || !(name in values)) return undefined;
    return { value: values[name], enumerable: true, configurable: true, writable: false };
  },
});
