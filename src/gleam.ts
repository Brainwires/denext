/**
 * The optional `gleam()` plugin: compile the app's Gleam project to JavaScript at `denext dev`
 * startup, whenever a `.gleam` file or `gleam.toml` changes, and at `denext build` / `export`, so
 * TypeScript imports it typed through the `@gleam/` import-map prefix.
 *
 * ```ts
 * // denext.config.ts
 * import { gleam } from "denext/gleam";
 * export default { plugins: [gleam()] };
 * ```
 *
 * ```ts
 * // app/page.tsx
 * import { greet } from "@gleam/app/app.mjs"; // typed from Gleam's .d.mts
 * ```
 *
 * When `gleam` is not installed the plugin says so once and skips the compile (the last compiled
 * output, if any, keeps working); an app with no Gleam project is left alone. A compile error fails
 * the step. `denext add gleam:<package>` creates the project and the import-map entry.
 *
 * @module
 */

import type { DenextPlugin } from "./plugin/mod.ts";
import { type GleamOptions, gleamPlugin } from "./build/gleam.ts";

export type { GleamOptions } from "./build/gleam.ts";

/**
 * The Gleam build plugin. Registers a prepare step that runs `gleam build --target javascript` in
 * the Gleam project (`gleam.toml` at the app root, else `gleam/`, or `options.dir`).
 *
 * @param options The project directory and the `gleam` executable.
 * @returns The plugin, for `plugins: [gleam()]`.
 */
export function gleam(options: GleamOptions = {}): DenextPlugin {
  return gleamPlugin(options);
}
