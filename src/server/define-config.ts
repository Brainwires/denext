import type { DenextConfig } from "./config.ts";

/**
 * Identity helper that gives a `denext.config.ts` full editor autocomplete and inline
 * type-checking — the idiomatic way to author config (like Vite's `defineConfig`):
 *
 * ```ts
 * // denext.config.ts
 * import { defineConfig } from "denext/server";
 *
 * export default defineConfig({
 *   basePath: "/app",
 *   cache: { store: "sqlite" },
 * });
 * ```
 *
 * A misspelled or wrongly-typed field is a compile error at the config site, and every
 * field completes as you type — no separate schema to keep in sync (the {@link DenextConfig}
 * type _is_ the schema).
 *
 * @param config The project configuration.
 * @returns The same object, typed as {@link DenextConfig}.
 */
export function defineConfig(config: DenextConfig): DenextConfig {
  return config;
}
