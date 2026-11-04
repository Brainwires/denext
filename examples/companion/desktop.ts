// Entry for `deno desktop`: serves the static export in `out/` inside Loopy's small window, then
// opens Loopy's inbox — a loopback HTTP endpoint other programs post messages to
// (`POST /api/loopy/say`, token in the inbox file; see inbox/). A message is pushed down the page's
// desktop event stream (`onDesktopEvent("loopy", "say", …)` in app/companion.tsx); a button press
// comes back on the window's own origin (`POST /_loopy/reply`).
//
// The window settings (a transparent, frameless, non-activating overlay on every Space, no Dock
// icon) and the tray come from `desktop.*` in denext.config.ts through `.deno-desktop/config.json`,
// the runtime part of the config every export and `denext desktop` command rewrites, so the config
// module is never compiled into the app.
import config from "./.deno-desktop/config.json" with { type: "json" };
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";
import { inboxFilePath } from "./inbox/paths.ts";
import { DEFAULT_PORT, type Inbox, REPLY_PATH, replyResponse, startInbox } from "./inbox/server.ts";

const resolved = await resolveDesktopCapabilities(config, { base: import.meta.url });
let inbox: Inbox | undefined;

const app = await runDesktop({
  importMetaUrl: import.meta.url,
  ...resolved,
  onRequest: (request, url) =>
    url.pathname === REPLY_PATH ? replyResponse(request, inbox?.replies) : null,
});

// The tray (`desktop.tray`) is the way back with no Dock icon: show or hide Loopy's window.
app.tray?.onMenuItem((id) => {
  const loopy = app.windows.get("main");
  if (id === "show") loopy?.show();
  else if (id === "hide") loopy?.hide();
});

if (!app.sidecarChild) {
  const port = Number(Deno.env.get("LOOPY_PORT") ?? DEFAULT_PORT);
  inbox = await startInbox({
    file: inboxFilePath(),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    deliver: (message) => app.emit("loopy", "say", message),
  });
  console.log(`loopy: inbox at ${inbox.url}/api/loopy/say (token in ${inbox.file})`);
}
