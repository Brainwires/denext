// A `better-sqlite3` shim that re-exports denext's compat over Deno's built-in
// node:sqlite. Drizzle's `drizzle-orm/better-sqlite3` driver does a top-level
// `import BetterSqlite3 from "better-sqlite3"`, which is an npm-package-internal
// bare import — Deno resolves those through node_modules, NOT the deno.json import
// map, so an import-map alias can't reach it. Installing this as the actual
// `better-sqlite3` package (via `file:` in package.json) is what makes the alias
// land. No native addon, no npm download: it points straight at the compat.
export { Database, default } from "../../../../src/compat/better-sqlite3.ts";
