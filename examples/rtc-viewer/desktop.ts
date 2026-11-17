// Entry for `deno desktop` (`denext desktop run` / `package`): serves the static export in out/
// in a native window. The export has no route handlers, so the backend answers the signalling
// hub's requests itself (the same hub as app/api/signal/route.ts): the packaged app's viewer and
// sender pages meet in it. A sender elsewhere joins a hub it can reach instead (`?signal=`).
import config from "./.deno-desktop/config.json" with { type: "json" };
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";
import { sharedHub } from "./lib/signal/shared-hub.ts";

await runDesktop({
  importMetaUrl: import.meta.url,
  ...(await resolveDesktopCapabilities(config, { base: import.meta.url })),
  onRequest: (request, url) => url.pathname === "/api/signal" ? sharedHub().handle(request) : null,
});
