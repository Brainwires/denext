// `.denext/dev.json`: where a running dev server (App Router or SPA) publishes its address,
// so the MCP live tools (`denext_dev_logs`, …) and `denext ui` can find it. Removed on drain.

import { join } from "@std/path";

/**
 * Publish the running dev server's address to `<outDir>/dev.json`.
 *
 * `origin` is the address a reader on THIS machine uses ({@linkcode devOrigin}): a wildcard
 * bind listens on loopback too, so it is published as a loopback address — the MCP tools and
 * `denext ui` accept only a loopback origin from this file. `hostname` is the bind exactly as
 * given (`::1`, unbracketed, when `localhost` resolved to IPv6), so a
 * deliberate `--host 0.0.0.0` is not reported as a loopback-only server, and `devOrigins`
 * lists the other hosts the origin gate lets in (what a device on the LAN can use).
 *
 * @param outDir The project's `.denext` directory.
 * @param devOrigins The extra origins the dev origin gate allows.
 * @param info The address the server listens on.
 * @param token The session token of a non-loopback bind, if any.
 */
export function writeDevInfo(
  outDir: string,
  devOrigins: readonly string[],
  info: { hostname: string; port: number },
  token?: string,
): void {
  try {
    Deno.mkdirSync(outDir, { recursive: true });
    Deno.writeTextFileSync(
      join(outDir, "dev.json"),
      JSON.stringify({
        origin: devOrigin(info),
        port: info.port,
        hostname: info.hostname,
        devOrigins,
        pid: Deno.pid,
        startedAt: Date.now(),
        // A non-loopback bind's session token, so `denext mobile dev` / `desktop dev` can attach
        // to this server (the file is the developer's own; `/_denext/@fs` never serves it).
        ...(token ? { token } : {}),
      }),
    );
  } catch { /* best-effort — a read-only FS just means no MCP discovery */ }
}

/**
 * The origin a reader on this machine reaches a listener at: a wildcard bind becomes its
 * family's loopback (`0.0.0.0` → `127.0.0.1`, `::` → `[::1]`, which a `::` listener always
 * accepts — an IPv4 connection to it depends on the OS's dual-stack setting), and an IPv6
 * host is bracketed, as a URL requires (`http://::1:5199` is not one; `http://[::1]:5199` is).
 *
 * @param info The address the server listens on, as `Deno.serve`'s `onListen` reports it.
 * @returns `http://<host>:<port>`.
 */
function devOrigin(info: { hostname: string; port: number }): string {
  const name = info.hostname;
  const host = WILDCARD_LOOPBACK.get(name) ??
    (name.includes(":") && !name.startsWith("[") ? `[${name}]` : name);
  return `http://${host}:${info.port}`;
}

/** A wildcard bind's loopback, per address family. */
const WILDCARD_LOOPBACK: ReadonlyMap<string, string> = new Map([
  ["0.0.0.0", "127.0.0.1"],
  ["::", "[::1]"],
]);

/**
 * Remove `<outDir>/dev.json` (idempotent).
 *
 * @param outDir The project's `.denext` directory.
 */
export function removeDevInfo(outDir: string): void {
  try {
    Deno.removeSync(join(outDir, "dev.json"));
  } catch { /* already gone */ }
}
