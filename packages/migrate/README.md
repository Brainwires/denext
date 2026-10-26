# @denext/migrate

The migrators behind `denext migrate` and `denext migrate --check`: the passes that turn a
Next.js (App Router or Pages Router), Remix, React Router, TanStack Start, Vite, CRA, Expo, Fresh,
Preact or Lustre app into a denext app, and the iOS / Android Capacitor target
`--enable-capacitor` adds.

You do not import it yourself. `@denext/denext` loads it the first time `denext migrate` runs,
through a literal dynamic `import("@denext/migrate")`: the rest of the CLI never loads it,
`deno cache` of denext caches it too, and once fetched it works offline. It ships as its own
package so `@denext/denext` stays clear of JSR's package size cap. The `denext codemod` source
rewrite (`denext migrate --codemod`) and the runtime layers a migrated app imports
(`denext/remix`, `denext/fresh`, `denext/preact`, …) stay in `@denext/denext`.

## Versioning

The version is denext's: `@denext/denext` X.Y.Z imports exactly `jsr:@denext/migrate@X.Y.Z` (no
caret), and `@denext/migrate` X.Y.Z imports exactly `jsr:@denext/denext@X.Y.Z`, the framework
modules it is built on (`@denext/denext/internal/migrate-host`, not a public API). Every denext
release, rc versions included, publishes the matching `@denext/migrate` version before its own
tag.
