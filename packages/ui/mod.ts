/**
 * `@denext/ui` — the web UI behind `denext ui` (the project-management GUI) and `denext dashboard`
 * (the self-hosted stack's database dashboard), with the stack's log relay.
 *
 * You do not import it yourself: `@denext/denext` loads it on the first `denext ui` /
 * `denext dashboard` run through a literal dynamic `import("@denext/ui")`, pinned to exactly the
 * denext version that loads it. It ships as its own package so `@denext/denext` stays clear of
 * JSR's package size cap.
 *
 * Neither server evaluates the project's own modules: every piece of project work goes out as a
 * `deno` / `denext` subprocess.
 *
 * @module
 */

export {
  DEFAULT_UI_PORT,
  startUiServer,
  type UiServer,
  type UiServerOptions,
} from "./src/server.ts";
export { DASH_MIN_PASSWORD } from "./src/dashboard.ts";
export { DEFAULT_RELAY_PORT, startLogsRelay } from "./src/logs/relay.ts";
export { relayToken } from "./src/logs/source.ts";
export { socketGet } from "./src/logs/engine.ts";
export { secretKey } from "./src/app-admin.ts";
