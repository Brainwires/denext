// Entry for `deno desktop`: serves the static export in `out/` inside a native window. The serve +
// window + capability-bridge plumbing lives in denext's desktop runtime; the native capabilities
// come from `desktop.capabilities` in the config (default deny), through `.deno-desktop/config.json`
// (the runtime part of denext.config.ts that every export and `denext desktop` command rewrites),
// so the config module is never compiled into the app.
import config from "./.deno-desktop/config.json" with { type: "json" };
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";

/** The WebSocket the "websocket relay" check dials: answers with the `Origin` it was opened with. */
const ECHO_SOCKET_PATH = "/_kitchen/ws";

await runDesktop({
  importMetaUrl: import.meta.url,
  ...(await resolveDesktopCapabilities(config, { base: import.meta.url })),
  // Reached only through the runtime's loopback relay (the page's custom origin carries no
  // WebSockets), and only after the desktop runtime checked the exact app `Origin`.
  onRequest: (request, url) => {
    if (url.pathname !== ECHO_SOCKET_PATH) return null;
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return null;
    const origin = request.headers.get("origin");
    const { socket, response } = Deno.upgradeWebSocket(request);
    socket.onopen = () => socket.send(JSON.stringify({ origin }));
    return response;
  },
});
