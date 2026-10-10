/**
 * # denext/lazy — deferred island hydration bootstrap
 *
 * The runtime that hydrates `client:*` islands on their strategy (load / idle /
 * visible / interaction). It is a **separate entrypoint**, dynamically imported by
 * the generated Flight client entry only when a page actually carries lazy islands,
 * so an app that never defers hydration bundles none of it — the framework stays
 * tiny by default (the same discipline as `denext/live`).
 *
 * `bootResumability` and `resumeEvent` are called by the generated Flight entry, not by app
 * code.
 *
 * @module
 */

export { bootResumability } from "./client/lazy-boot.ts";
// The delegated dispatcher's entry point: a production Flight entry that deferred loading this
// runtime until an island's trigger hands it the events it buffered meanwhile.
export { resumeEvent, type ResumeResult } from "./client/qrl-dispatch.ts";
