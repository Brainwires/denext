// Where to go after a sign-in step. `callbackUrl` arrives in a query string, so it is
// attacker-supplied: only a same-origin path is honoured, never `//evil.example` or a URL.

/**
 * The post-sign-in target: `raw` when it is a same-origin path, else the dashboard.
 *
 * @param raw The `callbackUrl` query value (absent, one value, or repeated).
 * @returns A path on this origin.
 */
export function safeCallback(raw: string | string[] | undefined): string {
  return typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//")
    ? raw
    : "/dashboard";
}
