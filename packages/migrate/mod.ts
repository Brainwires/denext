/**
 * `@denext/migrate` — the migrators behind `denext migrate` (and `denext migrate --check`): the
 * passes that turn a Next.js, Remix, React Router, TanStack Start, Vite, CRA, Expo, Fresh, Preact
 * or Lustre app into a denext app, and the Capacitor target `--enable-capacitor` adds.
 *
 * You do not import it yourself: `@denext/denext` loads it on the first `denext migrate` run
 * through a literal dynamic `import("@denext/migrate")`, pinned to exactly the denext version that
 * loads it. It ships as its own package so `@denext/denext` stays clear of JSR's package size cap.
 *
 * @module
 */

export {
  type AppIconReport,
  type MigrateOptions,
  migrateProject,
  type MigrateResult,
} from "./src/migrate.ts";
export {
  checkMigration,
  type MigrateCheckReport,
  type MigrateFinding,
} from "./src/migrate-check.ts";
export {
  type CapacitorMigrateInfo,
  type CapacitorStepsOutcome,
  runCapacitorSteps,
} from "./src/migrate-capacitor.ts";
