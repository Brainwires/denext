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

/**
 * A free TCP port on loopback: bound on port 0, read and released. Released, another process can
 * bind it before the caller's consumer does, so a caller that hands it on later checks it again
 * with {@linkcode loopbackPortTaken} (see {@linkcode pickFreeLoopbackPort}).
 *
 * @returns The port.
 */
export function freeLoopbackPort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

/**
 * Whether another process holds `port` on loopback: binding it fails with an address in use.
 *
 * @param port The port.
 * @returns `true` when it is taken.
 */
export function loopbackPortTaken(port: number): boolean {
  try {
    Deno.listen({ hostname: "127.0.0.1", port }).close();
    return false;
  } catch (err) {
    return err instanceof Deno.errors.AddrInUse;
  }
}

/**
 * A port from `pick` that no other process holds by now, within `tries` picks.
 *
 * @param pick The picker (default {@linkcode freeLoopbackPort}).
 * @param taken Whether a port is held (default {@linkcode loopbackPortTaken}).
 * @param tries How many picks before giving up.
 * @returns The port, or `undefined` when every pick was taken.
 */
export function pickFreeLoopbackPort(
  pick: () => number = freeLoopbackPort,
  taken: (port: number) => boolean = loopbackPortTaken,
  tries = 5,
): number | undefined {
  for (let i = 0; i < tries; i++) {
    const port = pick();
    if (!taken(port)) return port;
  }
  return undefined;
}
