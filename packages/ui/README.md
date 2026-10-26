# @denext/ui

The web UI behind two denext verbs: `denext ui`, the loopback project-management GUI (config,
plugins, generate, Docker, desktop signing, setup, dev server, tasks, services, the Database
section and the project's own verbs), and `denext dashboard`, the self-hosted stack's database
dashboard behind `DASHBOARD_PASSWORD`, with its log relay.

You do not import it yourself. `@denext/denext` loads it the first time one of those verbs runs,
through a literal dynamic `import("@denext/ui")`: the rest of the CLI never loads it, `deno cache`
of denext caches it too, and once fetched it works offline. It ships as its own package so
`@denext/denext` stays clear of JSR's package size cap.

Project code never runs in the UI's process: every project-touching operation, including verb
discovery, is a `deno` / `denext` subprocess.

## Versioning

The version is denext's: `@denext/denext` X.Y.Z imports exactly `jsr:@denext/ui@X.Y.Z` (no caret),
and `@denext/ui` X.Y.Z imports exactly `jsr:@denext/denext@X.Y.Z`, the framework modules it is built
on (`@denext/denext/internal/ui-host`, not a public API). Every denext release, rc versions
included, publishes the matching `@denext/ui` version before its own tag.
