import type { DenextConfig } from "./config.ts";
import { validateDenextConfig, warnUnknownConfigKeys } from "./config-validate.ts";

/**
 * Validating helper that gives a `denext.config.ts` full editor autocomplete and inline
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
 * Beyond the compile-time types, this also validates at runtime: an **unknown key** (a
 * typo, or a stale Next.js option TypeScript can't catch on a plain object literal cast
 * elsewhere) prints a "did you mean" warning, and a malformed **value** (e.g.
 * `basePath: "docs"` without a leading slash, or a non-finite `images.qualities`) throws
 * a clear, field-scoped error at the config site rather than misbehaving at request time.
 *
 * @param config The project configuration.
 * @returns The same object, typed as {@link DenextConfig}.
 */
export function defineConfig(config: DenextConfig): DenextConfig {
  warnUnknownConfigKeys(config as object);
  validateDenextConfig(config);
  return config;
}
