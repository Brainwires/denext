// A strict loopback-host test, shared so there is ONE definition used both where looseness is
// harmless (skipping LAN candidates) and where it is a SECURITY gate (deciding whether a URL may
// be proxied to / trusted with the desktop token). See `isLoopbackHost`.

/**
 * Whether `host` is a loopback host: `localhost`, `::1` (bracketed or not), or the WHOLE
 * `127.0.0.0/8` block — and NOTHING else.
 *
 * Deliberately NOT a `127.` prefix or a `.localhost` suffix: `127.0.0.1.evil.com` and
 * `foo.localhost` are ordinary DNS names that can resolve to an attacker's address, so accepting
 * them in a security gate would let a hostile `DENEXT_DESKTOP_DEV_URL` (or `--host`) be treated as
 * local — proxied to, and handed the per-launch desktop token. Host comparison is
 * case-insensitive; surrounding `[ ]` (an IPv6 literal) are stripped first.
 *
 * @param host A URL hostname (e.g. from `new URL(url).hostname`).
 * @returns `true` only for a genuine loopback host.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}
