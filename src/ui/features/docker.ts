// `/docker` — Docker configuration: regenerate the Dockerfile / compose file / .dockerignore
// with options, showing a diff before anything is overwritten.
//
// STUB — J8 replaces this module.

import { stubHandler, type UiHandler } from "../html.ts";

/** Serve the Docker panel. */
export const dockerPanel: UiHandler = stubHandler({
  title: "Docker",
  lead: "Regenerate the Dockerfile, compose file and .dockerignore, with a diff before writing.",
  job: "J8",
});
