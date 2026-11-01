// Reaching `denext dev` from another device: which LAN address `--lan` binds, which hosts an
// explicit bind allows through the dev origin gate, and the banner `--lan` prints.
//
// The gate itself (`devOriginAllowed`) refuses every `/_denext/*` request whose `Host` is not
// loopback or listed in `allowedDevOrigins` — the DNS-rebinding defense. Binding a LAN address
// on purpose is the developer saying "devices on this network may load the dev app", so the
// address they bound is added to that list; nothing else is.

import { encodeQr, renderQrTerminal } from "../../utils/qr-code.ts";
// The strict loopback test lives in one place (used as a security gate by `denext desktop dev`).
// Imported for lan.ts's own use AND re-exported so lan.ts's callers keep importing it from here.
import { isLoopbackHost } from "../../utils/loopback.ts";

/** The slice of `Deno.NetworkInterfaceInfo` the selection reads (so tests can inject it). */
export interface LanInterface {
  /** `"IPv4"` or `"IPv6"`. */
  readonly family: string;
  /** The interface name (`en0`, `eth0`, `wlan0`, `utun3`, …). */
  readonly name: string;
  /** The address, without brackets or a zone. */
  readonly address: string;
}

/** Interface names that are the machine's primary Wi-Fi / Ethernet on macOS and Linux. */
const PREFERRED = /^(en0|eth0|wlan\d*|wlp\S*|enp\S*)$/;

/** Tunnel interfaces: a VPN's default route is not the network a phone beside the machine is on. */
const TUNNEL = /^(utun|tun|tap|wg|ppp|ipsec|tailscale|zt)/i;

/** Hostnames that mean "every interface" when bound. */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

export { isLoopbackHost };

/** A usable LAN IPv4: not loopback (127/8), not link-local (169.254/16), not unspecified. */
function isLanIpv4(iface: LanInterface): boolean {
  if (iface.family !== "IPv4") return false;
  const a = iface.address;
  return !a.startsWith("127.") && !a.startsWith("169.254.") && a !== "0.0.0.0";
}

/**
 * The interface a default-route listing names.
 *
 * @param os The OS the listing comes from (`Deno.build.os`).
 * @param listing The output of `route -n get default` (macOS, BSD), `ip -4 route show default`
 *   (Linux) or `route print -4 0.0.0.0` (Windows, which names the interface by its address).
 * @returns The interface name (on Windows its address), or `null` when it lists no default route.
 */
export function parseDefaultRoute(os: string, listing: string): string | null {
  if (os === "linux") return listing.match(/^default\b.*?\bdev\s+(\S+)/m)?.[1] ?? null;
  if (os !== "windows") return listing.match(/^\s*interface:\s*(\S+)/m)?.[1] ?? null;
  // Network, netmask, gateway, interface address, metric: the lowest metric carries the traffic.
  const routes = [...listing.matchAll(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+\S+\s+(\S+)\s+(\d+)\s*$/gm)];
  routes.sort((a, b) => Number(a[2]) - Number(b[2]));
  return routes[0]?.[1] ?? null;
}

/** The OS's own answer to which interface has the default route; `null` when it can't be asked. */
function defaultRouteInterface(): string | null {
  const os = Deno.build.os;
  const [command, ...args] = os === "linux"
    ? ["ip", "-4", "route", "show", "default"]
    : os === "windows"
    ? ["route", "print", "-4", "0.0.0.0"]
    : ["/sbin/route", "-n", "get", "default"];
  try {
    // Never a permission prompt: without --allow-run the name heuristic decides.
    if (Deno.permissions.querySync({ name: "run", command }).state !== "granted") return null;
    const { stdout } = new Deno.Command(command, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    return parseDefaultRoute(os, new TextDecoder().decode(stdout));
  } catch {
    return null;
  }
}

/**
 * The address `denext dev --lan` binds: the machine's LAN IPv4 — the one on the interface with the
 * default route (a multi-homed machine's `en0` may be a lab or VM network no phone is on), unless
 * that is a tunnel; else the primary interface's by name (`en0`, `eth0`, `wlan*`); else the first
 * other non-loopback, non-link-local IPv4 in the order the OS lists them.
 *
 * @param interfaces The machine's interfaces (default: `Deno.networkInterfaces()`).
 * @param defaultRoute The default route's interface, by name or address (default: the OS's answer).
 * @returns The address, or `null` when the machine has no LAN IPv4.
 */
export function pickLanAddress(
  interfaces: readonly LanInterface[] = Deno.networkInterfaces(),
  defaultRoute: () => string | null = defaultRouteInterface,
): string | null {
  const candidates = interfaces.filter(isLanIpv4);
  const route = defaultRoute();
  const routed = candidates.find((i) =>
    (i.name === route || i.address === route) && !TUNNEL.test(i.name)
  );
  return (routed ?? candidates.find((i) => PREFERRED.test(i.name)) ?? candidates[0])?.address ??
    null;
}

/**
 * The hosts an explicit dev-server bind allows through the origin gate.
 *
 * - no host, or a loopback one: nothing (loopback is always allowed);
 * - a wildcard (`0.0.0.0`, `::`): every non-loopback address of this machine — a device on any
 *   of those networks reaches the server by the machine's IP, and an IP literal is not
 *   something a DNS-rebinding page can present as its `Host`;
 * - anything else (a LAN IP, `mac.local`): that host.
 *
 * @param hostname The `--host` the server binds, as given.
 * @param interfaces The machine's interfaces (read only for a wildcard bind).
 * @returns The hosts to add to `allowedDevOrigins`.
 */
export function boundHostOrigins(
  hostname: string | undefined,
  interfaces: () => readonly LanInterface[] = () => Deno.networkInterfaces(),
): string[] {
  if (!hostname || isLoopbackHost(hostname)) return [];
  if (!WILDCARD_HOSTS.has(hostname)) return [hostname.replace(/^\[|\]$/g, "")];
  try {
    return [
      ...new Set(
        interfaces()
          .map((i) => i.address)
          .filter((a) => !isLoopbackHost(a) && !a.startsWith("fe80:")),
      ),
    ];
  } catch {
    return []; // no --allow-sys: the wildcard bind still serves HTML, the gate stays closed
  }
}

/**
 * The effective `allowedDevOrigins` of one `denext dev` run: the config's, the programmatic /
 * `--allowed-dev-origin` ones, and whatever the explicit bind allows — deduplicated.
 *
 * @param lists The configured lists, in any order.
 * @param hostname The bound host, as given.
 * @param interfaces The machine's interfaces (for a wildcard bind).
 * @returns The combined list.
 */
export function effectiveDevOrigins(
  lists: ReadonlyArray<readonly string[] | undefined>,
  hostname: string | undefined,
  interfaces?: () => readonly LanInterface[],
): string[] {
  const all = lists.flatMap((list) => list ?? []);
  return [...new Set([...all, ...boundHostOrigins(hostname, interfaces)])];
}

/**
 * The banner `denext dev --lan` prints once it listens: the URL a device opens, and the same
 * URL as a terminal QR code.
 *
 * @param url The LAN URL (`http://192.168.1.5:3000`).
 * @returns The banner text.
 */
export function lanBanner(url: string): string {
  const qr = renderQrTerminal(encodeQr(url))
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  return `\n  denext dev  ▸  ${url}  (LAN)\n` +
    "  Open it on a device on the same network, or scan:\n\n" +
    `${qr}\n\n` +
    "  Only this address is bound: http://localhost does not answer while --lan is on.\n";
}
