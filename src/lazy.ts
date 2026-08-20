/**
 * # denext/lazy — deferred island hydration bootstrap
 *
 * The runtime that hydrates `client:*` islands on their strategy (load / idle /
 * visible / interaction). It is a **separate entrypoint**, dynamically imported by
 * the generated Flight client entry only when a page actually carries lazy islands,
 * so an app that never defers hydration bundles none of it — the framework stays
 * tiny by default (the same discipline as `denext/live`).
 *
 * `bootResumability` is called by the generated Flight entry, not by app code.
 *
 * @module
 */

export { bootResumability } from "./client/lazy-boot.ts";
