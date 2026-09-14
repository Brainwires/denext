// `/generate` — a GUI over `denext generate`: pick a kind, name it, preview what would be
// written, then write it.
//
// STUB — J7 replaces this module.

import { stubHandler, type UiHandler } from "../html.ts";

/** Serve the scaffolding panel. */
export const generatePanel: UiHandler = stubHandler({
  title: "Generate",
  lead: "Scaffold a page, route, layout, API handler, component, action, Docker setup and more.",
  job: "J7",
});
