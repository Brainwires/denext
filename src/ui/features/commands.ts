// `/commands` — project command plug-ins: the verbs this project contributes through
// `commands:` in denext.config.ts or a plugin's `addCommand`, runnable from the browser with
// their output streamed back.
//
// STUB — J10 replaces this module.

import { stubHandler, type UiHandler } from "../html.ts";

/** Serve the project-commands panel. */
export const commandsPanel: UiHandler = stubHandler({
  title: "Commands",
  lead: "Run this project's own denext verbs — from denext.config.ts or a plugin's addCommand.",
  job: "J10",
});
