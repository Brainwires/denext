// Public environment variables — the client/server isolation boundary for env.
//
// SECURITY: server code sees the full process environment (`Deno.env`), but the
// browser must only ever receive variables explicitly marked public via a
// recognized prefix. This module is the single gate: only `filterPublicEnv`
// output is embedded in the page, and the client `publicEnv()` reads that
// embedded island — it has no other source, so a non-public secret cannot reach
// the browser through this channel.

/**
 * Prefixes that mark an environment variable as safe to expose to the browser.
 * `NEXT_PUBLIC_` matches Next.js for drop-in compatibility; `DENEXT_PUBLIC_` is
 * the denext-native prefix. Any other variable stays server-only.
 */
export const PUBLIC_ENV_PREFIXES: readonly string[] = ["NEXT_PUBLIC_", "DENEXT_PUBLIC_"];

/** The DOM id of the JSON island holding the public env for client hydration. */
export const PUBLIC_ENV_ID = "__denext_public_env";

/** Is `key` a client-exposable (public-prefixed) environment variable name? */
export function isPublicEnvKey(key: string): boolean {
  return PUBLIC_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * The public (client-exposable) subset of an environment record: only keys with
 * a {@link PUBLIC_ENV_PREFIXES} prefix survive. This is the ONLY function that
 * produces the values embedded in the page, so nothing else can leak.
 *
 * @param env A full environment record (e.g. `Deno.env.toObject()`).
 * @returns The public subset.
 */
export function filterPublicEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (isPublicEnvKey(key)) out[key] = value;
  }
  return out;
}

/**
 * Extract the public-env variable names a piece of client source references
 * literally (`publicEnv().NEXT_PUBLIC_X`, `publicEnv()["NEXT_PUBLIC_X"]`, or the
 * bare token). Used by the build to ship ONLY the referenced public vars in the
 * page island instead of every prefixed one. A fully-computed key
 * (`publicEnv()["NEXT_PUBLIC_" + x]`) can't be seen here — force-include such keys
 * via the `publicEnv` config allowlist.
 *
 * @param source Client JS/TS source (a bundle or module).
 * @returns The distinct referenced public-env names.
 */
export function extractPublicEnvRefs(source: string): string[] {
  const re = /\b(?:NEXT_PUBLIC_|DENEXT_PUBLIC_)[A-Za-z0-9_]+/g;
  return [...new Set(source.match(re) ?? [])];
}

/**
 * Restrict a public-env record to an allowlist of keys (the build's referenced set
 * ∪ the `publicEnv` config). `undefined` keys ⇒ no restriction (ship all, e.g. in
 * dev where there's no build scan).
 *
 * @param env The full public-env subset.
 * @param keys The allowed keys, or undefined for no restriction.
 * @returns The restricted record.
 */
export function restrictPublicEnv(
  env: Record<string, string>,
  keys?: readonly string[],
): Record<string, string> {
  if (!keys) return env;
  const allow = new Set(keys);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (allow.has(k)) out[k] = v;
  }
  return out;
}

/** Read the embedded public-env island (client only). */
function readClientPublicEnv(): Record<string, string> {
  try {
    const el = document.getElementById(PUBLIC_ENV_ID);
    if (!el) return {};
    return JSON.parse(el.textContent ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Read the public environment variables (isomorphic). On the client, returns the
 * variables embedded in the page — only ever the public-prefixed ones. On the
 * server, returns the public subset of the live process environment.
 *
 * Server-only variables are never in the result on either side; read those with
 * `Deno.env.get(...)` in server code. Passing a non-public value to a client
 * component as a prop is still the developer's responsibility (as in Next.js) —
 * this only isolates the env channel itself.
 *
 * @returns A record of public env variables (empty when none are set).
 */
export function publicEnv(): Record<string, string> {
  // Client: the embedded island is the only source (never holds secrets).
  if (typeof document !== "undefined") return readClientPublicEnv();
  // Server: filter the live process environment.
  if (typeof Deno !== "undefined" && Deno.env) return filterPublicEnv(Deno.env.toObject());
  return {};
}
