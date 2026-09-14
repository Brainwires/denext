// `/plugins` — the plugin manager: the first-party catalog, what this project already has wired
// into `denext.config.ts`, and add/remove over `deno add` + `injectPlugin`/`ejectPlugin`.
//
// STUB — J6 replaces this module.

import { stubHandler, type UiHandler } from "../html.ts";

/** Serve the plugin-manager panel. */
export const pluginsPanel: UiHandler = stubHandler({
  title: "Plugins",
  lead: "Browse the first-party plugin catalog and add or remove plugins from denext.config.ts.",
  job: "J6",
});
