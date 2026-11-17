// The page's typed handle on the `rtcviewer` desktop extension (desktop/rtc-viewer.ts). Outside a
// Deno Desktop window (`denext task dev` in a browser) every call rejects with code
// `unavailable`, and the page says so.
import { desktopExtension } from "denext/desktop/client";
import type { AppStats, AppStatus } from "../lib/app.ts";

interface ViewerClient {
  status(args?: Record<never, never>): Promise<AppStatus>;
  stats(args?: Record<never, never>): Promise<AppStats>;
  open(args: { fullscreen: boolean; display?: number }): Promise<null>;
  hide(args?: Record<never, never>): Promise<null>;
}

export const viewer = desktopExtension<ViewerClient>("rtcviewer");
