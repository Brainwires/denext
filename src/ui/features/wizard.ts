// `/wizard` — the nine-step setup wizard for a fresh clone: detect the project, check Deno,
// merge deno.json, install dependencies, scan env vars, run doctor, pick features, run tasks,
// start the dev server. Every step is skippable and previews its write.
//
// STUB — J9 replaces this module.

import { stubHandler, type UiHandler } from "../html.ts";

/** Serve the setup wizard. */
export const wizardPanel: UiHandler = stubHandler({
  title: "Wizard",
  lead: "Nine skippable steps that take a fresh clone to a running dev server.",
  job: "J9",
});
