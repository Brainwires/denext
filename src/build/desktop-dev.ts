// `denext desktop dev`: live reload for the Deno Desktop window against a running `denext dev`
// (the "Metro model" for desktop).
//
// The desktop window's local runtime reverse-proxies EVERYTHING (HTTP + the HMR WebSocket) to the
// dev server, so `location.origin` stays loopback and neither the CSP nor the dev origin gate has
// to be relaxed. `denext desktop dev` starts a `denext dev` server (or attaches to one already
// answering at the target), then spawns `deno desktop <entry>` with `DENEXT_DESKTOP_DEV_URL` set —
// the dev-only env seam that puts the runtime into proxy mode (see `runDesktop` in `desktop.ts`).
//
// SECURITY: the proxy-all path is reachable ONLY through that env seam, which ONLY this verb sets;
// the target must be loopback unless `--lan` opts in (mirroring `denext dev --lan`); the per-launch
// desktop token is stripped before proxying so it never reaches the dev server; and the dev server
// is stopped on exit ONLY when this verb started it (an attached one is left running).
//
// Every process-touching edge is injected ({@linkcode DesktopDevDeps}) so tests never spawn a real
// dev server or a window. The verb needs no config editing (unlike `mobile dev` there is no
// Capacitor config to point at the server), so this is much simpler than `mobile-dev.ts`.

import { isLoopbackHost, pickLanAddress } from "./dev-server/lan.ts";

/** A `denext dev` server `desktop dev` started or attached to. */
export interface DesktopDevServer {
  /** The loopback URL the window's runtime proxies to (`http://localhost:3000`). */
  readonly url: string;
  /** True when a server was already answering there (it is left running on exit — invariant 5). */
  readonly attached: boolean;
  /** Resolves when the server ends by itself. */
  readonly finished: Promise<void>;
  /** Stop the server. */
  stop(): Promise<void>;
}

/** The `deno desktop <entry>` child process, in proxy mode. */
export interface DesktopWindow {
  /** Resolves when the window process exits (window closed, or killed). */
  readonly finished: Promise<void>;
  /** Stop the window process. */
  stop(): Promise<void>;
}

/** The edges of {@linkcode runDesktopDev}, injected so tests never spawn a server or a window. */
export interface DesktopDevDeps {
  /** Start `denext dev`, or attach to one already answering at the loopback target. */
  readonly startServer: () => Promise<DesktopDevServer>;
  /** Spawn `deno desktop <entry>` with `DENEXT_DESKTOP_DEV_URL` set to `devUrl` (proxy mode). */
  readonly spawnWindow: (devUrl: string) => Promise<DesktopWindow>;
  /** Resolves when the developer stops the session (Ctrl-C / SIGTERM). */
  readonly waitForStop: () => Promise<void>;
  /** Progress output. */
  readonly log: (line: string) => void;
}

/** Where `desktop dev` binds the dev server and the loopback URL the window proxies to. */
export interface DesktopDevTargetInput {
  /** `--lan`: attach to / bind a non-loopback address (the explicit opt-in for a LAN target). */
  readonly lan?: boolean;
  /** `--host`: the host to bind and proxy to (default `localhost`); refused non-loopback sans `--lan`. */
  readonly host?: string;
  /** `--port`: the dev server port. */
  readonly port: number;
}

/**
 * The host `desktop dev` targets and the URL the window proxies to. `--lan` picks the LAN IPv4
 * (attach to a dev server elsewhere on the network); else `--host`; else loopback. A non-loopback
 * host without `--lan` is REFUSED (invariant 3): the desktop window and its dev server normally run
 * on the same machine, so the target is loopback, and reaching a dev server over the network
 * exposes the app and its source to anyone who can reach it.
 *
 * @param input The `--lan` / `--host` / `--port` selection.
 * @param pickLan The LAN IPv4 picker (default {@link pickLanAddress}; injected in tests).
 * @returns The bound host and the proxy URL.
 * @throws {Error} On `--lan` with `--host`, `--lan` with no LAN IPv4, or a non-loopback host
 * without `--lan`.
 */
export function desktopDevTarget(
  input: DesktopDevTargetInput,
  pickLan: () => string | null = pickLanAddress,
): { host: string; url: string } {
  const { lan, host: flagHost, port } = input;
  if (lan && flagHost !== undefined) {
    throw new Error("denext desktop dev: --lan picks the address itself; drop --host.");
  }
  const lanAddr = lan ? pickLan() : null;
  if (lan && !lanAddr) {
    throw new Error(
      "denext desktop dev --lan: this machine has no LAN IPv4 address (is Wi-Fi on?).",
    );
  }
  const host = lan ? lanAddr! : flagHost ?? "localhost";
  if (!lan && !isLoopbackHost(host)) {
    throw new Error(
      `denext desktop dev: refusing a non-loopback dev server target "${host}". The desktop ` +
        "window and the dev server normally run on the same machine, so the target is loopback. " +
        "Pass --lan to attach to a dev server elsewhere on your network — anyone who can reach it " +
        "can load your app and its source.",
    );
  }
  const shown = host.includes(":") ? `[${host}]` : host;
  return { host, url: `http://${shown}:${port}` };
}

/** The banner printed once the window is opening. */
function desktopDevBanner(server: DesktopDevServer): string {
  return [
    "",
    `  denext desktop dev  ▸  the window loads ${server.url}` +
    (server.attached ? " (attached to the running dev server)" : ""),
    "",
    "  Edits hot-reload in the native window (HTTP + HMR proxy to the dev server).",
    server.attached
      ? "  Ctrl-C stops the window; the attached dev server keeps running."
      : "  Ctrl-C stops the window and the dev server it started.",
    "",
  ].join("\n");
}

/**
 * Drive one `denext desktop dev` session: start (or attach to) the dev server, open the window in
 * proxy mode, and run until the developer stops it, the window closes, or the dev server ends.
 * On exit the window is always stopped, and the dev server is stopped ONLY when this verb started
 * it (an attached one is left running — invariant 5).
 *
 * @param deps The process-touching edges (a real dev server / window in the CLI, fakes in tests).
 */
export async function runDesktopDev(deps: DesktopDevDeps): Promise<void> {
  // Listen for Ctrl-C from the start, so one pressed during startup still ends the session.
  const stopped = deps.waitForStop();
  const server = await deps.startServer();
  try {
    deps.log(desktopDevBanner(server));
    const window = await deps.spawnWindow(server.url);
    try {
      await Promise.race([stopped, window.finished, server.finished]);
    } finally {
      await window.stop();
    }
  } finally {
    // Stop the dev server only if we started it; an attached one is left running.
    if (!server.attached) await server.stop();
  }
}
