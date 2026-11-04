// Entry for `deno desktop`: the workspace windows. The main window is the "workspace" (its key in
// denext.config.ts, so its frame comes back), a second keyed window opens at launch unless the
// restored session brought it back, New Window / Reopen Closed Window / the window list come from
// `desktop.menu.window`, and New Window's key and page are decided here. The counters (the
// `counters` extension, desktop/counters.ts) are per window and survive a window's close.
import config from "./.deno-desktop/config.json" with { type: "json" };
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";

const caps = await resolveDesktopCapabilities(config, { base: import.meta.url });
const app = await runDesktop({
  importMetaUrl: import.meta.url,
  ...caps,
  // New Window (Cmd/Ctrl+N): a workspace page with the suggested key (`window-N`, the lowest not
  // open, so a window that comes back by that key gets its frame and its counter back).
  newWindow: ({ suggestedKey }) => ({
    url: "/",
    key: suggestedKey,
    title: `Workspace ${suggestedKey.replace("window-", "")}`,
    width: 520,
    height: 360,
  }),
});

if (!app.sidecarChild) {
  // The second window: unless the last session restored it (`desktop.app.restoreWindows`).
  if (!app.windows.byKey("notes")) {
    app.windows.open({ url: "/", key: "notes", title: "Notes", width: 420, height: 320 });
  }
  app.onBeforeQuit(() => {
    console.log(`multiwindow: quitting with ${app.windows.list().length} window(s) open`);
    return true;
  });
}
