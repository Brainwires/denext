// `.denext/dev.json`: where a running dev server (App Router or SPA) publishes its address,
// so the MCP live tools (`denext_dev_logs`, …) and `denext ui` can find it. Removed on drain.

import { join } from "@std/path";

/**
 * Publish the running dev server's address to `<outDir>/dev.json`.
 *
 * `origin` is the address a reader on THIS machine uses: a wildcard bind (`0.0.0.0`, `::`)
 * listens on loopback too, so it is published as `127.0.0.1` — the MCP tools and `denext ui`
 * accept only a loopback origin from this file. `hostname` is the bind exactly as given, so a
 * deliberate `--host 0.0.0.0` is not reported as a loopback-only server, and `devOrigins`
 * lists the other hosts the origin gate lets in (what a device on the LAN can use).
 *
 * @param outDir The project's `.denext` directory.
 * @param devOrigins The extra origins the dev origin gate allows.
 * @param info The address the server listens on.
 */
export function writeDevInfo(
  outDir: string,
  devOrigins: readonly string[],
  info: { hostname: string; port: number },
): void {
  const wildcard = info.hostname === "0.0.0.0" || info.hostname === "::";
  const host = wildcard ? "127.0.0.1" : info.hostname;
  try {
    Deno.mkdirSync(outDir, { recursive: true });
    Deno.writeTextFileSync(
      join(outDir, "dev.json"),
      JSON.stringify({
        origin: `http://${host}:${info.port}`,
        port: info.port,
        hostname: info.hostname,
        devOrigins,
        pid: Deno.pid,
        startedAt: Date.now(),
      }),
    );
  } catch { /* best-effort — a read-only FS just means no MCP discovery */ }
}

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
