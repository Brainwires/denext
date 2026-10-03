// Entry for Deno Desktop: serves the static export (`out/`) in a native window. The page is the
// same app as the web; its `/api/*` calls go to the web server (DENEXT_CLERK_API_ORIGIN, default
// the local `deno task start` at http://127.0.0.1:3000), which verifies the bearer session token.
import config from "./denext.config.ts";
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";

/** Where the protected API runs. */
function apiOrigin(): string {
  try {
    return Deno.env.get("DENEXT_CLERK_API_ORIGIN") || "http://127.0.0.1:3000";
  } catch {
    return "http://127.0.0.1:3000";
  }
}

const target = apiOrigin();
const loopback = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(target);

await runDesktop({
  importMetaUrl: import.meta.url,
  proxy: { prefixes: ["/api"], target, allowNonLoopback: !loopback },
  ...(await resolveDesktopCapabilities(config, { base: import.meta.url })),
});
