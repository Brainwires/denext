// Entry for `deno desktop`: serves the static export in `out/` inside a native window. The serve +
// window + capability-bridge plumbing lives in denext's desktop runtime; the native capabilities
// come from `desktop.capabilities` in the config (default deny), through `.deno-desktop/config.json`
// (the runtime part of denext.config.ts that every export and `denext desktop` command rewrites),
// so the config module is never compiled into the app.
import config from "./.deno-desktop/config.json" with { type: "json" };
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";
import { ATTACHMENT_PATH, attachmentResponse } from "./app/downloads.ts";
import { standInBrowser } from "./desktop/browser-stand-in.ts";
import {
  hookLog,
  HOOKS_ENV,
  navigation,
  runtimeNotifier,
  secondInstanceRecorder,
  windowMenuRecorder,
  withHooksMenu,
} from "./desktop/hooks.ts";

/** The WebSocket the "websocket relay" check dials: answers with the `Origin` it was opened with. */
const ECHO_SOCKET_PATH = "/_kitchen/ws";

/**
 * The window test's hooks launch (KITCHEN_SINK_HOOKS=1, see desktop/hooks.ts): a Window-menu item
 * of the app's own (`desktop.menu.window.items`, through the config as an app would set it) and
 * the backend hooks, each recording what it saw for the page to check. Other launches have none.
 */
function hooksLaunch(): boolean {
  try {
    return Deno.env.get(HOOKS_ENV) === "1";
  } catch {
    return false; // no env permission
  }
}

const hooks = hooksLaunch();

const runtime = await runDesktop({
  importMetaUrl: import.meta.url,
  ...(await resolveDesktopCapabilities(hooks ? withHooksMenu(config) : config, {
    base: import.meta.url,
  })),
  ...(hooks
    ? {
      onWindowMenuItem: windowMenuRecorder(hookLog, "runDesktop"),
      onSecondInstance: secondInstanceRecorder(hookLog, "runDesktop"),
      onWillNavigate: navigation.handler,
    }
    : {}),
  // On Windows the window test's stand-in browser is in-process (see browser-stand-in.ts).
  openBrowser: standInBrowser(),
  // Reached only through the runtime's loopback relay (the page's custom origin carries no
  // WebSockets), and only after the desktop runtime checked the exact app `Origin`.
  // The download checks' `Content-Disposition: attachment` response, from the app's own origin.
  onRequest: (request, url) => {
    if (url.pathname === ATTACHMENT_PATH) return attachmentResponse();
    if (url.pathname !== ECHO_SOCKET_PATH) return null;
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return null;
    const origin = request.headers.get("origin");
    const { socket, response } = Deno.upgradeWebSocket(request);
    socket.onopen = () => socket.send(JSON.stringify({ origin }));
    return response;
  },
});

// The hooks launch's `notify` check posts through this result's `notify` too (desktop/hooks.ts).
if (hooks) runtimeNotifier.notify = runtime.notify;
