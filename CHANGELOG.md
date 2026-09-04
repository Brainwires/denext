# Changelog

All notable changes to **denext** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Fiber reconciler refactored into layered modules (internal; no public API change).** `src/client/fiber/reconciler.ts` was a 3.4k-line module holding every phase of the fiber engine and fallow's #2 refactoring target (hotspot score 38, fan-out 24, four CRAP suppressions). It is now a barrel over 17 modules that each import only from the layers below — `state`, `fiber-utils`, `root-callbacks`, `hydration`, `scheduler`, `devtools-bridge`, `hooks-dispatcher`, `boundaries`, `render-component`, `reconcile-children`, `context-propagation`, `begin-work`, `complete-work`, `unwind`, `commit`, `work-loop`, `root` — with the one inherent cycle (hooks → scheduler → work loop → beginWork → hooks) broken by injecting the work loop's entry points into the scheduler at init. Before the split, the ten functions over fallow's cognitive/cyclomatic thresholds (`renderComponent` at cognitive 38 down to `disconnectEffects`) were decomposed into named single-purpose helpers, the four `fallow-ignore` markers were deleted, and the two duplicate-clone groups (`useState`/`useReducer` setters, `createRoot`/`hydrateRoot`) were folded into shared helpers. The public surface (`createRoot`, `hydrateRoot`, `flushSync`, `act`, `createPortal`, the DevTools hooks, the `__*ForTests` seams) is unchanged and behavior is identical — the full suite is green. The shared client runtime grows ~1.6 KB raw / ~0.7 KB gzipped (esbuild does not inline the extracted helpers); the build-smoke size tripwire is re-based 56 → 58 KB accordingly. `src/client/fiber/*` (17 new modules), `src/client/fiber/reconciler.ts` (now a barrel).
- **Request pipeline (`createApp`) split into staged server modules (internal; no public API change).** `src/server/app.ts` held the whole request pipeline as one 1.4k-line closure (`pipeline`, cyclomatic 227 / cognitive 427 — fallow's #1 refactoring target) plus the config types and every helper. The routing stages are now one function each in `request-pipeline.ts` (canonicalization → config rules → middleware → Server Actions → metadata files → i18n → API routes → pages → 405 / plugin / static / 404, plus the top-level error handling), the page path lives in `page-response.ts` / `page-document.ts` / `page-cache-flow.ts` (ISR) / `page-prerender.ts` (PPR) / `page-stream.ts` (streaming), the closure's captured locals became explicit `AppRuntime` + `RequestState` records (`pipeline-state.ts`), and `app-config.ts` / `response-headers.ts` / `flight-routing.ts` hold the types and helpers. The two near-duplicate PPR branches and the two streaming branches (HTML vs Flight) share one implementation each, and the eight copies of the hydration literal are one `navData`. `createApp` and every public name still resolve through `app.ts`; behavior is identical (every createApp-driven suite is green). `src/server/{app-config,response-headers,flight-routing,pipeline-state,request-pipeline,page-document,page-cache-flow,page-prerender,page-stream,page-response}.ts` (new), `src/server/app.ts`.
- **Repo-wide fallow dead-code sweep to zero (internal; no public API removed).** `fallow dead-code` reported 102 "unused" files, 299 unused exports, 18 types, 28 class members and 30 unlisted dependencies — almost all of it fallow not knowing how denext loads things. `fallow.toml` now states those facts: the file conventions denext resolves by path (`denext.config.ts`, `middleware.ts`, `instrumentation.ts`, the App Router metadata files, Pages Router `pages/`, SPA `src/main.tsx`, `public/`, the Tailwind input), the `deno task` roots under `bench/` and `examples/`, the user-run migration probes (`examples/next-compat-feasibility`), the generated wasm glue (`packages/{photon,avif}/lib/*.js`), the text-read fixtures (`tests/fixtures/**`), the Deno import-map dependencies fallow can't see in a `package.json`, the lazily-`import()`ed dev proxy, and the DOM interface members the fake-DOM test doubles implement. The remaining ~110 real findings were resolved by hand: helpers used only inside their module lost the `export` keyword (`dom-props.ts`, `dev-unbundled.ts`, the auth/image/CSP constants, …), redundant re-export chains were dropped (`auth/mod.ts`, `next/request.ts`, the reconciler barrels, `error-boundary.ts`), genuinely unreferenced code was deleted (`registerServerInsertedHTML`, `registerDeployAdapter`, `serverRefId`, `collectedStylesheets`, the `TEXT` marker, `StaticResult`, `FileConvention`, `src/router/mod.ts`, dead bench helpers), the AsyncContext transform's output now imports its helpers from `denext/compiler-runtime` like every other build transform (which therefore exports `__asyncScope`/`__asyncScopeEnd`/`__asyncAwait`/`__asyncYield`/`__asyncResume`/`__asyncIter` + the `AsyncScope`/`Bindings` types), and two examples were improved rather than trimmed — `examples/notes` demonstrates Next's `RedirectType.push`, the Effect examples use `Data.TaggedError`, and the game engine owns its audio lifecycle. Every name that was reachable from a public `denext/*` entry still is (through its canonical module). `fallow.toml`, `src/**`, `packages/pages-router/src/**`, `examples/**`, `bench/lib/**`, `tests/helpers/dom.ts`.
- **Dev server split into staged modules (internal; no public API change).** `src/build/dev-server.ts` held the whole development server as one 1.2k-line `startDevServer` closure (cyclomatic 24; its request `handler` alone cyclomatic 31 / cognitive 43) — fallow's largest remaining `src/build` target. The closure's captured locals are now an explicit `DevState` record (`dev-server/state.ts`), and each concern is its own module under `src/build/dev-server/`: `assets` (CSS + transform maps), `compat` (the react→denext compat build), `manifest` (route manifest + Flight boundary per generation), `bundles` (route/Flight client bundles + chunk cache), `loaders` (the module loader over the manifest), `reload` (the live-reload channel), `reload-script` (the injected client script), `dev-endpoints` (`/_denext/*` dev-only routes, `devOriginAllowed`, `editorCommand`), `watch` (the file watcher + invalidation), `dev-app` (the `createApp` wiring) and `handler` (the per-request dispatch, one function per route class). `dev-server.ts` is a 120-line orchestrator that wires them and keeps re-exporting `DevServerOptions`, `DEV_RELOAD_SCRIPT`, `devOriginAllowed` and `editorCommand`, so every importer is unchanged. Every function is under fallow's complexity and 60-line thresholds; behavior is identical — the dev-server, SPA dev, HMR, devtools, live and next-compat suites are green. `src/build/dev-server/*` (12 new modules), `src/build/dev-server.ts`.
- **Unbundled dev loop split into staged modules (internal; no public API change).** `src/build/dev-unbundled.ts` was one 640-line `createUnbundledDev` closure (maintainability index 68.7, the only `src/` file under fallow's 70 floor; its request `handle` cognitive 27). The captured locals are now an explicit `UnbundledState` record and each concern is a module under `src/build/dev-unbundled/`: `state` (URL scheme, dep tables, versions, the transform cache and reverse import graph), `resolve` (specifier → first-party path → dev URL, incl. the compat react/next/npm mapping), `deps` (the native `@dep` pre-bundle, the compat runtime prebuild and the on-demand npm bundle), `transform` (the per-module transform with its cache check, Fast Refresh footer and rewrite plugin, plus the generated-entry transform), `entries` (route / Flight / SPA entries), `handler` (one function per `/_denext/@*` URL class) and `hmr` (`onChange` + `propagate`). `dev-unbundled.ts` is a 70-line orchestrator returning the same object (including the `_internal` test seams), so `dev-server`, `spa.ts` and the tests are unchanged. Every function is under the complexity and 60-line thresholds; behavior is identical — the HMR, SPA dev, dev-server and next-compat suites are green. `src/build/dev-unbundled/*` (7 new modules), `src/build/dev-unbundled.ts`.
- **`denext build` split into a staged pipeline (internal; no public API change).** `src/build/build.ts` was one 434-line `build` function (cyclomatic 60 / cognitive 71). Its locals are now an explicit `BuildContext` record and the stages are modules under `src/build/build-pipeline/`: `prepare` (the SPA and plugin-only builds, cache reset, plugin setup, route scan, compat detection, the staging dir), `transforms` (app CSS + the auto-memo / qrl / AsyncContext client rewrites merged into the bundler import map), `routes` (per-route stylesheets, the static/interactive partition, the native route and Flight bundles, the boundary manifest), `compat` (the next-compat server, Flight and client-entry bundles) and `finalize` (public-env tree-shaking, self-hosted fonts, the build manifest, precompression, the atomic `client/` swap, typed modules, plugin build steps, the size summary). `build.ts` runs them in order in ~30 lines and still exports `build`, `BuildResult` and `FLIGHT_BUNDLE_FILE`, so the CLI, prod server, static export and tests are unchanged. Stage order and every side effect are identical; the build-smoke, prod-server, asset-compression, next-compat and example integration suites are green. `src/build/build-pipeline/*` (6 new modules), `src/build/build.ts`.
- **`denext export` split into a staged pipeline; build/export helpers shared (internal; no public API change).** `src/build/export.ts` was one 269-line `staticExport` (cyclomatic 50 / cognitive 77) plus an untested `exportPagesRouter`. Its locals are now an `ExportContext` record and the stages are modules under `src/build/export-pipeline/`: `prepare` (the SPA and Pages Router exports, plugin setup, route scan, output dirs, the Cache Components loader), `assets` (route classification, stylesheets, the next-compat SSR bundles, the route and Flight client bundles, self-hosted fonts) and `render` (every page × param set × locale, `notFound()` skips, `public/`). The preparation, next-compat module discovery, boundary crawl and font collection the build and export pipelines both perform live once in `src/build/pipeline-shared.ts`, and the `fillPath` duplicated between the export and the conformance prober is `fillPattern` on `src/router/segments.ts`. `export.ts` runs the stages in ~30 lines and still exports `staticExport` and its option/result types. Behavior is identical; the export, Flight export, static SEO, i18n, next/font, desktop, conformance and build suites are green. `src/build/export-pipeline/*` (4 new modules), `src/build/pipeline-shared.ts` (new), `src/build/export.ts`, `src/build/build-pipeline/*`, `src/router/segments.ts`, `src/testing/conformance.ts`.
- **`denext start` split into staged modules (internal; no public API change).** `src/build/prod-server.ts` was one 343-line `startProdServer` (cyclomatic 55 / cognitive 46). It is now a ~60-line orchestrator over `src/build/prod-server/`: `manifest` (reading `manifest.json` into a `BuildInfo` record, the Flight boundary + server-action tagging, the complete-build check), `assets` (the client entry / stylesheet URL resolvers with `assetPrefix`/`basePath`), `app` (the SSR loader chain, middleware, instrumentation, config rules, the durable cache store, `createApp`, the Live hub) and `handler` (health, self-hosted fonts, the image optimizer, immutable client assets, the Live upgrade, then the app). `startProdServer` and `ProdServerOptions` are unchanged; the startup order and every side effect are identical — the prod-server, asset-compression, example and live suites are green. `src/build/prod-server/*` (4 new modules), `src/build/prod-server.ts`.
- **SPA mode split into modules; dev servers share their SSE plumbing (internal; no public API change).** `src/build/spa.ts` was a 950-line module whose `startSpaDevServer` was a 330-line closure (its request `handler` cyclomatic 24 / cognitive 37). It is now a barrel over `src/build/spa/`: `shared` (constants, the generated entry, `classifySpaChange`, the HTML shell with its CSP meta, entry resolution), `bundle` (the native `deno bundle` and next-compat esbuild paths + stylesheet extraction; `pnpmCatalogPackages` is exported and unit-tested), `build` (production build + static export sharing one bundle-and-shell step), `prod-server`, and the dev server as `dev-state` (per-generation bundle, subscribers, the unbundled loop), `dev-watch` (debounced batches → css / per-module update / refresh / reload), `dev-handler` (one function per URL class), `dev-reload-script` and `dev-server`. The SSE subscriber fan-out and stream that the App Router dev server (`dev-server/reload.ts`) and the SPA dev server both implemented live once in `src/build/sse.ts`. Every importer keeps importing from `spa.ts`; behavior is identical — the SPA mode/Fast Refresh/dev/integration, export, dev-server, HMR and prod-server suites are green. `src/build/spa/*` (9 new modules), `src/build/sse.ts` (new), `src/build/spa.ts`, `src/build/dev-server/reload.ts`, `tests/spa-mode.test.ts`.
- **Scaffold, codemod and migrate decomposed (internal; no public API change).** `scaffold.ts`: the three desktop packaging scripts (macOS 337 lines, Windows 205, Linux 193) were parameterless functions returning a template and are now constants; `denoJson` is a task builder plus an import-map builder. `codemod.ts`: the 135-line `rewriteSource` is a `RewriteCtx` plus one function per statement form (static import/export, the default-component and default-`React` cases, side-effect import, `require`/dynamic `import()` call). `migrate.ts`: `migrateProject` (cyclomatic 33) delegates source detection to `migrateNonNextProject` and the config writing to `writePagesRouterConfig` / `writeAppRouterConfig`; `nextConfigSource` (cognitive 27) hands the next.config translation to `nextConfigTranslationLines` + `droppedKeyNotes`; `migrateSpaProject` (180 lines, cyclomatic 29) uses `spaImportMap`, `spaEnvKeys`, `spaProxy`, `writeSpaDesktop`, `spaDenoJson` and `finishSpaProjectFiles`; `denextResolver` splits into the JSR and local-checkout resolvers; `readNextConfig` into MDX detection + the bounded subprocess eval. The two copies of the deno.json write-unless-authored block are one `writeDenoJsonUnlessAuthored`, and the `exists`/`anyExists`/`firstExisting` probes duplicated with `remix-migrate.ts` live in `src/build/migrate-fs.ts`. Output is byte-identical; the scaffold, codemod, create/init, migrate, remix and prisma suites are green. `src/build/{scaffold,codemod,migrate,remix-migrate}.ts`, `src/build/migrate-fs.ts` (new).
- **Directive scanner, hydration stripper, entry generators and next-compat plugins decomposed (internal; no public API change).** `directives.ts`: the 86-line `scanDirectiveCore` (cyclomatic 30 / cognitive 50) is a loop over `scanPrologueStatement` with `skipTrivia`/`readStringLiteral`/comment-skipping helpers. `hydration.ts`: the 118-line `stripLiteralsAndComments` (cyclomatic 38 / cognitive 82) is a `StripState` record with one handler per token kind (line/block comment, regex literal with `regexEnd`, string/template literal, code char). `bundle.ts`: `generateRouteEntry` and `generateFlightEntry` (125 / 137 lines) compose `routeEntryImports`/`routeEntryTree`/`routeRefreshBlock` and `flightRefreshBlock`/`flightLiveBlock`/`flightMain`, sharing one `hydrationCatch`. `next-compat.ts`: the app resolver uses `appImportBase` + an exported `probeSourceFile` (now also used by the unbundled dev resolver, replacing its private copy); the runtime plugin's resolvers, the `./*` exports wildcard, the Vite asset namespaces/worker stub and the compat plugin chain (`compatPlugins`, `nodeModulesPlugins`) are named functions. Generated entries and resolution results are byte-identical; the directive, hydration, bundle, next-compat, Flight, dev-server and build suites are green. `src/build/{directives,hydration,bundle,next-compat}.ts`, `src/build/dev-unbundled/{resolve,state}.ts`.
- **swc-based build transforms share one substrate; each transform decomposed (internal; no public API change).** The auto-memo compiler, the `qrl` handler extractor, the AsyncContext instrumenter and the `"use cache"` rewrite each re-implemented the marker parse, the directive-prologue import point, the child walk, the relative-specifier absolutizing and the write-transformed-modules loop; those now live once in `src/build/swc-ast.ts` (`parseModule`, `prologueEnd`, `forEachChild`, `absolutizeSpecifiers`, `writeTransformedModules`). On top of that: `compiler.ts`'s `collectFreeRefs` (cyclomatic 32) is a per-node-type handler table and `transformModule` (191 lines) delegates to `memoizeComponent` / `absolutizeDynamicImports`; `qrl-transform.ts`'s `collectStmtDecls` and `walkFree` (cyclomatic 32 / 31) are handler tables and `transformQrl` is a `QrlState` with module-level `visitQrl` / `tryExtract` / `extractInlineHandler` / `extractImportRef`; `async-context-transform.ts`'s `visit` (cyclomatic 29 / cognitive 49) is `visitFunction` + `visitSuspension` over an `AcState`, with `walkOwnScope` replacing the two duplicated nested-function-aware walkers; `use-cache-transform.ts`'s `transformUseCache` (cyclomatic 54 / cognitive 88) is a `CacheState` with one wrapper per top-level item form. Emitted code is byte-identical; the compiler, qrl, async-context, use-cache and resumable suites are green. `src/build/{swc-ast,compiler,qrl-transform,async-context-transform,use-cache-transform}.ts`.
- **Config loader, plugin installer, framework-deps installer and desktop runtime decomposed (internal; no public API change).** `paths.ts`: `loadDenextConfig` (cyclomatic 30 from 23 chained fallbacks) merges named exports over the default object through a `CONFIG_KEYS` table and a per-file `importConfigFile`. `plugin-install.ts`: `injectPlugin` (148 lines) uses `addImportLine` / `defaultExportObjectStart` / `insertPluginCall`, `listPlugins` uses `splitTopLevel` / `namedImportSpec`, `ejectPlugin` uses `removePluginCall`. `module-config.ts`: `ensureFrameworkNodeModules` (90 lines) is `frameworkNpmImports` → `installFwdeps` → `linkFrameworkNodeModules`; `satisfiesRange` and `pinNpmToLock` are exported and unit-tested (they had no coverage). `desktop.ts`: `runDesktop` is `resolveOutDir` + `installWindowCloseHandler` + an exported `createDesktopHandler` (unit-tested: no-store assets, the shell for navigations, `onRequest`, 404s), and its `wantsShell` is the SPA mode one. Behavior is identical; the module-config, desktop, plugin and config suites are green. `src/build/{paths,plugin-install,module-config,desktop}.ts`, `tests/desktop-runtime.test.ts` (new), `tests/module-config.test.ts`.
- **Build helpers deduplicated (internal; no public API change).** `bundle.ts`'s `absolutizeImports` and `css.ts`'s `normalizeImports` were the same import-map absolutizer; `next-compat.ts` and `dev-unbundled.ts` each re-implemented the same "read the app's `deno.json` prefix aliases" loop. `css.ts` now reuses `absolutizeImports`, both dev bundlers call one `readAliasPrefixes(configPath)`, and `buildAppCss` (cyclomatic 29 / cognitive 42) is a short pipeline over named stages — collect stylesheets, alias the Tailwind input, compute alias-form css redirects, write `css-config.json`, decide the transient app-config redirects. Behavior is identical; the CSS, dev-server and next-compat suites are green. `src/build/{bundle,css,next-compat,dev-unbundled}.ts`.
- **fallow gate: measured coverage for CRAP scoring (`deno task coverage:fallow`).** Fallow's CRAP score (complexity × untested-ness) estimated coverage from the import graph when no coverage file was supplied, scoring modules that tests reach only transitively (the reconciler, driven through `createRoot()`) at a 40 % tier — so CRAP fired on any function there with cyclomatic ≥ 10 regardless of the real coverage (82 % lines measured). The new task runs the unit suite with coverage, exports lcov (already source-mapped to TypeScript lines) and converts it to the Istanbul map fallow reads; the pre-commit hook passes `--coverage coverage/coverage-final.json` whenever that file exists. Thresholds and gate mode are unchanged. `scripts/coverage-to-istanbul.ts` (new), `.githooks/pre-commit`, `deno.json`, `CONTRIBUTING.md`.

### Added

- **`denext/client-runtime` — the stable import for denext's generated browser entries.** The route/Flight entries `denext build`/`dev` emit, the SPA dev entry, the Pages Router client entry and the Server Action client stubs import their boot and HMR plumbing (`startClient`, `provideLayoutSegments`, `parseFlight`, `setFlightParser`, `clientActionStub`, `qrl`/`capturedScope` (also kept on `denext/client`), `enableFastRefresh`, `enablePerModuleRefresh`, `performModuleRefresh`, `registerFamily`) from this entry instead of `denext/client`, the same way build-transform output imports `denext/compiler-runtime`. The bundlers resolve it (and `denext/devtools`, which the dev entries import `installDevtools` from) against the framework, so an app's import map need not list either subpath. Not an application API — apps keep using `denext/client`. `src/client/client-runtime.ts` (new), `deno.json`, `src/build/{bundle,spa,next-compat,dev-unbundled}.ts`, `packages/pages-router/src/client-entry.ts`.
- **Typed Server Actions (`defineAction`) — the mutation half of end-to-end type safety.** The typed API client type-checks reads to your route handlers; `defineAction` (from `denext/server`) does the same for **writes**. A Server Action by itself takes raw `FormData` (untyped string blobs) and returns anything — so a missing/mistyped field is a runtime error and the result type never reaches the component. `defineAction({ input, handler })` validates `FormData` into a **typed input** (a plain parser over the form fields, or any **Standard Schema** — Zod/Valibot/ArkType — with zero denext dependency), runs a **typed `handler(input) => Out`**, and returns a discriminated `ActionResult<Out>` (`{ ok: true, data }` or `{ ok: false, error, fieldErrors }`). The `Out` type flows all the way into `useActionState` — `state.ok ? state.data.id : state.fieldErrors?.title` is fully typed, and a wrong-type usage is a compile error. Throw `ActionValidationError(msg, { field: "…" })` (from a parser or the handler) to surface per-field messages; `idleActionState<Out>()` (from `denext`/`denext/client`) is the initial state. It plugs into denext's existing Server Action dispatch + progressive enhancement (tolerates both the `useActionState` `(prevState, formData)` shape and a bare `(formData)` call). So the app's whole network boundary — routes, API calls, **and** actions — is type-checked, no tRPC and no extra dependency. `src/runtime/define-action.ts` (new), exports from `denext/server` (`defineAction`, `ActionValidationError`) + `denext`/`denext/client` (`idleActionState`, `ActionResult`).
- **MCP codebase search — `denext_query_codebase`, `denext_find_definition`, `denext_find_references`, `denext_index_codebase`.** The MCP server could search denext's own docs (`denext_search_docs`) but not the developer's **own project code** — so an agent working in your app had to open files blind. Four new tools index the project the MCP server was launched in and answer over it: `denext_query_codebase` ranks source by relevance to a keyword/question (BM25), `denext_find_definition` locates where a symbol is declared (exports first), `denext_find_references` lists its usages, and `denext_index_codebase` warms/reports the index. It's **native, zero-npm, offline, in-process** — no model, no embeddings service, nothing sent anywhere. The index is built at runtime, cached at `.denext/rag/codebase.json`, and **refreshed incrementally by file mtime** so it stays correct as you edit. Traversal honors the project's **`.gitignore` in full** (negation, nested `.gitignore` files, `**`/`*`/`?` globs, anchoring, directory-only rules) plus a fixed floor (`.git`, `.denext`, `node_modules`, `out`, `dist`, `coverage`, `build`), so vendored/generated code and secrets in ignored paths are never indexed. Retrieval sits behind a pluggable `Retriever` seam (shared with docs search), so an embeddings retriever can drop in later without changing callers. The `/docs/mcp` page and `llms.txt` list the tools automatically (generated from the registry), bringing the surface to 14 tools. `src/mcp/rag/{gitignore,codebase,code-search,snippet}.ts` (new), `src/mcp/rag/search.ts`, `src/mcp/tools.ts`.

### Removed

- **Framework plumbing dropped from the public barrels (`denext`, `denext/server`, `denext/client`, `denext/testing`).** A public-surface audit classified every symbol the `deno.json` entries expose; 89 were internal machinery an application never calls, reachable (and documented in the API reference) only because the barrels double as the framework's own import hub. They are no longer exported from the public entries — the implementations are unchanged and still imported internally from their source modules. From `denext/server`: the ids and constants `ROOT_ID`, `PUBLIC_ENV_ID`, `DEFAULT_SEGMENT_CONFIG`, `APPLE_ICON_PATH`/`ICON_PATH`/`OPENGRAPH_IMAGE_PATH`/`TWITTER_IMAGE_PATH`, `MIDDLEWARE_*_HEADER`/`MIDDLEWARE_REQUEST_PREFIX`, `NEXT`/`REWRITE`, `FRAGMENT`; the registries and setters `setRequestAdapter`, `setNextRuntimeEnv`, `setDraftTokenStore`, `resolveDefaultCacheStore`, `runRegister`, `registerRouteSynthesizer`, `registerConvention`, `registerServerReference`; the Server Action wire internals `tagServerExports`, `tagServerModules`, `getServerAction`, `decodeActionArgs`, `clientActionStub`, `isActionRequest`, `handleAction`, `handleApi`, `actionEndpoint`; the route-matcher and segment-config internals `compilePattern`, `fillDestination`, `matchSlot`, `matcherToRegExp`, `matches`, `splitPath`, `parseSegment`, `matchPattern`, `mergeSegmentConfig`, `readSegmentConfig`; and `serializeSvg`, `DevPanel`, `loadInstrumentation`, `resolveConfigRules`, `filterPublicEnv`, `publicEnvFrom`, `parseEnv`. From `denext/client`: the boot/HMR hooks now on `denext/client-runtime` (above; `qrl`/`capturedScope` stay on `denext/client` as well since they are documented for hand use), `setDocument`, `setHookState`, and the DevTools API that `denext/devtools` already owns (`installDevtools`, `installInspector`, `getInspectorTree`, `getIslandTimeline`, `getRenderModes`, `getPageRenderMode`, `subscribe`, and the `DenextDevtoolsApi`/`Inspect*`/`PageRenderMode`/`RenderModeEntry`/`SerializedValue`/`IslandHydration`/`ClientRegistry`/`Qrl`/`LayoutSegmentInfo` types), plus `useMemoCache` (the compiler primitive lives on `denext/compiler-runtime`). From `denext`: `IMAGE_ENDPOINT`, `actionEndpoint`, `isValidAttrName`, `serializeStyle`, `streamToString`, `useMemoCache`, `isServerAction`. From `denext/testing`: `FRAGMENT` (use `Fragment` from `denext`). The embedding and plugin API stays public: `createApp`, `defaultLoader`, `scanRoutes`, `renderPage`/`renderDocument`/`renderToFlight*`, `serve*`, the middleware runner, and the i18n and cache-store helpers; `denext/plugin-kit` is unchanged (`enableFastRefresh`/`registerFamily` there now come from the refresh runtime directly). Plugin packages that re-exported `FRAGMENT` from `@denext/denext/server` import `Fragment` from `@denext/denext` instead. The API reference (`apps/web/app/docs/api/reference.json`) and `llms-full.txt` are regenerated. `mod.ts`, `src/server/mod.ts`, `src/client/mod.ts`, `src/testing/mod.ts`, `src/plugin/kit.ts`, `src/compat/next/server.ts`, `src/testing/render.ts`, `packages/{htmx,pages-router}/mod.ts`.

## [2.0.0-rc.6] - 2026-09-02

### Added

- **Typed API client — end-to-end type-checked calls to your own route handlers (no tRPC).** Calling an app's own `app/**/route.ts` was untyped: a handler returns a web `Response`, whose type erases the JSON body, so a caller got `any` back and a signature drift became a silent runtime 500. Handlers now opt into typed bodies with `TypedResponse<T>` / `TypedRequest<B>` + `json<T>()` from `denext/server` (`json` is `Response.json` at runtime — the typing is zero-cost, carried on a phantom type parameter). `denext build` / `denext dev` read those signatures via `deno doc` and generate `.denext/api.ts` — an `ApiSchema` mapping every route pattern → method → `{ params, body, response }`, with params inferred from the route pattern and named body types re-imported from the route module. Pair it with `createApiClient<ApiSchema>()` (from `denext`/`denext/client`) for a fully-typed call: `api("/api/user/[id]", "GET", { params: { id } })` returns the handler's response type, and an unknown path, wrong method, missing/mistyped param or body, or misused response is a **compile-time error**. The generated module is a `type` alias (so `keyof` stays the literal route patterns for autocomplete while still satisfying the client's `Record` constraint). The runtime client (`apiRequest`/`buildPath`) is a thin `fetch` wrapper (param substitution incl. catch-alls, query, JSON body) usable from a Server Component, a client component, or a test. `src/server/typed-response.ts` (new), `src/build/api-types.ts` (new — the generator), `src/runtime/api-client.ts` (new — the client), `src/build/emit-typed-modules.ts` (new — shared routes.ts + api.ts emit), `src/build/{build,dev-server}.ts`, `examples/hello`.
- **First-party MCP server (`denext mcp`) — denext's tooling for AI agents and IDEs.** A Model Context Protocol server (newline-delimited JSON-RPC 2.0 over stdio, hand-rolled — no SDK, no npm, keeping the framework's zero-runtime-npm promise) that lets any MCP client write, verify, and scaffold denext correctly. Configure a client to run `deno run -A jsr:@denext/denext/cli mcp`. **Tools:** `denext_check_snippet` (lint a code string for the Next.js→denext mistakes an agent makes — wrong import source, a misplaced `"use client"`, an interactive component with no client boundary — instantly, with the fix, no type-checker needed), `denext_import_map` (map any Next/React specifier to its denext equivalent), `denext_generate` (scaffold a page/route/component/api/action/test), `denext_doctor` (project health), and `denext_codemod` (dry-run the Next→denext import rewrites). **Resources:** `denext://guide` (the AGENTS.md authoring guide) and `denext://import-map`, so a client can ground itself on denext's rules. The canonical import mapping lives once as data (`src/mcp/next-denext-map.ts`) shared by the checker, the tool, and the llms.txt generator. `src/mcp/{server,tools,check,next-denext-map,package-file}.ts` (new), `src/cli/commands/mcp.ts` (new), `src/cli/register.ts`.
- **MCP "execute + inspect" tools (`denext_render`, `denext_route_map`).** The thing an agent couldn't do before: run the app. `denext_render` renders a route (by `path`) or a component (by `component` + `props`) **server-side, no browser**, and returns the real HTML + status — so an agent can SEE what its edit produces (or the error it throws), closing the edit→render→fix loop without a browser or a live server. It reuses `denext/testing`'s in-process app client and component renderer, so it runs the actual render (hooks and all) in milliseconds. `denext_route_map` maps everything that renders at a path — the matched page + params, its layout and template chains (each tagged **server**/**client**), its `loading`/`error`/`not-found` boundaries and parallel slots, and any API route at the same path — from the route manifest, so an agent gets the whole render tree without opening a dozen files. Both run against the project the MCP server was launched in (its own `deno.json`). The MCP surface is now nine tools, spanning read + observe + **execute** — a capability no peer framework MCP server offers. `src/mcp/inspect.ts` (new), `src/mcp/tools.ts`.
- **Dev server black box + live MCP tools (`denext_list_routes`, `denext_dev_logs`).** The dev server now keeps a bounded in-memory recorder of the running app's runtime signal, so the same thing a developer sees in the terminal/browser is readable out-of-process — by the MCP live tools, or any localhost reader. It records: **server errors** (render/build/type errors, with the codeframe the overlay already builds); **server console** — the dev process's own `console.*` (a `console.log` in a Server Component or route handler), captured by the real `denext dev` CLI only (it wraps the process console, which is global — an embedded/parallel server leaves it off); the **browser's** `console.error`/`warn` + uncaught errors/rejections, shipped back over a new same-origin-gated `POST /_denext/dev-log` by the dev-reload client already on every dev page; each completed **request** (`GET /about → 200`, with duration); and **HMR** events (hot-swap / reload). Read it at `GET /_denext/dev-state` (filter by `kind=error|console|request|hmr`). On boot the dev server publishes its address to `.denext/dev.json` (removed on drain) so a reader can find it. Two new MCP tools: `denext_dev_logs` reads the **running** server's recent events (so an agent sees what actually happened at runtime, not just static source), and `denext_list_routes` lists an app's pages + API routes with their dynamic params (no dev server needed). Both endpoints reuse the reload stream's cross-origin gate — a server-side reader (no `Sec-Fetch-Site`) is allowed, a cross-site page is refused. `src/build/dev-events.ts` (new — ring buffer + console capture), `src/build/dev-server.ts`, `src/cli/commands/serve.ts`, `src/mcp/dev-client.ts` (new), `src/mcp/tools.ts`.
- **`llms.txt` + `llms-full.txt` (served at denext.dev/llms.txt).** The [llms.txt convention](https://llmstxt.org) — a curated, low-noise entry point for LLMs. `llms.txt` is a concise index (what differs from Next.js, doc links, the agent tooling); `llms-full.txt` is the full authoring guide (AGENTS.md) plus a per-module API-surface summary an agent can load wholesale. Both are generated from AGENTS.md + the API reference so they never drift from the real surface (`deno task docs:llms`, folded into `deno task docs:build`), and emitted into `apps/web/public/` so the static export publishes them at the site root. `scripts/gen-llms-txt.ts` (new), `deno.json`.

### Fixed

- **Pre-RC audit hardening (production, security, docs) of the above.** A four-dimension audit (production, security, documentation, React/Next parity) of everything since rc.5; parity was clean (0 gaps, no compat changes), and the findings on the new surface were fixed: (1) **Dev-loop stall** — the typed-module emit (`.denext/api.ts`) `await`ed a `deno doc` pass per API route on the request that triggered a rescan, stalling every reload after an edit; it's now fire-and-forget, guarded to run once per new manifest (`src/build/dev-server.ts`). (2) **Hang bound** — the typed API client's `apiRequest` had no timeout, so a Server-Component call to a wedged endpoint could pin an SSR render forever; it now applies a default 30s timeout composed with any caller signal (`timeoutMs` to override), and the MCP dev-state fetch got a 5s timeout (`src/runtime/api-client.ts`, `src/mcp/dev-client.ts`). (3) **Path containment** — `denext_render`'s component path (untrusted MCP input, `import()`ed) is now confined to the project tree, and `readPackageFile` rejects traversal paths (`src/mcp/inspect.ts`, `src/mcp/package-file.ts`). (4) **Console-capture opt-out** — server console capture (readable via the local dev-state endpoint) can be disabled with `DENEXT_DEV_CAPTURE_CONSOLE=0` for anyone who logs secrets in dev (`src/cli/commands/serve.ts`). (5) **Robustness** — `.denext/dev.json` is now removed on SIGINT (not only on drain), the MCP stdio read buffer is capped against an oversized message, and the concise `llms.txt` tool list is derived from the live tool registry so it can't under-report (it was listing 5 of 9). `src/mcp/server.ts`, `scripts/gen-llms-txt.ts`.

## [2.0.0-rc.5] - 2026-09-01

### Added

- **Dev loop: background type-checking + a richer error overlay (codeframe, open-in-editor).** The dev server now runs `deno check` **asynchronously and debounced** on each source edit, off the render critical path; a type error surfaces in the browser error overlay (with a codeframe) instead of reaching the browser silently, and a monotonic token drops a stale run when a newer edit lands (opt out with `DENEXT_DEV_TYPECHECK=0`; skipped for next-compat/drop-in apps, where raw-source `deno check` doesn't match the rewritten build graph). The overlay itself is upgraded from plain title/message/stack to a **codeframe** — the source snippet around the failing line with a caret at the column — plus a **clickable in-project stack frame** that opens the file in your editor via a new dev-only `/_denext/open-in-editor` endpoint (honors `DENEXT_EDITOR`/`VISUAL`/`EDITOR`, shaping the launch args for VS Code / JetBrains / Sublime / terminal editors; default `code`). Both the endpoint and the enrichment are dev-only and cross-origin-gated (same guard as the live-reload stream), and the editor endpoint refuses any path outside the project. `src/build/dev-codeframe.ts` (new — pure frame-parsing + codeframe), `src/build/dev-server.ts`.
- **`denext analyze` + test DX (`generate test`, `test --watch`/`--coverage`).** A new `denext analyze` builds the app and prints a per-chunk client-bundle breakdown — every chunk ranked largest-first (by gzip / over-the-wire size) with a proportion bar, its share of the total, and raw·gz sizes, plus the raw/gz totals — a terminal stand-in for a treemap that answers "why is my JS this big" at a glance (`--json` for the machine-readable form). `denext generate test <Component>` scaffolds a `tests/<Component>.test.tsx` using `denext/testing`'s in-process (no-browser) renderer, with the component import wired to the conventional `components/` dir (src-layout-aware). And `denext test`'s help now surfaces `--watch` (re-run on change) and `--coverage` (both already pass through to `deno test`). `src/cli/commands/analyze.ts` (new), `src/build/bundle-report.ts` (`bundleAnalysisLines`), `src/build/generate.ts`, `src/cli/commands/{generate,toolchain}.ts`, `src/cli/register.ts`.
- **`denext.config` validation — `defineConfig` catches typos and bad values, `doctor` reports config correctness.** `defineConfig` is no longer an identity passthrough: at runtime it warns on an **unknown key** (a typo, or a stale Next.js option that TypeScript can't catch on a cast object) with a "did you mean" suggestion, and **throws a field-scoped error** on a malformed value (e.g. `basePath: "docs"` without a leading slash, a non-finite `images.qualities`) — right at the config site rather than misbehaving at request time. A plain `export default {…}` config gets the same unknown-key warning through the loader. A commented/JSONC `deno.json` no longer silently loses its import map (parsed as JSONC now, with a stderr warning on genuine breakage instead of a silent `{}`). `denext doctor`'s config check now reports **correctness** (loaded & validated / the field-scoped error), not just presence. `src/server/config-validate.ts` (new — shared, build-dep-free), `src/server/define-config.ts`, `src/build/{paths,module-config}.ts`, `src/cli/commands/doctor.ts`.
- **`denext migrate` auto-wires Prisma to the Rust-free Deno client.** A migrated app (Next or Remix) that uses Prisma now runs on denext end-to-end with **zero manual edits** — the native Rust query-engine client (which doesn't bundle under Deno) is replaced by Prisma 6's ESM/Deno `prisma-client` generator with the **query compiler** (no native `.node` engine) driven through the `@prisma/adapter-better-sqlite3` driver adapter over Deno's built-in `node:sqlite`. Migrate rewrites the schema generator (`provider = "prisma-client"`, `runtime = "deno"`, `previewFeatures = ["queryCompiler", "driverAdapters"]`), repoints every `@prisma/client` import at the generated client, injects the adapter at each `new PrismaClient()` (empty + object-literal forms; a non-object arg is flagged), folds the `deno.json` wiring in (`nodeModulesDir: "manual"` + a `links` shim for the compat + `@prisma/client`/adapter npm pins + a `prisma:setup` task), and drops the superseded `@prisma/client`/`prisma` from `package.json`. Only **runtime** source (`app/`/`src/`/`lib/`/…) is transformed — Node-only tooling (a `prisma/seed.ts`, Cypress helpers) is left untouched. One post-migrate step: `deno task prisma:setup` (bundle the compat → install → `prisma generate` → `db push`). On the **next-compat** build path the generated client is externalized from the SSR bundle so its runtime engine-loading survives (esbuild would otherwise mangle its `globalThis['__dirname']` shim + baked config). Validated end-to-end on the stock `remix-run/indie-stack` (auth, sessions, nested-route loaders, note create/read) — the last real-world caveat from the Remix stress test is closed. `src/build/prisma-migrate.ts` (new), `src/build/migrate.ts`, `src/build/next-compat.ts`, `src/cli/commands/migrate.ts`, `examples/prisma`.
- **Remix support: `denext/remix` runtime + `denext migrate --from remix`.** Remix apps now run on denext with their **data model intact** — no manual loader inversion. A new first-party compat runtime (`denext/remix` + `denext/remix/server`) implements Remix's surface on denext primitives: `useLoaderData`/`useActionData` (the `loader` runs server-side, its data crosses the Flight boundary into a client provider — SSR **and** hydrate), `<Form>`/`useSubmit`/`useFetcher` (denext **Server Actions**), `useNavigate`/`useLocation`/`useSearchParams` (Remix's `[params,setter]` tuple)/`useParams`/`useMatches`/`useRevalidator`, `<Link>`/`<NavLink>`/`<Outlet>`/`useOutletContext`, `defer`/`<Await>`/`useAsyncValue`, `useRouteError`/`isRouteErrorResponse`, and `json`/`redirect`/`defer`. The migration (auto-detected from `@remix-run/*` deps / `remix.config.*` / `app/root.tsx`+`app/routes/`, short-circuiting the Vite-SPA detector so Remix-Vite isn't miscaptured) restructures `app/routes/*` (flat-file + dot-nested + the `route.tsx` folder form) into `app/**/page.tsx`+`layout.tsx` — `$param` → `[param]`, `$` → `[...splat]`, `_index` → the segment page, pathless `_x` → a `(x)` route group, trailing-`_` break-out flattened + flagged — converts `app/root.tsx` → `app/layout.tsx` (Remix doc components stripped, `<Outlet/>` → the layout `children`), deletes `entry.{server,client}.*`, and **splits each route** into a client component (`page.client.tsx`) + a server data module (`page.data.ts`) wired by a generated `page.tsx` wrapper (a `loader` can't share a `"use client"` module with the component). `meta` → `generateMetadata`, `ErrorBoundary` → `error.tsx`, `@remix-run/*` imports → `denext/remix`(`/server`), and a resource route (loader/action, no component) → a denext `route.ts` API handler. The follow-ups first reported as review notes (cross-route `useFetcher`, `useNavigation` on plain link clicks, session storage, streamed `defer`, cross-route submit to a page action) were subsequently closed — see the Fixed entries below. `src/compat/remix/{client,server}.ts` (new), `src/build/remix-migrate.ts` (new), `src/build/migrate.ts`, `src/cli/commands/migrate.ts`, `src/build/codemod.ts`.
- **Unbundled dev loop — true per-module HMR, now the default for the native App Router.** A Vite-class dev server that serves each source module transformed-but-unbundled at its own URL (`/_denext/@fs…`, with `denext` pre-bundled once as a single instance under `/_denext/@dep/`), so the browser loads the native ESM graph. On a save, only the edited module is re-transformed (**~5 ms** warm, vs a ~460 ms `deno bundle` subprocess) and re-imported; a new reconciler seam substitutes the component's **family-current** implementation onto the live fiber, so a **single** module swaps in place with hook state preserved and **no full reload** — a non-component edit propagates up the module graph to the nearest accept boundary. It covers the full native surface: static and dynamic (`[param]`) routes, nested layout/template chains, and loading/error boundaries. Opt out with `DENEXT_DEV_UNBUNDLED=0` to force the bundled whole-route refresh. It also covers **Flight/islands** routes: the app-wide Flight entry imports each `"use client"` island by its own `@fs` URL, so editing an island hot-swaps that single module in place with its `useState`/signal state preserved. A route whose entry needs the full pipeline (MDX), or an app using a build-time module rewrite (`experimental.compiler` / resumability qrl extraction), automatically stays bundled; and an edit the unbundled graph does not own falls back to the bundled whole-entry Fast Refresh — so nothing downgrades to a full reload. The dev-origin SSE gate and same-origin re-import checks are preserved; the substitution seam is null-guarded and never taken in production. It also covers **next-compat** (drop-in npm React): `react`/`react-dom`/`next/*` are served from a pre-bundled react→denext runtime and the app's npm packages from an on-demand npm bundle (Vite-optimizeDeps style — bundled together with `splitting` so packages sharing a transitive dep get one instance, and `react` external so every lib uses denext's single React), all as `@dep`/`@npm` dev modules, while the app's own source hot-swaps per-module. It also covers **SPA** (`mode: "spa"`, its own dev server): the SPA entry + its module graph serve unbundled (native denext or the compat runtime), a component edit hot-swaps one module in place, and the app's extracted stylesheet is linked separately (the `.css` imports become empty shims). So per-module HMR is now the default on **every** path — native App Router, Flight/islands, next-compat, and SPA — and the "Per-module granular HMR" KNOWN-LIMITATIONS entry is retired. `src/build/dev-unbundled.ts` (new), `src/build/dev-server.ts`, `src/build/spa.ts`, `src/build/bundle.ts`, `src/build/next-compat.ts`, `src/client/fiber/reconciler.ts`, `src/client/vnode-utils.ts`, `src/client/refresh-runtime.ts`.
- **Static export (`deno task export`) now self-hosts `next/font/google` fonts** (previously it emitted a runtime `fonts.googleapis.com` `<link>`; the prod server already self-hosted). The export force-loads route modules so their font loaders register, downloads the `@font-face` CSS + woff2 files under `out/_denext/fonts`, and inlines the local faces — so a purely static site makes **no runtime request to Google** (privacy + no third-party dependency), matching the prod-server path. Best-effort: an unfetchable font (offline build) still falls back to a runtime `<link>`. `src/build/export.ts`.
- **Pages Router `res.revalidate(path)` — on-demand ISR.** An API route can now purge a cached render on demand (Next parity), delegating to App Router's `revalidatePath`. It is **purge-only** — a bad/unknown path is a safe no-op, never a re-render — so it cannot poison the page cache; the next request regenerates through the normal ISR path. Returns a promise you can await. `packages/pages-router/src/api.ts`.
- **Route-level View Transitions on soft navigation.** A Flight soft-nav now commits inside `document.startViewTransition` where the browser supports it (Chromium today), so the route swap cross-fades; the browser honors `prefers-reduced-motion`, and unsupported browsers navigate instantly exactly as before (feature-detected, zero cost when absent). The `<ViewTransition>` component stays a passthrough — its per-element `name`/`enter`/`exit` props aren't honored yet, and the isomorphic/HTML nav paths (async reconcile) don't animate yet. `src/client/navigation.ts`, `src/compat/react.ts`.
- **Domain-based i18n routing (`i18n.domains`).** Serve a locale per host without a URL prefix (Next parity): `example.fr/about` renders French with no `/fr`. Each `{ domain, defaultLocale, locales?, http? }` entry pins a host to a default locale (served unprefixed there; the host's other locales are still prefixed); an explicit prefix always wins, and a host outside the map keeps the normal prefix behavior. Host resolution uses the request's **trusted** host (honoring `trustForwardedHeaders`), never a raw `Host` header on the render path, and only runs when `domains` is configured. `localeMiddleware` no longer redirects an unprefixed path on a pinned host, and generated `hreflang` alternates now cross hosts (absolute per-domain URLs). `src/server/i18n.ts`, `src/server/app.ts`. (Metric-matched `next/font` fallback remains tracked.)
- **Pages Router `res.write` now streams incrementally (SSE / chunked responses).** Previously `res.write` buffered into one response sent at `res.end`; the first `res.write()` before a terminal call now switches the response into streaming mode — status + headers flush immediately, chunks are delivered as written, and `runApiRoute` returns the streamed `Response` **before** the handler finishes (essential for long-lived SSE, which would otherwise never start). A handler that never calls `res.write` is byte-for-byte unchanged (single buffered response), and an unhandled throw before any output still yields a 500. `packages/pages-router/src/api.ts`.
- **`denext desktop package` now builds Windows bundles** (previously macOS + Linux only). `deno desktop` cross-compiles the `.exe` for `x86_64`/`arm64` (`x86_64`/`aarch64-pc-windows-msvc`) from any OS; the new scaffolded `scripts/package-windows.ts` builds one or both arches, wraps each as a `.zip`, and **Authenticode-signs** the `.exe` when `DENEXT_WINDOWS_CERT` is set and `signtool` is available (no secrets baked in — signing is env-gated and skipped with a warning otherwise, mirroring the macOS codesign/notarize pattern). `denext desktop package --target-os windows` selects it. The target machine needs the Edge WebView2 runtime (preinstalled on current Windows). macOS/Linux packaging and the OS-agnostic `denext desktop run` are unchanged. `src/cli/commands/desktop.ts`, `src/build/scaffold.ts`, `examples/native/scripts/package-windows.ts`.
- **React `taint*` (`experimental_taintObjectReference` / `experimental_taintUniqueValue`).** Mark a value — an object reference, or a secret string/bigint — that must never be serialized to a client component; denext's Flight serializer throws instead of sending a tainted value across the server→client boundary. A `taintUniqueValue` taint is released when its `lifetime` object is garbage-collected (matching React). Defense-in-depth — a guardrail against _accidentally_ leaking a secret to the client, not a substitute for not passing it — and two empty-map lookups per serialized value when nothing is tainted. `src/runtime/taint.ts` (new), `src/jsx/render-to-html-flight.ts`, `src/compat/react.ts`.

### Fixed

- **Remix compat surface: all parity gaps closed (`denext/remix` fully mirrors `@remix-run/react`/`@remix-run/node`).** After bringing `src/compat/remix/` under the signature-parity gate, burned the known-gaps ledger to **0**. The signature-only deviations: `isCookie`/`createSession` are now exported (they existed privately), `isSession` is added, `useSearchParams(defaultInit)` honors default params for keys absent from the URL, and `defer(data, init?)` / `useFetcher({ key })` / `useHref`/`useFormAction`/`useResolvedPath` accept their Remix optional arguments. The two that needed real runtime work: **`data(value, init?)`** returns a value with a custom status/headers without JSON-serializing it (the value reaches `useLoaderData`/`useActionData` unchanged; a page loader's `init` is applied to the document response, a resource route builds `Response.json(value, init)`) — this also makes a loader/action's response **headers** apply generally (previously only `Set-Cookie` did), and **`replace(url, init?)`** issues a redirect the client follows with `location.replace` (no back-stack entry) instead of a push. `replace` also **fixes denext's own `redirect(url, "replace")` / `permanentRedirect(url, "replace")`** — the `RedirectType.replace` history mode was previously set on the signal but never honored; a Server Action redirect now threads it to the client. `src/compat/remix/{client,server}.ts`, `src/server/{app,action-handler,request-context}.ts`, `src/runtime/server-action.ts`.
- **Post-Phase-3 audit (production, security, docs, React/Next deviation).** A four-dimension audit; findings fixed: (1) **Prod** — a `<Live>` data subscription's per-recompute re-authorization (`canSubscribe`) that threw (e.g. on a revoked mid-session) became an unhandled rejection in the fire-and-forget recompute and, with no global handler, **crashed the whole prod server**; it now degrades like a denied recompute (`src/server/live.ts`). The SQLite cache's `deleteByPath` orphaned tag rows (unbounded `tags` growth under repeated `revalidatePath`); it now cleans them in the same tx (`src/server/sqlite-cache.ts`). (2) **Security (dev-only)** — `devOriginAllowed` treated a missing `Origin` as allowed, but a cross-origin subresource GET (`<img>`/`<script>`) sends none, so a page a developer visited while `deno task dev` ran could reach the new `/_denext/open-in-editor` endpoint and spawn/flood their editor; the gate now rejects any request whose `Sec-Fetch-Site` is present and not `same-origin` first (`src/build/dev-server.ts`), plus a symlink `realPath` re-containment check in `resolveInProjectFile` and a `--` separator on the dev `deno check` spawn. (3) **React parity** — `react-is.isElement` accepted any unbranded `{type,props}` object (diverging from React and from denext's own `React.isValidElement`); it now requires the `$$typeof` brand, so libraries routing on `react-is` (Radix, emotion, react-hook-form) no longer misclassify data objects as elements (`src/compat/react-is.ts`; internal classifiers still unwrap structurally). Several documented-in-code-only deviations (`React.cache` off-request persistence, `next-intl` ICU subset, `next/head` no key-dedup, `Children`/introspection shims) are now in [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md).
- **Remix `shouldRevalidate` is unbounded, and `useBlocker` catches browser back/forward.** Two follow-on bounds closed: (1) the `shouldRevalidate` prior-data echo is no longer capped — when it's too large for request headers (Deno drops headers past ~16 KB) the client sends it in a JSON **POST body** instead (a soft-nav POST carrying `x-denext-nav`, which the dispatch treats as a render, not an action), so a skipped loader works for any data size. (2) `useBlocker` now also vetoes the **browser back/forward buttons** — the popstate is undone (the prior entry restored) and re-applied on `proceed()` — not just in-app `<Link>`/`useNavigate`/`<Form>` navigations. Validated end-to-end on the indie-stack with a 20 KB echo body. `src/compat/remix/{server,client,revalidation}.ts`, `src/client/navigation.ts`, `src/server/{app,request-context}.ts`.
- **Remix `shouldRevalidate` now genuinely skips loaders on client revalidations.** A route's `shouldRevalidate` export is honored end-to-end: on a soft nav (or `router.refresh()`) the client echoes each mounted route's prior loader data + params (small, size-budgeted request headers, with the URL it's coming from and any submit's form context); the server evaluates `shouldRevalidate` and, when it returns `false`, **skips that loader's work** (the DB query) and renders the route from the echoed data — so an unchanged ancestor/route isn't re-queried on navigation. A route whose data exceeds the echo budget (~6 KB JSON) simply revalidates as normal (never stale). Always-revalidate remains the default (first paint, hard nav, no `shouldRevalidate`, or an explicit `true`). New isomorphic `src/compat/remix/revalidation.ts`; a generic `setNavHeadersProvider` seam in `src/client/navigation.ts`; server evaluation in `src/compat/remix/server.ts` (`RemixRoute`/`RemixLayout` deduped through a shared runner); the migration threads `shouldRevalidate` into the generated wrappers. Validated end-to-end on the indie-stack (an echoed marker proves the DB loader is skipped). Also: `migrate.ts` deduplicated (a shared `classifyDeps` + `writeAppRouterDenoJson` across the Next/Remix/SPA paths — which also fixes the SPA path pinning a non-numeric `catalog:` version) and the Flight serializers share a `serializeThenable` helper. `src/compat/remix/{revalidation,server,client}.ts`, `src/client/navigation.ts`, `src/build/{remix-migrate,migrate}.ts`, `src/jsx/{flight-scalar,render-to-flight,render-to-html-flight}.ts`.
- **Remix migration: more of the surface, and the deferred-rejection edge (`useFetchers`, `useBlocker`, `useCatch`/`CatchBoundary`, `<Await errorElement>`, and the `start`-task perms).** Five follow-ups from the "perfect-ish" review: (1) **`useFetchers`** — an app-wide registry of in-flight fetchers for aggregated optimistic UI / a global pending indicator (each `useFetcher` publishes its live snapshot; the array surfaces the active ones). (2) **`useBlocker`** — veto an in-app soft navigation (unsaved-changes guard) via a new `navigate()` seam (`setSoftNavBlocker`), with the blocked→proceed/reset state machine; one active blocker, soft-nav only (browser back/forward + unload are documented bounds). (3) **`<Await errorElement>` now renders on a rejected `defer()`** — the rejection serializes to a plain error marker in the tail Flight (shared across all three serializers via `flight-scalar`), and `<Await>` renders `errorElement` with the error on `useAsyncError` (previously it rendered children with `null`); the client-promise path is covered too. (4) **Remix v1 `CatchBoundary`** — detected and wired to `error.tsx` (rendering it when it's the only boundary), with `useCatch()` added to read a thrown `Response`, plus a review note steering toward the v2 `ErrorBoundary` + `isRouteErrorResponse`. (5) The migrate-generated **`start` task now uses `-A`** — a migrated app re-execs a child `deno` at startup (CSS shim map + manual-node_modules module config), which a scoped perm set crashed on (`NotCapable`). Also: `shouldRevalidate` is extracted + flagged (denext always-revalidates — a documented perf-parity gap, not a correctness one). Validated end-to-end on the stock indie-stack. `src/compat/remix/client.ts`, `src/client/navigation.ts`, `src/jsx/{flight-scalar,render-to-flight,render-to-html-flight,render-to-flight-stream}.ts`, `src/build/{remix-migrate,hydration,migrate}.ts`.
- **Remix migration: two real-world bugs (found validating a shop app with `lucide-react`/`clsx` + sessions).** (1) `@remix-run/*` imports in **shared non-route modules** (e.g. `app/sessions.ts`, utils, components) were left un-rewritten — the route transform only touched `app/routes/*` — so the build couldn't resolve them; the migration now remaps `@remix-run/*` / react-router imports across **all** app source. (2) A loader/action `Response`'s **`Set-Cookie` was dropped** when denext converted it to a redirect signal or JSON payload — breaking the canonical Remix login (`session.set(...)` then `redirect(url, { headers: { "Set-Cookie": await commitSession(session) } })`); the unwrap now forwards `Set-Cookie` onto the request's outgoing response, so the session cookie is set alongside the redirect. Verified end-to-end: the app migrates, builds (npm UI libs bundled), and the full login → Server Action → session commit → redirect → signed-in flow works in a real browser. `src/build/remix-migrate.ts`, `src/compat/remix/server.ts`.
- **Remix session & cookie storage is now implemented** (previously a stub that didn't persist). `createCookie` is a first-class cookie that JSON-encodes its value and, given `secrets`, signs it with HMAC-SHA256 (tamper-evident, secret rotation) — reusing denext's own signed-cookie crypto — with a proper `Set-Cookie` serializer (Path/HttpOnly on by default, plus Max-Age/Expires/Domain/Secure/SameSite). On top of it: `createCookieSessionStorage` (whole session in the signed cookie, 4 KB guard), `createSessionStorage` (session id in the cookie, data in a caller-supplied store), and `createMemorySessionStorage` (a `Map`-backed store for dev/tests), each returning `getSession`/`commitSession`/`destroySession`, with a `Session` that supports `get`/`set`/`has`/`unset` and read-once `flash`. Multipart uploads land too: `unstable_parseMultipartFormData` (+ `parseMultipartFormData` alias) streams file parts through an `uploadHandler`, with `unstable_createMemoryUploadHandler` provided. `src/compat/remix/server.ts`, `src/server/session.ts` (crypto helpers exported).
- **Remix `defer()` data now crosses the Flight boundary, and `useFetcher` loads/submits cross-route.** Two fixes: (1) a promise-valued client-component prop — a Remix `defer()` field, or any promise passed as data — previously serialized to `{}` (deferred data silently lost); the Flight serializers (streaming, HTML-flight, and PPR) now **await** a thenable prop and serialize its resolved value, so `<Await>`/`useAsyncValue` render real data (awaited, not yet incrementally streamed). Applied consistently across all three serializers via a new shared leaf-serialization helper (`src/jsx/flight-scalar.ts`), with taint-checking preserved on the resolved value. (2) `useFetcher` is no longer a soft-navigation stub: `fetcher.load(href)` fetches a route's loader data without navigating (a page route via its Flight payload, a resource route via its JSON), and `fetcher.submit`/`fetcher.Form` with an explicit `action` URL POSTs there and reads back the result — each settling into `fetcher.data` and revalidating. A mutating `<Form>`/`<fetcher.Form>` now also honors an explicit cross-route `action` URL as its DOM action (progressive-enhancement + resource-route targets), while a form with no explicit action still binds to the current route's Server Action. `src/jsx/render-to-flight.ts`, `src/jsx/render-to-html-flight.ts`, `src/jsx/render-to-ppr-flight.ts`, `src/compat/remix/client.ts`.
- **Remix `defer()` now streams incrementally, and `useFetcher`/`<Form>` submit cross-route to a _page_ action** (the two remaining Remix review notes, closed). (1) On the default streaming Flight path a deferred promise prop no longer blocks the shell: the streaming serializer leaves a **value-hole placeholder** (instead of awaiting the promise — or, worse, the latent bug where it serialized to `{}`, which the non-streaming serializers were fixed for but `render-to-flight-stream` was not), so first paint flushes immediately with the `<Await>` fallback, the deferred content streams in as its Suspense boundary resolves, and the resolved value is substituted into the tail Flight — the client hydrates with real data. Placeholder ids are framework-generated (`dnxv…`) so user data shaped like a hole is never resolved away. (2) A migrated **page** route that has an `action` now also gets a generated `route.ts` POST handler, so a plain POST to the page URL runs the action (its URL params threaded from the matched pattern) — exactly Remix's "a POST to a route runs its action". denext dispatch lets `page.tsx` and `route.ts` coexist in one segment: a `route.ts` that has no handler for the request method (a 405) falls through to the page for a GET/HEAD render, so the page's GET and the route's action-POST are each served by method. `useFetcher.submit`/`<Form action>` to another page's action works (following a redirecting action as a soft navigation), and the no-JS cross-page post lands on the same handler. `src/jsx/render-to-flight-stream.ts`, `src/build/remix-migrate.ts`, `src/server/app.ts`, `src/compat/remix/{server,client}.ts`.
- **Remix migration: thrown `redirect()`/`Response` from a loader/action are honored, and routes keep their Remix-canonical ids** (both found stress-testing the real `remix-run/indie-stack` — auth, sessions, Prisma, nested routes — end-to-end). (1) Remix uses **thrown** `Response`s as control flow — `throw redirect(url)` is the ubiquitous `requireUserId` auth-guard, and `throw json()/new Response()` signals errors. denext previously honored only a _returned_ redirect and turned a thrown one into an unhandled 500; now `runLoader`/`bindAction` route a thrown redirect to denext's redirect signal and a thrown non-redirect `Response` to a `RemixRouteErrorResponse` (so `ErrorBoundary`/`useRouteError`/`isRouteErrorResponse` see it), and `runLoaderResponse`/`runActionResponse` (resource routes + the page-action `route.ts`) return a thrown `Response` as the response, forwarding its `Set-Cookie`. (2) The migration now threads each route's **Remix-canonical id** (`root`, `routes/notes`, `routes/notes.$noteId`) into the route provider instead of a denext-internal `<key>:<role>` — so an app that keys on those strings (`useRouteLoaderData("root")`, `matches.find(m => m.id === "routes/notes")`) resolves after migration. Verified against a fresh indie-stack: signup→session cookie→protected route, create/read a note, dynamic `[noteId]`, resource-route `logout`, and thrown-redirect auth guards all work through the migrated tree. `src/compat/remix/server.ts`, `src/build/remix-migrate.ts`.
- **Remix: a nested route can read an _ancestor_ layout's loader data during SSR** (`useRouteLoaderData("root")`, `useMatches().find(...)`, or `useUser()` → root loader — the indie-stack's protected `/notes` crashed on it). The streaming Flight renderer renders a client boundary's children twice — once for first-paint HTML (the ancestor `RemixRouteProvider`'s context is in scope) and once to serialize the boundary's `children`, where the nested route's server wrappers are re-expanded in the outer scope, so the parent provider's client context is missing and `useMatches` saw only the current route (any ancestor read threw and 500'd). Fixed with a **render-scoped matches store**: the server wrappers register each route's match (request-isolated via a `WeakMap` keyed by the request context, so it survives both passes and never leaks across requests), and `useMatches` prefers it when it is at least as complete as React context. A process-global seam bridges the server store to the `"use client"` hook without pulling `node:async_hooks` into the client bundle (and works even when the boundary is a separate bundle, e.g. next-compat); on the client the store is unset so the hydrated React tree is authoritative. Also: `@remix-run/css-bundle` is now rewritten to `denext/remix/server` (which re-exports `cssBundleHref` as `undefined`, since denext owns CSS), instead of being left as an unresolved import. `src/compat/remix/{matches-bridge,matches-server}.ts` (new), `src/compat/remix/{client,server}.ts`, `src/build/remix-migrate.ts`.
- **Remix `useNavigation` now reports `loading` during a plain `<Link>`/`useNavigate`/history navigation** (previously it only reflected `<Form>`/`useSubmit`/`useFetcher` submissions and stayed `idle` on a link click). denext's client router now publishes a process-wide soft-navigation signal — new public `subscribeNavigating` / `getNavigatingHref` on the client-navigation API — raised for the whole same-origin navigation (covering delegated link clicks, `useNavigate`, and `popstate`), with a monotonic token so an overlapping navigation, not a slow earlier one settling late, owns the signal. Remix's `useNavigation` reads it and returns `{ state: "loading", location }` with the target, while an in-flight submission still takes precedence as `submitting`. `src/client/navigation.ts`, `mod.ts`, `src/compat/remix/client.ts`.
- **Remix `<Form method="post">` action round-trip now drives the full Remix lifecycle** (browser-validated end-to-end). Two bugs kept a migrated Remix route's `<Form>` inert: (1) an interactive Remix route was misclassified as **static** — the hydration heuristic scans an app module for interactivity tokens but excludes framework internals, so a component whose only interactivity is `denext/remix`'s `useActionData`/`useNavigation`/`<Form>` shipped **zero JS** and never hydrated; the heuristic now recognizes the interactive Remix hooks/components (read-only `useLoaderData`/`useParams`/`useMatches` stay static). (2) The `<Form>` handed denext's reconciler the **Server-Action ref itself** as the DOM `action` — a _function_-valued `action` triggers denext's native React-19 form-action handling, which ran the action **outside** Remix's submit lifecycle (bypassing `useActionData`/`useNavigation`/revalidation); the `<Form>` now exposes only the endpoint **URL string** (no-JS progressive-enhancement fallback) and drives the submit through its own `onSubmit`→`runRouteAction`. Confirmed in a real browser: submit → `useNavigation` flips to `submitting` → the Server Action runs → `useActionData` reflects the result → the loader revalidates, with no full-page reload. `src/compat/remix/client.ts`, `src/build/hydration.ts`.
- **`renderToPipeableStream` fires `onShellReady` at the real shell flush.** It previously fired the instant the stream object existed — before any rendering — because the compat `renderToReadableStream` resolves immediately and the callback was attached to that. The adapter now peeks the shell (denext enqueues the whole shell as the first chunk) and fires `onShellReady` only once it has rendered; a shell that throws surfaces as `onShellError` (not a spurious `onShellReady`), matching React's contract. The remaining fidelity caveat — the document is buffered, not `Writable`-backpressured — is unchanged (it's a property of denext's push-based streaming core, documented in KNOWN-LIMITATIONS with the full rationale). `src/compat/react-dom-server.ts`.

### Docs

- **KNOWN-LIMITATIONS honesty pass.** Corrected entries that were labeled "intentional non-goal / by design" when the truth was "not yet built": `next/og`'s satori subset is named as **Next.js parity** (satori's engine, not a denext choice); `ViewTransition` now documents the route-level transition it ships; React `taint*` is now implemented (see Added); `Activity` real scheduling and Next `dynamicIO` are reclassified as tracked work (the latter under the experimental Cache Components effort) rather than non-goals. The static-export, `res.revalidate`, `res.write` streaming, and `i18n.domains` bullets are retired as those features landed.

## [2.0.0-rc.4] - 2026-08-30

### Added

- **New package `@denext/effect` — first-class [Effect](https://effect.website) support.** Run an `Effect` from a Server Component, route handler, or Server Action and get typed errors, dependency injection (services from a `Layer`), structured concurrency, and client-disconnect cancellation, all wired into denext's per-request context. Effect is npm-only (deliberately not on JSR), so the package depends on `npm:effect` as a peer and serves nothing — it is a set of runtime _bridges_, not a served asset (unlike `@denext/htmx`). Exports: `DenextRequest` (a request-scoped Effect service), `runEffect`/`runEffectExit` (ambient), `createEffectRuntime(layer)` (a fully-typed runner whose requirements are compile-checked), the `effect()` plugin (make an app `Layer` ambient + manage its lifecycle), and `effectHandler`/`effectAction` (adapt Effect-returning functions into a route handler / Server Action with typed-error mapping). The request is provided **fresh per run** (a `ManagedRuntime` memoizes its layers, so putting it in the layer would leak one request across all later runs), the request abort signal interrupts the fiber, and every run is `Effect.scoped`. `packages/effect/`. Example in `examples/effect/`.
- **`next/font/google` now honors `subsets` and `preload`.** Self-hosting already stripped the runtime Google request at build; now `subsets` actually reduces the payload — `rewriteGoogleFontFaceCss` keeps only the requested subsets' `@font-face` blocks, so other subsets' files aren't downloaded — and `preload` emits `<link rel="preload" as="font" crossorigin>` for a font's self-hosted files (ahead of the `<style>`, so the fetch isn't render-blocked). Both were previously accepted-but-advisory. `src/compat/next/font/{google,registry}.ts`, `src/build/self-host-fonts.ts`. (The metric-matched fallback `@font-face` and static-export self-hosting remain tracked separately — the former needs a bundled font-metrics database.)
- **`<Image>` now optimizes by default (behavior change, matching Next).** Previously `<Image>` rendered a plain `<img>` unless you passed a `loader`; it now routes through denext's built-in `/_denext/image` endpoint (resize + webp/avif) and generates a responsive `srcSet` with **allowlist-correct** widths (drawn from `deviceSizes ∪ imageSizes`, since the optimizer refuses any other `w=`) — the device-size ladder for a responsive image (`sizes` set), or the nearest allowlisted 1×/2× for a fixed-width one. Opt out per-image with the new `unoptimized` prop, or app-wide with `images.unoptimized`. **Static export forces `unoptimized`** (there's no server to optimize against; a per-image custom `loader` still works), and the resolved config is embedded as a `#__denext_image_config` island when non-default so a client re-render matches the server. `src/runtime/image.ts`, `src/server/{config,document}.ts`, `src/build/{prod-server,dev-server,export}.ts`.
- **OIDC `id_token` verification now accepts the ES and PS signature families, not just RS256.** `verifyIdToken` was hardcoded to `RSASSA-PKCS1-v1_5` + SHA-256, so a provider issuing `ES256` (ECDSA, common with modern IdPs), `PS256` (RSA-PSS), or `RS384`/`RS512` tokens failed sign-in with `unsupported id_token alg`. An `algParams` map now drives WebCrypto import + verify for `RS256/384/512`, `PS256/384/512`, and `ES256/384/512` (EC keys read `crv`/`x`/`y` from the JWKS); the key `kty` must match the alg family. Any other `alg` — including `none` and the `HS*` confusion vector — is still refused. `src/server/auth/jwt.ts`.
- **`identifierPrefix` now disambiguates `useId` across multiple roots.** `createRoot(el, { identifierPrefix })` / `hydrateRoot(el, ui, { identifierPrefix })` and the server `renderToString`/`renderToStaticMarkup({ identifierPrefix })` previously accepted the option but ignored it, so two React roots on one page emitted colliding `useId` values. The prefix now seeds the root's `useId` scope on both the client reconciler and the SSR renderer (default `""` — byte-identical to before); pass the same prefix to the server render and to `hydrateRoot` so ids align on hydration. `src/client/fiber/reconciler.ts`, `src/jsx/render-to-string.ts`, `src/compat/react-dom-server.ts`. (The three `RootOptions` error callbacks remain accepted-but-not-invoked, tracked separately.)
- **`better-sqlite3` compat gains `aggregate`, `backup`, `serialize`, `loadExtension`, and a real `expand`.** Calling any of the four missing methods previously threw `undefined is not a function`, and `expand()` was a no-op. Now: `aggregate(name, {start, step, inverse, result})` delegates to `node:sqlite`'s aggregate (custom aggregate/window functions); `backup(dest)` returns a Promise and writes an atomic copy via `VACUUM INTO`; `serialize()` returns the DB as a `Uint8Array` (via a temp `VACUUM INTO`, so it works for `:memory:` too); `loadExtension(path)` delegates to `node:sqlite` (opt in with the new `{ allowExtension: true }` open option, which `node:sqlite` requires); and `expand()` now groups a row's columns under their source table (`{ users: {...}, posts: {...} }`) using array-mode rows so same-named JOIN columns don't collide. `src/compat/better-sqlite3.ts`.
- **`next-intl` localized pathnames now translate URLs per locale.** `createLocalizedPathnamesNavigation` was a bare alias of `createNavigation` that ignored the `pathnames` map, so a route like `/en/about` ↔ `/de/ueber-uns` produced the untranslated URL. When the routing config carries `pathnames` (`{ "/about": { en: "/about", de: "/ueber-uns" } }`), `Link`/`getPathname`/`redirect`/`router.push`/`replace` now translate the internal href to the active locale's path (and interpolate params for the `{ pathname, params }` href form), while `usePathname` reverse-translates the localized path back to the internal one. `src/compat/next-intl/routing.ts` (new `Pathnames` type + `pathnames` config), `navigation.ts`. Bound: reverse translation covers static paths (dynamic-segment reverse lookup is not matched).
- **`next-intl` translators now support `t.rich()` and `t.markup()`.** A message with `<tag>…</tag>` callback markup — `t.rich("msg", { link: (chunks) => <a>{chunks}</a> })` — previously threw `t.rich is not a function`; both are now first-class on every translator (`useTranslations`, `getTranslations`, `createTranslator`). `rich` returns a node tree (tag handlers return nodes); `markup` returns a string (tag handlers return strings, for non-React contexts). Top-level and nested tags, self-closing tags, and ICU interpolation inside text runs are all handled, reusing the existing zero-dependency ICU engine (`src/compat/next-intl/rich.ts`, `context.ts`). Bound: a tag placed **inside** an ICU `{…}` argument (e.g. within a `plural` branch) is left to the ICU engine as literal text — put rich tags at the message top level.
- **`denext desktop package` now builds Linux bundles** (previously macOS-only). `deno desktop` cross-compiles a complete Linux app bundle (executable + `.so` + a freedesktop `.desktop` launcher); the new scaffolded `scripts/package-linux.ts` builds one or both arches (`x64`/`arm64`) and wraps each as a distributable `.tar.gz` — plus an AppImage when `appimagetool` is on PATH. `denext desktop package --target-os linux` cross-builds the Linux bundle from any OS (verified: a cross-built binary runs on a real x86_64 Linux host). App names are slugified for artifact paths, and arch labels are underscore-free so `deno desktop` keeps the `.desktop` launcher. macOS packaging (`.app`, codesign/notarize) is unchanged; Windows is still tracked in KNOWN-LIMITATIONS. `src/build/scaffold.ts`, `src/cli/commands/desktop.ts`.
- **`react-dom/server` Node-stream APIs now work** (previously threw). `renderToPipeableStream(node, options)` returns a `{ pipe(writable), abort() }` controller and `renderToStaticNodeStream(node)` returns a Node `Readable`, implemented as a thin `node:stream` adapter over denext's Web-stream renderer — so npm libraries that hard-code the Node-stream SSR API interoperate. They honor `onShellReady`/`onAllReady`/`onError`/`signal`; the documented fidelity caveat is that the document is buffered (no `Writable` backpressure) and `onShellReady` ≈ first-chunk-available. denext's own apps should still use `renderToReadableStream`. `src/compat/react-dom-server.ts`.

- **`denext/testing` gains `userEvent`, async `findBy*`/`waitFor`, and a broader `getByRole` table.** The component-testing surface moves closer to `@testing-library/react`: **`userEvent`** (`click`/`dblClick`/`type`/`clear`/`keyboard`/`selectOptions`, plus `userEvent.setup()`) dispatches the realistic multi-event sequence a user interaction produces (e.g. `type` fires keydown → value+char → input → keyup per character), more faithful than a single `fireEvent`; **`waitFor(cb, {timeout, interval})`** retries an assertion (flushing pending effects/state between attempts) and **`findBy*`/`findAllBy*`** await an element that appears after an async effect; and **`getByRole`'s implicit-role table** now covers `main`/`article`/`banner`/`contentinfo`/`complementary`/`region`/`form`/`figure`/`separator`/`progressbar`/`dialog`/`table`/`row`/`cell`/`columnheader`/`rowgroup`/`group`/`option`/`searchbox`/`slider`/`spinbutton` and `listbox` for a multi-select, on top of the existing set. `src/testing/render.ts`, `src/testing/mod.ts`.
- **i18n `localePrefix: "always"`.** In addition to the default `"as-needed"` (default locale unprefixed, others prefixed), i18n now supports `localePrefix: "always"` — every locale is prefixed including the default, so `localeHref` produces `/en/about` and `localeMiddleware` redirects an unprefixed path to the detected (or default) locale's prefix. `src/server/i18n.ts`. (Domain-based per-domain locale routing remains tracked in KNOWN-LIMITATIONS — it needs host-aware routing.)
- **Compat correctness cluster: `react-is` classification, bounded `React.cache`, and a runtime `server-only` guard.** (1) `react-is`'s `typeOf` now classifies context providers/consumers, `Profiler`, and `StrictMode` (returning `ContextProvider`/`ContextConsumer`/`Profiler`/`StrictMode`) instead of `undefined` — the `isX` predicates already recognized them; `typeOf` now agrees (`src/compat/react-is.ts`). (2) `React.cache`'s off-request persistent memo no longer accumulates distinct **primitive** args without limit — each node is bounded (1024, oldest evicted); request-scoped memos stay uncapped (freed with the request, matching React) and object args already used a WeakMap (`src/compat/react.ts`). (3) The compat `server-only` module now throws at import if evaluated in a **client** runtime (defense-in-depth behind the build-time env-poison plugin, matching the npm package); `client-only` stays inert because denext server-renders client components, so their `import "client-only"` runs on the server legitimately — a throw there would break SSR (`src/compat/{server-only,client-only}.ts`).
- **`createRoot`/`hydrateRoot` now invoke the `onCaughtError`/`onUncaughtError`/`onRecoverableError` callbacks (React 19 parity).** They were accepted but ignored. Now `onCaughtError` fires when an error boundary catches a render, effect, or event error; `onUncaughtError` fires when an error reaches the root with no boundary (the error still surfaces afterward, as before); and `onRecoverableError` fires on a hydration mismatch (where denext keeps the client render), replacing the dev-only mismatch console warning and firing in production too. Behavior is unchanged when no callback is passed — a boundary still catches, an uncaught error still throws, a mismatch still dev-warns — and a callback that itself throws is caught so it can't corrupt the reconciler. `src/client/fiber/reconciler.ts`.
- **Pages Router Preview Mode (`res.setPreviewData` / `context.preview` / `previewData`).** An API route can now call `res.setPreviewData(data)` to enter Preview Mode and `res.clearPreviewData()` to exit; on a subsequent page request `getStaticProps`/`getServerSideProps` see `context.preview === true` and `context.previewData`, and the static/prerendered cache is bypassed so a CMS draft renders live. The preview cookie is **HMAC-SHA256 signed** so it can't be forged (a forged cookie is ignored — it never discloses drafts, only forces a live render); the signing secret is read from `DENEXT_PREVIEW_SECRET` (comma-separated to rotate), falling back to a random per-process key with a one-time warning (preview then works within a process but not across restarts/instances). `packages/pages-router/src/{preview,api,handler}.ts`.
- **Pages Router `getStaticPaths` `fallback: true` now serves a props-less shell + `router.isFallback`.** Previously an unlisted dynamic path with `fallback: true` behaved like `"blocking"` (rendered live, `isFallback` never true). Now the HTML request renders a **props-less shell** with `router.isFallback === true` (and `isReady === false`), and after hydration the client fetches the real `getStaticProps` data for that path and re-renders with it (`isFallback → false`); a not-found/redirect during that fetch falls back to a full load. `fallback: false` still 404s an unlisted path and `"blocking"` still renders live. `router.isFallback` is now a first-class field on `NextRouter` (Next parity). `packages/pages-router/src/{handler,client-runtime,render}.ts`, `packages/pages-router/router.ts`.
- **Pages Router `next/head` now hoists `<script>` (e.g. JSON-LD), `<style>`, `<base>`, and `<noscript>` into `<head>`, not just `<title>`/`<meta>`/`<link>`.** Previously only the React-19 metadata tags were hoisted; a `<script type="application/ld+json">` or `<style>` inside `<Head>` rendered inline in the body. On the server these are now routed into `<head>` via the `useServerInsertedHTML` sink (scoped to the `<Head>`'s own children, so an ordinary body `<script>` is untouched — unlike the renderer's tree-wide metadata hoist), while `<title>`/`<meta>`/`<link>` keep the hoist-and-dedupe path. On the client the head manager applies and reconciles the broader tag set across soft navigation (content-hashed dedupe keys so two distinct JSON-LD blocks coexist). `packages/pages-router/head.ts`, `packages/pages-router/src/{head-manager,render}.ts`.
- **Pages Router SSG now threads the default locale into `getStaticProps` and `__NEXT_DATA__`.** Prerendering hardcoded `context.locale = undefined`, so a `getStaticProps` on an i18n site couldn't tell which locale it was rendering and the prerendered `__NEXT_DATA__` carried no locale metadata. It now passes the real `defaultLocale` (plus `locales`/`defaultLocale`) to `getStaticProps` and embeds them in the page's `__NEXT_DATA__` + `props.json`, matching the live-render path. Non-default locales continue to render live at request time (the handler's existing design), so they aren't prewritten. `packages/pages-router/src/ssg.ts`, `packages/pages-router/mod.ts`.
- **Pages Router API routes honor `export const config.api.bodyParser` and parse `multipart/form-data`.** Previously an API route always parsed JSON / urlencoded / text and ignored `config`. Now `export const config = { api: { bodyParser: false } }` hands the handler the **raw `Uint8Array`** body unparsed (for webhooks that verify a signature over the exact bytes), `{ bodyParser: { sizeLimit: "500kb" } }` (or a byte count) rejects an oversize body with **413** before the handler runs (default 1 MiB, matching Next), and a `multipart/form-data` request is parsed into `req.body` as an object of fields + `File` objects (a denext convenience — Next requires an external parser). `packages/pages-router/src/api.ts`. (On-demand `res.revalidate` and true `res.write` streaming remain tracked separately.)
- **A discrete DOM event stays urgent while an async transition is pending, and the AsyncContext transform now instruments async generators.** Two parts of the concurrent-scheduling story, both low-impact: (1) **The default (non-scoping) async-transition window no longer demotes user interactions.** Previously, while any `startTransition(async …)` promise was pending, _every_ update was entangled at transition priority — so a click or keystroke during a slow transition was deferred and felt laggy. An update enqueued synchronously in a DOM event handler now keeps its natural (urgent) priority, matching React's lane model where discrete events are never demoted by a transition; only updates _outside_ any event handler (the transition's own post-`await` continuations) remain entangled. `src/client/event-priority.ts` (new), `src/client/dom-props.ts`, `src/client/fiber/reconciler.ts`. (2) **`experimental.asyncContext` now instruments async generators** (`async function*`), the documented v1 gap: each `await` is bracketed as before and each `yield V` becomes `__asyncResume($, yield __asyncYield($, V))`, so the frame's AsyncContext is handed back to the caller while suspended and restored on resume — proven by a test where the frame's value survives awaits and yields even when the caller resumes the generator under a different context. The frame is captured at the first `.next()` (resume-time; TC39 [hasn't settled](https://github.com/tc39/proposal-async-context/issues/18) creation- vs. resume-time capture). A generator using `yield*` delegation is left uninstrumented (delegation suspends through a sub-iterator) rather than mis-instrumented. `src/build/async-context-transform.ts`, `src/runtime/async-context.ts` (`__asyncYield`/`__asyncResume`). Both changes are inert for code that isn't an event handler / async generator.
- **The auto-memo compiler now memoizes `.map()` / list expression containers and no longer bails a whole module on dynamic `import()`.** Previously the experimental compiler (`experimental.autoMemo`) only reached JSX _elements_ in return/child position — it left every `{…}` expression container verbatim, so the single biggest win, `{items.map((it) => <Row … />)}`, was never memoized — and it skipped any module using a dynamic `import()` entirely. Now a `{…}` child whose expression contains a component element is memoized **as a whole** (keyed on its reactive dependencies), so a stable list reuses the same element array across parent re-renders and the reconciler bails the whole subtree (proven by a render-count test: a 3-item list renders each row once and skips re-render across parent updates). Soundness is preserved by a conservative free-variable analysis — every free identifier in the container must be classifiable as a tracked component-scope dependency, a module-level/imported name, or a well-known global; an unclassifiable free var (e.g. a nested-block binding the top-level scan can't see) leaves the container verbatim rather than risk a stale value. And a dynamic `import("./rel")` is now absolutized like a static import (so the temp-dir transformed module resolves it), which is what let the whole-module dynamic-import bail be removed. SSR output is byte-identical (server `useMemoCache` returns a fresh sentinel array each render). `src/build/compiler.ts`.
- **The migration codemod now rewrites `require()` / dynamic `import()` and never silently skips a `next/*` import.** `denext codemod` previously rewrote only static `import`/`export … from` statements — a `require("react-dom/client")` or `const m = await import("react")` was left pointing at the npm package, and an unrecognized `next/*` subpath (e.g. `next/experimental/foo`) passed through with no notice. Now a plain module-identity remap (react → denext, `react-dom/client` → `denext/client`, …) is rewritten inside `require(…)`/`import(…)` too; a default-component specifier (`next/link`) or a Pages-Router file seen in call form is flagged with a hand-conversion hint (its module _shape_ changes, so it can't be safely rewritten inside a call); and any unmapped `next/*`/`next-intl/*` subpath now raises a warning noting it was left to resolve through the `next/*` compat alias. `src/build/codemod.ts`.
- **`denext migrate` now gives per-key guidance for unsupported `next.config` keys instead of a lumped drop.** A recognized-but-unhonored key (`env`, `transpilePackages`, `output`, `reactStrictMode`, `pageExtensions`) was reported only as a bare name in a `// Dropped unsupported next.config keys: …` comment. The generated `denext.config.ts` now emits a specific line per load-bearing key pointing at its denext equivalent (`env` → `publicEnv`/runtime env; `output` → `deno task export`/`build`; `transpilePackages` → not needed, Deno transpiles deps natively; `reactStrictMode` → `<StrictMode>`), and groups only the genuinely-inert keys (`webpack`, `compiler`, …) on a single "no equivalent needed" line — so nothing load-bearing is dropped without a pointer to how to reproduce it. `src/build/migrate.ts`.

- **`denext generate docker`** — scaffold container files on request (Angular/Nest-style), writing `Dockerfile`, `docker-compose.yml`, and `.dockerignore` at the project root. The image is auto-detected from the app: an App Router / SSR app gets a build-and-`deno task start` server image (listens on 3000, binds `0.0.0.0`); a `mode: "spa"` app gets an export-and-serve static image (`deno task export` → `@std/http/file-server` on `out/`). Force the variant with `denext generate docker server` / `denext generate docker spa`. The base image is pinned to the Deno version that generated it, the compose file ships a commented Postgres service, and existing files are never overwritten (idempotent, so a hand-edited `Dockerfile` is safe on re-run).

### Changed

- **Pinned Deno toolchain bumped `2.9.5` → `2.9.6`** (CI `fmt`/`lint` reproducibility). The four `deno-version` pins in `.github/workflows/ci.yml` now track `2.9.6`, and the repo was re-formatted with it (`deno fmt`) — a formatter-only normalization (line-wrapping / trailing commas across `examples/`, `packages/`, `bench/`, and the docs site; **no `src/` changes** and no behavior change). Contributors should run Deno `2.9.6` locally so `deno fmt --check` matches CI.

### Fixed

- **`useActionState`'s `permalink` argument now enables no-JS form submits.** The React 19 third argument was accepted but ignored. When you pass a permalink, the `dispatch` used as `<form action={dispatch}>` now renders that URL as the SSR `action` attribute, so a form submitted before hydration navigates to the permalink instead of being lost; after hydration the client dispatch takes over. `src/runtime/actions.ts`, `src/jsx/render-to-string.ts`.
- **A capturing `qrl` handler now resumes correctly instead of throwing.** In resumable mode the server stamped `data-dnx-h="evt:id"` for every `qrl` handler, so the delegated dispatcher ran a _capture-carrying_ handler with no scope and its `capturedScope()` threw (`capturedScope() called outside a qrl handler`). Because a handler's captures are the component's **live** signals/stores — which exist only once it mounts — such a handler can't run without mounting; it's now stamped bare `evt` (like a plain handler), so the client hydrates its island and re-runs it with the live captures. Closure-free qrls keep the fast no-mount `evt:id` path. `src/jsx/render-to-string.ts`.
- **The lint plugin's hook rules are now independently toggleable.** The module documented four rules but registered only two: `hooks-in-component` and `no-hooks-in-async` were emitted from inside `rules-of-hooks`, so all three hook findings reported under one id and couldn't be enabled/disabled or `// deno-lint-ignore denext/no-hooks-in-async`'d on their own. They're now three separate rules over one shared traversal (identical detection, so no behavior change) — each carries its own `denext/<rule>` id. `src/lint/denext-plugin.ts`.
- **`getServerSideProps` can now set cookies/headers via `context.res`, and sees `locales`/`defaultLocale` (Pages Router).** The gSSP context previously carried `req` but no `res`, so a page couldn't set a `Set-Cookie` or `Cache-Control` header from data fetching, and the i18n `locales`/`defaultLocale` were only in `__NEXT_DATA__`, not the context. `context.res` is now a minimal `ServerResponse`-shaped shim (`setHeader`/`getHeader`/`removeHeader`/`hasHeader`) whose headers are merged onto the outgoing response (multiple `Set-Cookie`s preserved), and `context.locales`/`context.defaultLocale` are populated from the i18n config. `packages/pages-router/src/handler.ts`.
- **`<Link replace>` now replaces the history entry (Pages Router).** The `replace` prop was accepted and documented but dropped — a soft-nav click always pushed. `Link` now emits a `data-denext-replace` marker that the client runtime honors by calling `history.replaceState` instead of `pushState` (matching `router.replace`). `packages/pages-router/link.ts`, `src/client-runtime.ts`.
- **The build now warns instead of silently dropping a transform rewrite.** When the experimental `experimental.asyncContext` pass instruments a module that the auto-memo compiler or the qrl handler-splitter also rewrote, only one rewrite could reach the client bundle (the maps are keyed by module URL and the last spread won). The build now logs a `WARNING` naming the affected modules rather than losing a rewrite in silence — the two experimental passes still aren't expected to be combined, but the collision is no longer invisible. Also removed a dead always-true ternary in the catch-all route matcher and corrected two stale source comments (`next/router` file scan, `react-dom/test-utils`). `src/build/build.ts`, `src/router/segments.ts`, `packages/pages-router/src/scan.ts`, `src/compat/test-utils.ts`.
- **`client:*` island directives now type-check on any component.** Writing a resumability hydration directive on an island — `<Widget label="x" client:idle />` — was a TypeScript error (`Property 'client:idle' does not exist on type '{ label: string; }'`) because the directives weren't declared anywhere in denext's JSX namespace. They're now on `JSX.IntrinsicAttributes` (`src/jsx/types.ts`) — the standard mechanism for props allowed on every element, the same place `key` lives — so `client:load` / `client:idle` / `client:visible` / `client:interaction` / `client:media` (boolean or a media-query string) / `client:only` are optional on all intrinsic tags and components without each component redeclaring them. Purely additive; the runtime already strips every `client:*` key before it reaches the DOM.
- **`cacheKeyParams` now dev-warns when a cached render bakes in a dropped `searchParams`.** Narrowing the ISR key with `cacheKeyParams` (so junk params don't fork the cache) has a documented edge: a `searchParams` value the key ignores, read into a whole-body-cached render, is baked into the shared entry and can be served to other requests. When the entire body is cached (a plain ISR render or a no-hole PPR/Flight shell), denext now records which param names the render read and, in dev, warns and names the dropped ones — turning a silent correctness boundary into a loud one. A with-holes PPR shell can still escape the read into a per-request hole, so it relies on the documented boundary rather than the warning. Zero cost when `cacheKeyParams` isn't set (the `searchParams` object is untouched). `src/server/request-context.ts`, `src/server/render-page.ts`, `src/server/app.ts`.

### Security

- **Production-readiness + security audit remediation.** A fresh adversarial audit (six analysis passes + a multi-step chain pass, scoped _beyond_ the CVE-guide floor) surfaced and this release fixes:
  - **Middleware auth-bypass via duplicate slashes (HIGH).** The router drops empty path segments (`//admin` resolves to the `/admin` page) but an anchored middleware matcher / config rule tested against the raw pathname did not — so `//admin` reached a page while skipping its `/admin` guard. The pipeline now collapses `/`-runs and 308-redirects the non-canonical form before config rules, middleware, and routing, so all three evaluate the same path. `src/server/app.ts`.
  - **`unstable_cache` cross-request data leak (HIGH).** Reading `cookies()`/`headers()`/`connection()` inside an `unstable_cache` body did **not** throw (its sibling `"use cache"` does), so a per-user value could be cached under a session-less key and served to others. The loader (and its SWR revive) now run inside a cache scope, so such a read throws — matching `"use cache"` and Next. `src/server/cache.ts`.
  - **`cacheKeyParams` cross-user cache poisoning in production (HIGH).** A whole-body-cached render that read a non-allowlisted `searchParams` baked that value into the shared entry; the guard was **dev-only**. The store now **refuses** such a render in every environment (dev still warns). `src/server/{request-context,app}.ts`.
  - **`<Live>` re-render fan-out DoS (HIGH).** A single `revalidateTag` could spawn one full-route re-render per connection (default cap 10 000) simultaneously. A fleet-wide `live.limits.maxConcurrentRenders` gate (default 40) bounds the fan-out; excess queues. `src/server/{live,config}.ts`.
  - **Flight `$`-discriminant collision → forged VNode / XSS (MED).** An attacker-influenced data object shaped like a Flight control tag (`{ $: "h", … }` — e.g. a store document, or `searchParams` `?$=h`) was re-read on the client as a tag, forging a `dangerouslySetInnerHTML` VNode (XSS) or crashing hydration. The serializer now escapes a leading `$` in user-object keys and the parser reverses it, so such objects round-trip as data. `src/jsx/render-to-html-flight.ts`, `src/client/flight-client.ts`.
  - **OIDC `email_verified` not enforced (MED).** The built-in Google / generic-OIDC profile mappers copied `email` unconditionally, so an attacker-controlled unverified address could feed an app that links accounts by email. The mappers now drop the email when the IdP marks it `email_verified: false` and surface `AuthUser.emailVerified`. `src/server/auth/providers.ts`, `types.ts`.
  - **Tailwind standalone binary executed without integrity check (MED, build-time).** The downloaded binary now has its SHA-256 verified against a pin (`DENEXT_TAILWIND_SHA256` or a built-in table) and fails closed on mismatch; an unpinned download prints its digest and warns instead of running silently. `src/build/tailwind.ts`.
  - Plus hardening: Live data-subscription **re-authorization on every recompute** (stops pushes after mid-session revocation) and **numeric-limit validation** (a bad-type cap like `maxMessageBytes: "64kb"` can no longer silently disable a control); JWT **`typ` pinning** (rejects an `at+jwt` access token as an id_token) and **per-candidate JWKS resilience** (a malformed key mid-rollover no longer aborts verification); ICU parser **nesting-depth cap** (untrusted message strings can't overflow the stack); and the precompressed **`.gz` static sibling** now gets the same symlink-escape recheck as the identity file. Regression tests in `tests/{security-remediation,auth-crypto,middleware,cache,config,static,live-data}.test.ts`.
- **Deferred-item hardening (audit follow-up).** The four items the audit above tracked as PLAUSIBLE / lower-severity are now closed:
  - **Data-cache follower abort-escape.** A single-flight _follower_ (`unstable_cache` / `"use cache"` coalescing onto another request's in-flight compute) awaited the leader with a bare `await`, so a hung leader body pinned every follower even after the follower's own client disconnected. Followers now race the wait against their request signal and unwind on abort — the leader keeps running for others — mirroring the page-cache follower. `raceAbort`/`isAbortError` extracted to `src/server/abort.ts`; `src/server/{cache,app,request-context}.ts`.
  - **Live per-render deadline (slot-exhaustion DoS).** A `<Live>` re-render or `useLive` fetcher holds one of the `maxConcurrentRenders` slots for its whole duration; a hung user fetcher held its slot forever, and enough hung fetchers pegged the gate and stalled the fleet. New `live.limits.renderTimeoutSeconds` (default **30**, on by default) aborts an over-running render (a cooperative `AbortSignal` reaches the fetcher's `fetch`/cache reads) and releases the slot, sending an error/refresh frame. `src/server/{live,config}.ts`.
  - **Config numeric validation now throws at boot.** `hsts.maxAge`, `images.{deviceSizes,imageSizes,qualities,minimumCacheTTL,maximumRedirects}`, and `cache.{maxDataEntries,maxPageEntries}` were trusted unvalidated — a `NaN`/`Infinity`/negative flowed into a `max-age` header, a redirect-loop bound, or an eviction count. `validateDenextConfig` now rejects non-finite / out-of-range values (fail fast, field-named). `src/build/paths.ts`.
  - **GitHub verified-email enforcement.** The `github` provider copied `userinfo.email` unconditionally (an unverified, user-chosen address). The flow now fetches `/user/emails` (via the already-requested `user:email` scope) and the mapper exposes only a provider-**verified** address, setting `AuthUser.emailVerified` — matching the Google/OIDC `email_verified` hardening. New `OAuthProvider.userEmailsUrl` + `ProfileInput.emails`. `src/server/auth/{providers,routes,flow,types}.ts`.
  - Regression tests in `tests/{cache,use-cache,live-data,paths,security-remediation}.test.ts`.
- **CVE defense suite: eleven new Next.js/React parity tests** (`tests/nextjs-cve-parity.test.ts`), from an August-2026 review pass against the Next.js **August 2026 security release** plus a back-propagation sweep. Covers the two new August advisories — **CVE-2026-75604 / GHSA-p293-qw3h-jr36** (Windows-filesystem path-traversal RCE: `serveStatic` containment holds under backslash/UNC/drive/mixed-encoding escapes; denext also has no dual Pages+App legacy cache-path) and **GHSA-2xp9-vwfh-vxw4** (AVIF/`libheif` RCE: denext ships no `sharp`/`libheif`, decodes with wasm `@denext/photon`, and only ever _encodes_ AVIF via wasm `@denext/avif` when a route opts in **and** the client `Accept`s it) — and nine previously-`⚪`/back-propagated rows: image-fetch credential non-forwarding (CVE-2025-57752), inline data-island `<script>`-breakout escaping (CVE-2026-44580), hash-based CSP with no reflected nonce (CVE-2026-44581), SSR attribute-name injection (React CVE-2018-6341), i18n internal-path DoS (CVE-2022-21721), unhandled-rejection containment (CVE-2022-36046), i18n data-route middleware bypass (CVE-2026-44573), soft-nav cache-variant partitioning (CVE-2026-44582), and a disputed open-redirect confirm (CVE-2020-15242). All assessed as **already immune** (regression tests, no source fix needed). `CVE-DEFENSE-GUIDE.md` updated.
- **CVE defense round 2: ten more parity tests** for CVE classes the guide did not yet track, prioritized worst-first. A new **§15 "first-party auth"** section back-propagates the **next-auth / Auth.js / `jsonwebtoken`** CVE history against denext's own OAuth/OIDC/JWT/session code (`tests/auth-crypto.test.ts`, `tests/auth.test.ts`, `tests/session.test.ts`): JWT `alg:none`/unsigned rejection (**CVE-2022-23540**), RS256→HS256 algorithm-confusion rejection (**CVE-2022-23541**), OAuth callback state/nonce/PKCE binding incl. foreign-provider tx (**CVE-2023-27490**, CVSS 8.1), foreign-JWT-as-session rejection (**CVE-2023-48309**), id_token `aud`/`iss`/nonce binding, no email-provider comma-injection (**CVE-2022-35924**, N/A by design), OAuth `callbackUrl` open-redirect coercion, and session fixation (CWE-384). Plus two fresh 2026 Next.js CVEs in `tests/nextjs-cve-parity.test.ts`: rewrite HTTP request smuggling (**CVE-2026-29057** — denext never proxies rewrites) and `/_next/image` disk-cache exhaustion (**CVE-2026-27980** — width+quality allowlists bound the variant space). All **already immune** (regression tests, no source fix). Two residuals documented in Known Gaps (weak-secret warn-not-throw; OIDC multi-`aud` membership).

## [2.0.0-rc.3] - 2026-08-28

### Added

- **`useAsyncEffect` and `tryCatch` are now exported from `denext`.** `useAsyncEffect(effect, deps)` runs an async effect with an `AbortSignal` and typed error handling (plus `useAsyncEffect.wrap` / `useAsyncEffect.setTimeout` helpers); `tryCatch` returns a `[ok, data] | [ok, error]` tuple (with `SuccessResult`/`ErrorResult`/`TryCatchResult` types) so error handling composes without a `try` block's scoping. Both were internal utilities; they are now first-class framework APIs.
- **Editor support out of the box.** The repo ships a shared Deno LSP config (`.vscode/settings.json` → `deno.enable`, `.vscode/extensions.json` → recommends `denoland.vscode-deno`) so a fresh clone resolves `denext`, the import map, and `jsxImportSource: "denext"` in VSCode/Cursor without setup — instead of the built-in Node TS server flagging bogus `react/jsx-runtime` errors. `denext migrate` generates the same config for converted apps (both App Router and SPA), merged additively into any existing `.vscode` and idempotent.
- **`DependencyList` is exported from the bare `denext` entrypoint** (previously only under the `react` compat alias), so code annotating deps arrays for denext's own hooks can import it from `denext`.
- **`spa.desktop.icon` — a config-file setting for the desktop app icon.** Point it at any file (`denext.config.ts` → `spa: { desktop: { icon: "../../assets/app-icon.png" } }`) and `export` prepares the bundle icon from it, overriding auto-detection. A configured **PNG is used verbatim** (supply a finished 1024² macOS master, e.g. from the app's own icon set); a JPEG/WebP is composed; when unset, denext auto-detects a web icon (`apple-touch-icon`, a named `icon`/`logo`, `favicon.png`) and composes it into Apple's macOS template (centered in the ~824px safe area of a 1024² canvas) so a small full-bleed favicon isn't baked oversized into the Dock. `deno desktop` bakes `--icon` full-bleed and ignores the macOS grid, which this works around. Editing the config and rebuilding is enough when an app icon was detected at migrate time (which wires `--icon` into the `deno task desktop` command); an app that had no icon then needs one `denext migrate --desktop` re-run after setting it.
- **`denext migrate --denext-local-path=<path>`** points the generated config at a local denext checkout (`file://`, resolved via its `deno.json` exports) instead of published JSR, and runs its local `cli.ts` in the tasks. For testing an unreleased/dev denext against a real app without publishing — a dev aid, not the shipped drop-in.

### Fixed

- **The build now works when denext is run straight from JSR**, not only from a local checkout. `frameworkRoot()` and 12 build call sites assumed the framework was on the local filesystem (`fromFileUrl(import.meta.url)` / `join(frameworkRoot(), …)` + `readTextFile`), so a migrated app's generated `deno task build` — which runs `deno run -A jsr:@denext/denext/cli build .` — threw `URL must be a file URL: received "https:"` before the build started. Framework-resource access is now scheme-agnostic (fetches when remote); validated by building minimal native **and** compat apps through an `http://`-served framework, guarded by `tests/e2e/remote-framework-build.e2e.test.ts`. (Pre-existing since ≤1.4.0; all prior validation used a local-file overlay that masked it.)
- **`migrate --desktop` generates a correct, runnable, right-sized `deno desktop` bundle.** The generated `desktop` task now bakes in what the packaged app needs: `--allow-net --allow-read --allow-env` (a compiled app runs with no permissions otherwise, so `runDesktop` threw `Requires env access to "PORT"` and the window came up black), `--include out` (embed the static export itself — it is read at runtime via dynamic paths, so without this it was left out of the bundle and the packaged app served nothing on another machine — verified: the `out/` assets return 200 from the packaged binary), and `--exclude-unused-npm` (embed only the npm packages the desktop entry reaches, not the app's whole lockfile — a monorepo SPA dropped from **2.4GB to ~104MB**). Validated by rebuilding + running a real monorepo SPA (T3) end to end.
- **`migrate` writes a `.gitignore` for denext's generated build artifacts** — `.denext/` (build cache), `out/` (static export), and (with `--desktop`) `desktop-icon.png` (the icon `export` composes from `spa.desktop.icon`; the config is the source of truth, this is just a build artifact). Creates the file if absent, appends only the missing lines under a one-line marker (never reorders/removes yours), and is idempotent.
- **The generated desktop `desktop.ts` always wires `spa.proxy`.** It now reads `config.spa?.proxy` unconditionally (harmlessly `undefined` when unset), so **adding a backend reverse proxy to `denext.config.ts` after migrating just works** — no `desktop.ts` hand-edit or re-migration. Previously the proxy branch was only emitted when `migrate --desktop --backend …` was used, so a proxy added later was silently ignored and the packaged app couldn't reach its backend same-origin (breaking cookie-authed local backends).
- **A converted pnpm/yarn app (`nodeModulesDir: "manual"`) now builds from a local denext checkout.** The build re-execs under the app's manual mode, which resolves _every_ npm specifier — the framework's own build machinery (`esbuild`, `sass`, `lightningcss-wasm`, …) included — from the `node_modules` beside the merged config. That tree carried only the app's deps, so the re-exec died with `Could not find a matching package for 'npm:esbuild@^0.24.0' in the node_modules directory` the moment it loaded `next-compat.ts`. The framework's own npm deps are now materialized into a framework-only `node_modules` beside the merged config (an isolated `deno install`, cached across builds); the app's own deps still resolve via the app's own config. Covers both the CSS and module re-exec paths; guarded by `tests/e2e/manual-node-modules-build.e2e.test.ts`. (Surfaced via `--denext-local-path`; the JSR path skips the re-exec entirely.)

- **`build`/`export`/`dev` no longer mutate a converted app's committed `deno.json`.** For a manual-`node_modules` app (converted Next/SPA), Deno resolves an app module's `.css` imports via the app's own `deno.json`, so denext had to add css→shim redirects there — and left them committed, with machine-specific absolute paths (`/Users/…/.denext/css-shims/*`), re-dirtying the file on every build (a commit-parity problem). Those redirects are now applied **transiently**: the CLI backs up the config, injects them for the build child, and restores the exact bytes once it exits (self-healing a killed run on the next build). `deno task build/export` leaves `deno.json` byte-identical. `migrate` also now gitignores the compiled Tailwind output (`src/index.gen.css`). Guarded by `tests/css.test.ts`.

- **Hook `deps` params now accept a `readonly` array (React parity).** `useEffect`, `useMemo`, `useCallback`, `useLayoutEffect`, `useInsertionEffect`, and `useImperativeHandle` (and the internal `Dispatcher` contract) typed `deps` as a mutable `unknown[]`, stricter than React's `readonly DependencyList` — so passing a `readonly` deps array (as `useAsyncEffect` does) was a type error. The whole surface is widened to `DependencyList`; strictly more permissive, so existing mutable-array callers are unaffected.

### Security

- **The desktop task now scopes `--allow-net` to loopback** (`--allow-net=127.0.0.1,localhost`) instead of granting unrestricted network to the compiled, distributable app. `runDesktop` binds `127.0.0.1` and the reverse proxy targets a loopback backend (the `spa.proxy` default), so the app has everything it needs while the binary can't reach the wider network. A non-loopback proxy (`allowNonLoopback`) needs the flag widened by hand. (`--allow-read`/`--allow-env` stay broad — a local desktop app needs them and narrowing risks breaking the runtime.)
- **Hardening of the new migrate/desktop surface** (from a pre-release audit): the framework-deps materialization now **pins exact versions** from the framework's `deno.lock` instead of caret ranges (no in-range / supply-chain drift for `.fwdeps`) and verifies the install actually completed before reusing it; `ensureGitignore` and the desktop-icon writer now **remove any pre-existing entry before writing** (a `.gitignore`/`desktop-icon.png` planted as a symlink can no longer redirect the write out of tree — `migrate` runs on cloned third-party repos); the `spa.proxy` loopback check matches the whole `127.0.0.0/8` block as a dotted quad instead of a `127.` prefix (rejecting `127.0.0.1.evil.com`); a configured `spa.desktop.icon` is format-validated (non-PNG rasters composed, `.ico`/`.icns` refused with a clear message + fallback) so an undecodable icon can't be written under a `.png` name; and a failed `node_modules` symlink now reports a clear diagnostic (Windows Developer Mode) instead of failing cryptically later.
- **The `.fwdeps` framework-deps install is serialized with a lock file**, so two concurrent builds of one app (a `dev` + a `build`, parallel CI) can't run `deno install` into the same directory at once and corrupt it — the loser waits and reuses the winner's install; a crashed holder's lock is stolen after a stale timeout.
- **The desktop icon is composed platform-aware**: the ~80% macOS safe-area margin is applied only when building on macOS; Windows/Linux get a full-bleed 1024² icon (a margined icon renders undersized in their taskbars/docks).
- **A `--denext-local-path` desktop build is now self-contained.** With a `file://` denext (the dev aid), the app config mapped `denext/*` to local files but not denext's OWN deps, so `deno desktop` compiled `denext/desktop`'s graph and the packaged app then died at launch with `Import "@std/path" not a dependency and not in import map`. `migrate --denext-local-path` now also carries denext's `jsr:`/`npm:` deps (`@std/*`, `ws`, …) into the app config so those modules resolve. No-op for published JSR (the package carries its own deps).

### Docs

- CONTRIBUTING.md documents the run-from-JSR build rule + how to test it locally; a new **Contributing** page on denext.dev renders it. The migrating guide notes that migrating a repo with `node_modules` needs `--node-modules-dir=none`, and that `migrate` writes a `.gitignore` for `.denext/`/`out/`/`desktop-icon.png`. The SPA/desktop guides document `spa.desktop.icon` and steer packaging to the flag-complete `deno task desktop`.

## [2.0.0-rc.2] - 2026-08-28

Post-rc.1 work on `development`: complete React/ReactDOM/Next **signature parity** and
the tooling that enforces it.

### Added

- **React/ReactDOM/Next signature-parity tool** (`scripts/parity/`, `deno task
  parity:refresh` / `parity:gaps` / `parity:drift`; gate test `tests/react-parity.test.ts`).
  Extracts the full public surface of the latest React, ReactDOM, and Next (via the
  TypeScript compiler API) and denext's compat surface (via `deno doc`), then asserts **no
  structural signature deviation** — export presence, value-vs-type, function arity/
  optionality, and object/namespace members — tolerant of internal type differences. A
  committed baseline + a burn-down "known-gaps" ledger keep the gate offline and
  deterministic; a weekly `parity-drift` CI job flags upstream surface changes.
- **Closed every signature-parity gap with React 19.2 / Next 16** (ledger 64 → 0):
  - **React:** `Activity`, `cacheSignal`, `captureOwnerStack`, `addTransitionType`,
    `optimisticKey`; `useState()` no-arg overload; `useOptimistic` single-arg form;
    `useActionState` `permalink`; `jsxDEV` dev args.
  - **ReactDOM:** `preloadModule`, `preinitModule`, `requestFormReset`; `createPortal` key;
    `createRoot`/`hydrateRoot` options; `react-dom/server` `resume`/`resumeToPipeableStream`
    and threaded `renderToString`/`renderToStaticMarkup` options.
  - **Next:** `next/navigation` `ReadonlyURLSearchParams` / `RedirectType` /
    `ServerInsertedHTMLContext` and `redirect(url, RedirectType)` push/replace; `next/head`
    `defaultHead`; `next/image` `getImageProps`; `next/script` `handleClientScriptLoad` /
    `initScriptLoader`; `next/dynamic` `noSSR`; `next/cache` `io` + `unstable_*` aliases;
    `next/server` `ImageResponse` / `URLPattern` / `userAgentFromString` / `NextFetchEvent`.
  - **next-intl:** `createTranslator`, `createFormatter`, `hasLocale`, `initializeConfig`,
    `IntlError` / `IntlErrorCode`, `IntlProvider`; `useNow(options)`; `createNavigation()`.
  - **Pages Router (`next/router`):** the `Router` singleton (default export) and `withRouter`.

### Changed

- **CI/publish:** `@denext/htmx` is wired into the tag-triggered publish workflow.

## [2.0.0-rc.1] - 2026-08-28

The 2.0 line: developer experience on a proven engine, plus a **Next.js drop-in compat
layer** deep enough to run unmodified App Router and Pages Router apps. Highlights — typed
routes, a durable cache on Deno's built-in `node:sqlite`, the first-party
observability/DevTools surface, and CSS-in-JS / MDX / cross-package-CSS support in the
compat build.

### Added

- **Unified CLI (2.0 Pillar I).** The CLI was rebuilt from an ad-hoc `switch` + `Deno.args`
  scanning into a real command framework (`src/cli/command.ts`): a registry with a declarative
  flag schema, uniform global flags (`--cwd`/`--config`/`--json`/`--verbose`/`--quiet`),
  per-command `--help`, "did you mean" suggestions, and `denext completions bash|zsh|fish`.
  New verbs round out a cargo-style surface: `add`/`remove`/`update` (dependency UX over
  `deno`), `test`/`lint`/`fmt`/`check` (passthrough to `deno`), `doctor`/`info` (diagnostics;
  `doctor` supersedes `probe`, kept as an alias), `audit` (dependency inventory + zero-npm
  runtime proof + CycloneDX SBOM via `--sbom` + baseline permission suggestion),
  `deploy` (pluggable adapter framework + a Deno Deploy adapter wrapping `deployctl`, with
  `--dry-run`), and `desktop build|run|package`. Plugins can contribute their own verbs through
  a new `PluginContext.addCommand` seam. Existing verbs keep their behavior.
- **DevTools depth (2.0 Pillar VI).** The glass-box panel (`denext/devtools`) gains the full depth
  set on top of the component inspector: **live prop overrides** (pin a prop, see it re-render),
  **source links** (a `vscode://file` editor link per component) + **owner/ancestor stack**, a
  **Profiler** tab (per-component render counts + total/max timing), and a **per-Suspense-boundary
  server timeline** in the Render-modes tab (`#__denext_boundary_timing`, emitted by the streaming
  renderer). All dev-only and DCE-clean.
- **Dev loop (2.0 Pillar II).** A CSS edit now **hot-swaps the stylesheet with no page reload**
  (a new `css` live-reload message re-fetches the `<link>`); `.tsx/.jsx` edits keep Fast Refresh.
  The dev server **watches `denext.config.{ts,js}` + `deno.json`** and prints a clear "restart to
  apply" note instead of ignoring config edits. **Server-side render errors now surface in the
  in-browser dev overlay** (not just the terminal), with source-accurate SSR stacks.
- **Scaffolding & codegen (2.0 Pillar IV).** `denext generate <page|route|layout|component|api|
  action> <name>` scaffolds artifacts into an existing app — placed per the project layout (App
  Router root or `src/app`), never overwriting, with denext-native templates. `denext create
  --template <default|minimal>` selects a starter from a named template registry.
- **Migrate CRA + generic React (2.0 Pillar III).** `denext migrate` now handles two more source
  families alongside Next and Vite: **Create React App** (detected by `react-scripts`, or
  `public/index.html` + React; reads the entry from `src/index.*`, title from `public/index.html`,
  and env from `process.env.REACT_APP_*`) and **generic React SPAs** (React + a root `index.html`,
  no framework config). All land in `mode: "spa"` with react→denext aliases. A `--from
  next|vite|cra|generic` flag forces detection for ambiguous apps.
- **Typed routes.** `denext build`/`dev` emit `.denext/routes.ts` from the route manifest:
  `Routes` (valid paths; dynamic segments as `` `${string}` ``, optional catch-all → both
  variants), `ApiRoutes`, `RouteParams`, `ParamsOf<R>`. Importing the file registers the
  routes (`RegisteredRoutes`), so `<Link href>` / `router.push` / `router.replace` narrow to
  real paths — backward-compatible (`Href` is `string` until you opt in).
- **`defineConfig`** (`denext/server`) — identity helper giving `denext.config.ts` full editor
  autocomplete and inline type-checking.
- **Durable cache on `node:sqlite`** — the default cache store is now Deno's built-in real
  SQLite (native speed, zero-npm, no unstable flag). Bounded (FIFO row-count eviction + a
  throttled hard-expiry sweep) with stale-while-revalidate; a new `cache` config field
  (`store` / `path` / `maxDataEntries` / `maxPageEntries`) and a smart default resolver
  (in-memory fallback; in-memory on Deno Deploy).
- **In-site API reference** at `/docs/api` — every public symbol of `denext`, `denext/server`,
  and `denext/client` (522), generated from `deno doc` and rendered as static 0-KB-JS HTML.
- **`llms.txt`** at denext.dev — the denext-vs-Next delta plus a curated docs map so coding
  agents emit correct denext.
- **Bundle-size build summary** — every build prints route count, how many ship 0 KB JS, total
  client JS, and the largest chunks.
- **Islands inspector (dev).** `getIslandTimeline()` (`denext/client`) / `window.__denextIslands`
  — which islands hydrated, when, and under which `client:*` strategy.
- **Cache observability.** `getCacheStats()` (`denext/server`) — page (ISR) cache hit/miss/set
  counts plus a recent-invalidations log (`revalidateTag`/`revalidatePath` + timing), for a
  devtools glass-box and production monitoring.
- **Dev glass-box panel.** `DevPanel` (`denext/server`) — an opt-in Server Component you render
  in development (`{dev && <DevPanel />}`) that surfaces the page-cache snapshot (hits/misses/sets
  - recent invalidations) and the live island-hydration timeline (from `window.__denextIslands`).
    Self-contained — inlined styles + a tiny timeline script, no bundle, no dev-server wiring.
- **First-party DevTools — component inspector (`denext/devtools`).** A native, dev-only glass-box
  over denext's own reconciler: an in-page panel (auto-mounted in dev; toggle with Ctrl+Shift+D) showing the
  live **component tree** with each node's **props, hooks/state, and context**, and **live editing** of
  `useState` values (through the hook's own setter, the normal re-render path). Plus a **Render modes**
  tab — the **server-emitted page verdict** (static / dynamic / streamed + page-cache HIT/STALE/MISS,
  via a dev-only `#__denext_render_modes` JSON island) and the client-island hydration waterfall. The
  stock React DevTools extension
  can't show hooks or render modes for denext's non-React fiber, so this is native, not a shim. A typed
  API (`getInspectorTree` / `setHookState` / `subscribe` / `getRenderModes`) backs it for tooling/tests.
  DCE-clean: imported only by dev bundles, so nothing ships in production.
- **`@denext/pages-router` `router.events`** (0.4.0) — `useRouter().events` now exposes
  Next's route-change event emitter (`routeChangeStart`, `routeChangeComplete`,
  `routeChangeError`, `beforeHistoryChange`, `hashChange*`), fired around soft navigation.
  Unblocks NProgress-style loading bars and analytics pageview tracking.
- **`@denext/pages-router` shallow routing** (0.5.0) — `router.push`/`replace` take Next's
  `(url, as?, options?)` signature; `options.shallow` swaps URL/query on the same page without
  re-running data fetching, `as` overrides the address-bar URL, `options.scroll: false` keeps
  the scroll position.
- **`@denext/pages-router` `<Link prefetch>`** (0.6.0) — an opt-in `<Link prefetch>` /
  `router.prefetch()` warms a route's code chunk when it scrolls into view (via
  `IntersectionObserver`), through a server "head" mode that returns only the chunk URL and
  never runs `getServerSideProps`/`getStaticProps` (side-effect-free, like Next).
- **`@denext/pages-router` legacy `getInitialProps`** (0.7.0) — page- and `_app`-level
  `getInitialProps(ctx)` now supplies `pageProps` (ctx: pattern `pathname`, real `asPath`,
  `query`, `params`, `req`). Resolved server-side for both initial render and soft-nav
  data requests.
- **`@denext/pages-router` i18n locale routing** (0.8.0) — `i18n: { locales, defaultLocale }`
  enables `/{locale}`-prefixed routing; the active locale flows into data fetching (`ctx.locale`),
  `__NEXT_DATA__`, and the router (`router.locale`/`locales`/`defaultLocale`), and `<Link locale>`
  prefixes the href. Reuses denext's shared `peelLocale`. **Closes the pages-router compat gap.**
- **Markdown-authored docs.** The docs site can now write pages as `.md` files with
  `title`/`lead`/`slug` frontmatter, rendered through the docs shell by a first-party,
  zero-dependency Markdown renderer (headings with anchor ids, fenced code matching the site's
  `<Code>` component, GitHub-style `> [!NOTE]`/`[!WARNING]` callouts, lists, links, emphasis)
  — no npm markdown stack pulled into the tree.
- **`denext migrate` — Vite React SPA path.** Alongside the Next App Router path, `migrate` now
  auto-detects a Vite SPA (`vite.config.*` + React, no `next.config.*`) and generates a `deno.json`
  (react aliases, `~/` path alias) + a `denext.config.ts` (`mode:"spa"`, `compatibilityMode`, Tailwind,
  and `spa.env` as the union of Vite `define` keys and grepped `import.meta.env.VITE_*` usage, entry/
  title from `index.html`) + tasks — so an existing Vite app boots on denext with one command. Verified
  against a real upstream Vite SPA (build + serve smoke).
- **`denext/desktop` runtime (`runDesktop`).** A thin desktop entry that reuses the SPA production
  server, with a config-driven HTTP/WebSocket reverse proxy (`spa.proxy`, loopback-guarded) so a
  packaged `deno desktop` app can relay `/api` to a separate backend — the SPA analogue of a Vite dev
  server's `server.proxy`. Emitted by `migrate --desktop`, scaffold, and `examples/native`.
- **`denext migrate` wires Pages Router apps to `@denext/pages-router`.** A migrated `pages/` app gets a
  `denext.config.ts` importing the plugin, so a Next Pages Router project runs on the plugin out of the box.
- **CSS-in-JS SSR (`useServerInsertedHTML`).** `next/navigation`'s `useServerInsertedHTML` is
  implemented, so styled-components / emotion register their collected `<style>` tags during SSR
  and denext floats them into `<head>` — including on the streaming / Flight / PPR shells. The
  compat SSR bundle resolves each library's server build (CJS-first export conditions) so a
  CSS-in-JS registry runs once, without the dual-package hazard.
- **Next-compat build depth.** The esbuild compat bundle now resolves **cross-package
  stylesheets**, supports **SSR node builtins** and **`tsconfig` `baseUrl`/`paths` imports**,
  externalizes `@denext/*` runtime modules, and shares the request-context `AsyncLocalStorage`
  across the inlined compat runtime. `@next/mdx` plugins are recovered at build time so MDX apps
  build with commit-parity, and `server-only` / `client-only` are neutralized on the native path.
- **`React.ViewTransition`** — added as a transparent passthrough so apps adopting the
  experimental view-transition API build and render (without the animation).
- **Pages Router compat-mode SSR.** npm-React page modules render through denext's own React
  under `compatibilityMode`, and the plugin is wired through `dev`/`build`/`start`/`export`.

### Changed

- **Version:** `development` is `2.0.0-rc.1` (was inconsistent — `deno.json` `1.4.0`, `mod.ts`
  `1.3.0`); the docs site tracks the released `1.4.0`.
- **First-party Rust→WASM is on-brand** (MISSION.md); the cache uses the runtime's built-in
  `node:sqlite` rather than a bespoke WASM SQLite engine.
- **Server Actions are typed end-to-end** across the client/server boundary (verified) — a call
  is type-checked against the handler's signature wherever it's imported (Next types actions
  only within a module).
- **BREAKING: `nextCompat` → `compatibilityMode`.** The config flag that opts an app into the
  next-compat React-rewrite build was renamed `nextCompat` → `compatibilityMode` (value unchanged:
  `boolean | "auto"`; the old key is no longer accepted), and the scaffold flag `--next-compat` →
  `--compatibility`. Pre-adoption break with no back-compat shim.
- **`denext migrate` writes config only by default.** Source rewriting is now opt-in via `--codemod`
  (was implied), the desktop entry via `--desktop`, and the old `--drop-in` flag was removed — so the
  default migrate is non-destructive to app source.
- **Docs: product/GTM strategy split out to `STRATEGY.md`.** The go-to-market strategy
  (positioning, objections, phased adoption plan, launch, risk) moved out of `ROADMAP.md` into a
  permanent `STRATEGY.md`; `ROADMAP.md` is now purely the pending engineering backlog — a step
  toward the 2.0 goal of shipping with no roadmap files, while keeping the strategy content.

### Fixed

- **Cross-app cache poisoning.** The durable cache lives in each project's `.denext/cache.db`
  (not the launcher's cwd) and is cleared on `build`, so parallel apps/tests never share or
  poison one cache. Server restarts still persist it.
- **PPR shell fields dropped by the durable cache.** The SQLite store now persists a cached PPR
  shell's `holeIds` / `flightShell` / `headExtras` / etc., so a cached PPR page re-splices its
  dynamic holes instead of being served verbatim.
- **CSS-in-JS SSR correctness.** `useServerInsertedHTML` callbacks now flush on the streaming /
  Flight / PPR shells (audit H1), styled-components reads its static boundary + tags correctly, and
  the SSR bundle picks each dependency's Node build with a working `require` (not browser code).
- **`tsconfig` parsing.** `tsconfig.json` is JSONC-parsed, fixing a silent drop of the `@/` path
  alias; a `next/head` shim resolves on the native path.
- **Compat hardening (audit).** `@denext/htmx`'s vendored runtime integrity hash is pinned and
  asserted in tests; `migrate` / pages-router gain a `deno.json` guard, a config-eval timeout, and
  a node-resolve opt-out.

### Removed

- **Deno KV cache backend** (`denoKvCacheStore`) — removed. Deno KV is still a fine app
  database; it is just no longer a denext cache store. **Breaking.**

## [1.4.0] - 2026-08-23

Rendering strategies reach Next.js parity **and** go beyond it. Incremental
streaming is now on by default and — like buffered responses — carries the strict
hash-based CSP; Partial Prerendering works on `"use client"` (Flight) routes; and
the island directive set reaches 6/6 Astro parity with `client:media` and
`client:only`. Route segment config (`dynamic: "error"`, `force-static`,
`dynamicParams`, `fetchCache`) is now honored, and the Live socket recovers shed
frames under back-pressure.

### Added

- **Streaming SSR is on by default** and Flight-capable. A route with pending
  `<Suspense>` boundaries streams its shell + fallbacks first, then each boundary's
  real content as a `<template>` revealed by a single hashed swap-runtime script; a
  hole-less route still buffers (cache-friendly). Works on `"use client"` (Flight)
  routes via a dual HTML+Flight streamer. Opt out with `experimental.streaming: false`.
- **Streamed and PPR responses carry the strict hash-based CSP.** `resolveStreamingCsp`
  derives `script-src` from a single fixed swap-runtime hash (a framework constant, not
  output-derived) plus the buffered head's inline-`<style>` hashes — no whole-body
  buffering required. Streaming is no longer gated by CSP.
- **Partial Prerendering on Flight routes.** A postpone-aware dual HTML+Flight renderer
  serves a cached static shell with per-request dynamic holes on routes with a
  `"use client"` boundary — client islands in the cached shell and inside resumed holes
  both hydrate. Still behind `experimental.cacheComponents`.
- **Route segment config honoring.** `dynamic: "error"` throws on a dynamic-API read;
  `force-static` empties the dynamic APIs and lets the page cache; `dynamicParams: false`
  404s params outside `generateStaticParams`; segment-level `fetchCache` sets the baseline.
  `runtime`/`preferredRegion`/`maxDuration` remain informational (one Deno runtime).
- **Two new island directives → 6/6 Astro parity.** `client:media="(min-width:800px)"`
  hydrates when a CSS media query matches (`matchMedia`); `client:only` skips SSR and
  renders on the client only (empty wrapper server-side, `createRoot` on mount).
- **Module-level `export const hydrate` default.** An island's own module can set a
  default strategy; a usage-site `client:*` overrides it (precedence: usage-site >
  module default > eager).
- **Docs.** New "Rendering strategies" and "Islands & hydration" pages on the docs
  site, and a new `examples/islands` app exercising all six directives.

### Fixed

- **Live back-pressure recovery.** When a client's send buffer is saturated (>1 MiB
  buffered), the hub sheds frames rather than buffering unboundedly — but a shed
  _stateful_ frame previously left that client stale indefinitely. Shed frames are now
  recovered once the socket drains: a dropped `<Live>` patch replays as a single
  `refresh` (catching every boundary up), and a dropped `useLive` `data` frame re-runs
  its fetcher to push the latest value. Presence frames are self-superseding and still
  shed freely. The drain is polled (Deno's `WebSocket` has no drain event) and the
  recovery intent is dropped if the socket closes first (a reconnect refreshes anyway).
- **`client:visible` on a `display:contents` wrapper.** The island wrapper is
  `display:contents` (no layout box), so an `IntersectionObserver` on it never
  intersected and the island never hydrated on scroll. The `visible` scheduler now
  observes the wrapper's first real child (the island's rendered root).
- **Nested `client:*` islands.** A `client:*` island rendered inside another island's
  subtree previously carved a stray wrapper (breaking the parent's hydration structure;
  the streamer even double-carved it). It now renders eagerly with its parent (inline,
  no wrapper, marker stripped) so the parent's server HTML and client render match.
- **A failing Suspense/PPR hole no longer truncates the document.** Each streamed hole
  is drained under its own try/catch — a rejected boundary keeps its fallback (and logs)
  instead of erroring the whole stream.
- **Client bundle no longer pulls in `node:async_hooks`.** A pure `fillFlightHoles` was
  extracted to a dependency-free leaf module so the prerender scope's top-level
  `AsyncLocalStorage` can never reach the browser bundle (which had silently broken
  hydration on every isomorphic route).
- **Streamed Server Action `<form>`** now emits `method="post"` in the Flight/stream
  renderers (matching the buffered path), so a JS-less form submit hits the action.

## [1.3.0] - 2026-08-23

macOS desktop packaging becomes first-class, and a production-readiness / security /
documentation audit of everything since 1.0.2 lands its fixes: a Live-socket
authorization tightening, single-flight for `useLive` data, and a batch of
build-pipeline and resource-cleanup hardening.

### Added

- **macOS desktop packaging.** Scaffolding the desktop target now emits
  `scripts/package-macos.ts` and points `deno task desktop:package` at it. It builds
  `--arch host|arm64|x86_64|both|universal` (cross-compiling and `lipo`-merging for a
  universal bundle), ad-hoc signs by default, and — when `DENEXT_CODESIGN_IDENTITY`
  is a Developer ID identity — signs inside-out with the Hardened Runtime + a secure
  timestamp; with `DENEXT_NOTARY_PROFILE` also set it notarizes and staples. Optional
  `--dmg`. New "Desktop apps (macOS)" docs page. (The old bare `desktop:package` task
  also omitted `--include out`, so packaged binaries shipped without their static
  assets — fixed here.)
- **`react-dom/client` namespace default export.** `import ReactDOM from
  "react-dom/client"; ReactDOM.createRoot(…)` (esModuleInterop / CJS-interop code)
  now bundles, matching the default exports already on the `react`/`react-dom` shims.

### Fixed

- **Scaffolded `deno desktop` entry quits on window close.** The generated
  `desktop.ts` was `Deno.serve(...)`-only; since that task is permanently live,
  closing the window (red button / ⌘W) did nothing. The entry now adopts the window
  via `Deno.BrowserWindow` and `Deno.exit(0)`s on its `close` event.
- **Tailwind input aliased to the compiled output.** An app that imports the Tailwind
  input file it authored (`import "./index.css"`) previously produced an unstyled
  build; the input is now aliased to the compiled output so importing either yields
  the same linked stylesheet.
- **`useLive` data recomputes are single-flighted** (per subscription), so a burst of
  tag invalidations can no longer race the async fetcher and push out-of-order `data`
  frames — the last frame always reflects the latest state (mirrors the `<Live>`
  boundary's existing `busy`/`dirty` guard).
- **SPA build/dev pipeline hardening:** `denext build` no longer leaves a half-written
  staging dir behind on a failed build; `export` surfaces a real `public/` copy error
  instead of silently shipping missing assets; the dev watcher ignores events under
  the output dir / `node_modules` / `.git` (stops a self-triggered rebuild loop when
  the entry sits at the project root); the esbuild service is kept warm across dev
  rebuilds and torn down once on shutdown; and a dev-server races that could deref a
  pruned build dir is closed.
- **Auth robustness:** `denextAuth` fails fast at config time when an OAuth provider's
  `clientId`/`clientSecret` is empty (a missing env var previously POSTed the literal
  `"undefined"` and failed every login opaquely), and a misconfigured provider now
  degrades the sign-in _initiation_ to the sign-in page with `?error=config` instead
  of a raw 500 (matching the callback path).
- **Resource cleanup:** the Live hub clears its coalesce timer + pending tags on
  teardown (no dangling timer on the test path); a wake-lock claim is rolled back if
  its sentinel fails to acquire (no phantom "screen held"); and macOS packaging always
  removes its per-arch temp bundles and the notarization zip, even on error paths
  (plus a `plutil` exit-code check so the main executable can't be signed twice).

### Security

- **`experimental.live.allowAnonymous` no longer opens arbitrary data over the Live
  socket.** It gates presence-room joins; `useLive` data subscriptions still require
  the per-action `liveReadable(...)` opt-in (or a `canSubscribe` hook). Previously,
  enabling anonymous presence also admitted a `data-subscribe` to _any_ registered
  action — including mutations, which a data subscription re-runs on every tag
  invalidation — defeating the `liveReadable` guard. Unmarked actions are now a
  `no-policy` refusal even under `allowAnonymous`.
- **`spa.head` gets the dev-only raw-HTML injection warning** that `metadata.head`
  already emits, flagging it as an untrusted-input sink.

## [1.2.0] - 2026-08-23

Run your existing React SPA on denext: a first-class `mode: "spa"`, the next-compat
pipeline that resolves an npm library's `import "react"` to denext's single React,
and a set of React-fidelity reconciler fixes that make heavy component libraries
(Base UI, Radix, floating-ui, `@effect/atom`) render correctly.

### Added

- **SPA mode (`mode: "spa"`) — host a client-only React app ("React but not
  Next").** Set `mode: "spa"` with a `spa.entry` in `denext.config.ts` and denext
  bundles that single client entry, wraps it in an HTML shell, and serves the shell
  for every navigation (history-API fallback) — no `app/` directory, no SSR/Flight.
  `dev` (live reload), `build`, `export`, and `start` all support it; `export`
  emits a static `out/` that `deno desktop` packages unchanged. Bring your own
  router (TanStack, etc.) and data layer — denext only bundles and mounts. The CSS
  pipeline/Tailwind and the next-compat react→denext aliases apply, so an existing
  Vite-style React SPA runs on denext's small, zero-npm runtime. New
  `examples/spa` (with a `bench.ts` bundle-size comparison vs React+ReactDOM) and a
  docs page. `SpaConfig` is exported from `denext/server`.
- **SPA mode runs npm-React apps on denext's single React (next-compat path).**
  When the app uses npm React (`node_modules/react`, or `nextCompat: true`), SPA
  mode bundles through the next-compat esbuild rewrite so an npm library's own
  `import "react"` also resolves to denext's React — the "two Reacts" fix a plain
  `deno bundle` cannot do. This is what lets an existing Vite-style React SPA (Radix,
  TanStack Router, etc.) run on denext's runtime. A denext-native SPA keeps the fast
  plain-`deno bundle` path.
- **`import.meta.env` for SPA mode** (the Vite `define` analogue): the built-ins
  `MODE`/`DEV`/`PROD`/`SSR`/`BASE_URL` are injected with correct types (`DEV`/`PROD`
  are real booleans — `dev` on `denext dev`, production on `build`), and `spa.env`
  `{ KEY: "value" }` adds/overrides string values. Substituted at build time on the
  next-compat path.
- **Vite-style asset imports on the SPA compat path**: `?url` (emit a file, import
  its URL), `?worker` (bundle the module + `new Worker(url)`), `?raw` (text),
  `?inline` (data URL), bare `.wasm`/`.woff2`/image imports, and `new URL(…,
  import.meta.url)` — all emitted under `/_denext/client/assets/` and served by the
  SPA server / copied by `export`. New esbuild `assets` option on
  `bundleNextCompatModules` (`publicPath`/`assetNames`/`loaders`).
- **pnpm `catalog:` / `workspace:*` support on the SPA compat path.** The esbuild
  deno-loader's resolver can't parse those version protocols (the real version lives
  in `pnpm-workspace.yaml`), so denext now front-runs it: packages whose
  `package.json` version is `catalog:`/`workspace:*` (and their whole transitive
  subtree) are resolved straight from `node_modules` via a Node-style importer-relative
  walk that realpaths through pnpm's symlinks — honoring each package's `exports`
  map. Auto-detected from `package.json`; only active for such apps. This is what lets
  a real pnpm-workspace Vite app (e.g. an Effect + TanStack monorepo) build on denext.
- **Opt-in Content-Security-Policy for SPA mode (`spa.csp`).** A client-only React
  SPA (Vite/CRA and denext alike) ships no CSP by default, so this is opt-in:
  `spa.csp: "strict"` emits denext's strict policy (`default-src 'self'`,
  `script-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `style-src-attr
  'unsafe-inline'` so React `style={{}}` keeps working) as a `<meta http-equiv>` in
  the generated shell — so it applies for `export` (any static host), `start`, and
  `dev`. Pass a `{ connectSrc: [...] }`-style object to add global opt-ins (your API
  host, etc.). `frame-ancestors` is header-only (ignored in `<meta>`); the always-on
  `X-Frame-Options: SAMEORIGIN` covers clickjacking.

### Changed

- **Bundled Tailwind standalone bumped `v4.1.11` → `v4.3.0`.** 4.1.11 predates the
  logical inset shorthands `inset-s-*` / `inset-e-*` (`inset-inline-start/end`), so a
  class like `inset-e-2.5` compiled to nothing and an element relying on it fell back
  to its static position — e.g. an `absolute inset-e-2.5` "Add" button landing on top
  of a left-aligned control instead of pinned to the right. Real Tailwind 4.3.0 (what
  Vite-built apps use) emits these utilities; matching it keeps denext a faithful
  drop-in. Override still available via `DENEXT_TAILWIND_VERSION`.

### Fixed

- **Inline styles are patched per-property instead of by rewriting the whole `style`
  attribute — foreign inline properties now survive re-renders.** denext replaced the
  entire `style` attribute on every commit, which erased CSS custom properties set
  imperatively on the element from outside the render. floating-ui (used by Base UI /
  Radix popovers, menus, tooltips) writes `--available-width` / `--available-height` /
  `--anchor-width` / `--transform-origin` directly onto the positioned element and
  relies — as with react-dom — on the renderer never clobbering them. Wiping them each
  commit changed the popup's size (`max-height: var(--available-height)`), which fired
  floating-ui's `ResizeObserver`, which repositioned and re-rendered — an infinite
  reposition loop that made a dropdown/menu flicker and dismiss itself. denext now
  diffs the style object against the previous one and touches only the keys it manages
  (`element.style.setProperty` / `removeProperty`), leaving foreign inline properties
  intact — matching react-dom, so positioning settles.
- **An unkeyed top-level Fragment returned by a component is now transparent
  (React's `isUnkeyedTopLevelFragment`), so a keyed child inside it survives a change
  in the surrounding structure.** denext kept the returned fragment as its own fiber,
  so when a component conditionally wrapped a keyed element in extra siblings the new
  unkeyed fragment could not match the previous keyed one and the whole subtree — the
  keyed element's DOM node — was remounted. This broke every Base UI floating
  component (menu, select, popover, tooltip): `MenuTrigger` wraps its `<button>` in
  `<Fragment key={triggerId}>` and, when open, returns that keyed wrapper alongside
  focus guards inside an outer unkeyed fragment (its comment: "a fragment with key is
  required to ensure the element is mounted to the same DOM node regardless of whether
  the focus guards are rendered") — so opening a menu remounted the trigger, detaching
  the node floating-ui uses as its positioning anchor; the popup then measured a zero
  rect and stayed at `opacity: 0`, unpositioned (open in state, but invisible). denext
  now reconciles a plain unkeyed fragment's children directly, matching react-dom.
  Marker-carrying fragments (context Providers, StrictMode, SuspenseList, Profiler)
  keep their own fiber, so their behavior is unaffected.
- **SVG (and MathML) elements are now created in their own namespace, so icons
  render.** The client reconciler created every element with `createElement` (HTML
  namespace), so an `<svg>` and its `<path>`/`<circle>`/… children occupied layout
  space but drew nothing — the classic "an icon shifts the text but is invisible"
  (all lucide-react / Radix / Base UI icons in a client-rendered app). Elements in an
  `<svg>`/`<math>` subtree are now created with `createElementNS` (a `<foreignObject>`
  switches its children back to HTML), and React's camelCase SVG presentation
  attributes (`strokeWidth` → `stroke-width`, `strokeLinecap` → `stroke-linecap`, …)
  are converted to the hyphenated names SVG expects (structural attributes like
  `viewBox` are kept as-is), so icons render at the correct weight.
- **A deferred passive effect (`useEffect`) scheduled during a multi-render commit
  cycle could be stranded and never run.** `renderRoot` flushes to completion in a
  render+commit loop; it flushed pending passive effects only once before the loop, so
  an effect scheduled and committed in one iteration could have its fiber's
  `passiveEffects` cleared by a later iteration's `createWorkInProgress` (buffer reuse)
  before the deferred flush ran it. Passive effects are now flushed before **each**
  iteration, matching React (which flushes them before any new unit of work). This
  manifested as a Base UI dialog that opened correctly but **never unmounted on close**
  (its root's unmount-watcher `useEffect` was the stranded effect), so it stayed
  invisibly mounted and could not be reopened.
- **React-fidelity reconciler fixes — real, unmodified npm-React libraries now
  render on denext's own React.** These land together and are what let heavy
  component libraries (Base UI, Radix, floating-ui, `@effect/atom`, React-Compiler
  output) work:
  - **`useState`/`useReducer` return a referentially stable setter/dispatch** across
    renders (React's guarantee). A fresh closure each render re-fired effects that
    depend on the setter and, when such an effect writes back through it (Base UI's
    label/id registration), looped until the update-depth guard tripped.
  - **Render-phase state updates converge locally** (the "adjust state while
    rendering" idiom — Base UI's transition status, `usePrevious`-style prop
    adjustments): denext now re-invokes just that component to convergence, as React
    does, instead of scheduling a whole-tree commit that never settles.
  - **Unkeyed children are matched by type bucket, not a consuming cursor**, so
    inserting a node at the front of an unkeyed list no longer remounts the siblings
    after it (lost DOM state, re-run effects).
  - **Legacy class `contextType` consumers no longer go stale** under the new
    context-aware bailout: a class reads context via `this.context` (not the
    `useContext` dispatcher), so it was invisible to the consumer-only re-render pass
    and missed a provider value change when a memoized non-consumer ancestor bailed
    the subtree. Class reads are now recorded like `useContext` reads.
- **Reflected XSS in the `next-compat` page emitter** (`renderNextCompatPage`, a
  `./build/next-compat` public export): URL-derived props were embedded in an inline
  `<script>` with an unescaped `JSON.stringify`, so a `</script>` in a param value
  could break out. Now escaped (`<`), matching the document shell.

- **`useSyncExternalStore`: a subscription scheduled by a render that was superseded
  before its (deferred) passive-effect commit could be lost, so the store never
  notified that consumer.** The subscribe effect is keyed on `cell.deps`; denext marked
  that key satisfied during render, but the hook cell is shared across a fiber's two
  buffers, so if the mount render was superseded by a re-render before its passive
  effect ran (a component that re-renders as its subtree mounts, under StrictMode /
  an interrupted transition), the committed re-render saw `depsChanged === false` and
  never re-queued the subscribe. The consumer then silently stopped re-rendering on
  store changes. Concretely: a Base UI dialog opened at its enter start-frame
  (`data-starting-style`, `opacity: 0`) and never advanced, because its popup/viewport
  (which re-render as their contents mount) never subscribed to the transition-status
  store while a leaf sibling backdrop did. Fixed by marking `cell.deps` only when the
  subscription actually commits, and by scheduling store updates against the live
  fiber buffer (`cell.owner`) rather than the render-time fiber.
- **Client events now expose `event.nativeEvent`** (a self-reference to the DOM
  event, as React's `SyntheticEvent.nativeEvent` is). Libraries that read it or gate
  on `"nativeEvent" in event` (Base UI / floating-ui-react: `getTarget(event.nativeEvent)`,
  `"composedPath" in event.nativeEvent`) previously got `undefined` and threw on hover.
- **`useSyncExternalStore`: a throwing `getSnapshot` in the subscribe callback tore
  down the tree.** When a store's `getSnapshot` throws (e.g. `@effect/atom-react`'s
  `useAtomValue`, which asserts on a value transiently absent mid-notify), denext let
  the throw escape the store's notify callback — where no error boundary can catch it —
  and the root was removed (blank screen). Now, exactly as React's `checkIfSnapshotChanged`
  does, a throwing snapshot check is treated as "changed" and forces a re-render, so the
  throw (if it recurs) surfaces during render where an error boundary catches it — and
  usually the store has settled by the scheduled microtask, so it doesn't recur.
- **Portal commit evicted foreign siblings from a shared container.** Committing a portal
  into a container the reconciler doesn't exclusively own (`document.body`, which also
  holds `#root`, the entry `<script>`, and other portals) count-pruned the container to
  the portal's children — removing those foreign nodes (a body-level Base UI toast/tooltip
  would blank the app by evicting `#root`). Portals now place only their own nodes (new
  `placePortalChildren`); sibling nodes the reconciler didn't insert are never pruned, as
  in React.
- **CSS was not extracted for apps whose `deno.json` anchors resolution**
  (`nodeModulesDir` / `npm:` imports — e.g. a converted Next/Vite app). `buildAppCss`
  mirrors the css→shim redirect into the app config so the module loader resolves
  `.css`, but the CSS graph crawl (`discoverCssFiles` via `deno info`) then
  auto-discovered that same config and resolved every `.css` to its empty shim →
  found zero stylesheets → emitted none. The crawl now temporarily strips the
  css→shim redirects from the app's own `deno.json` (restoring it afterward; every
  build re-mirrors them), so `deno info` reports the real `.css`.
- **Import-map prefix mappings lost their trailing slash** when absolutized to
  file URLs (`"~/": "./src/"` → `…/src` instead of `…/src/`), breaking subpath
  resolution and, in a merged module config, tripping Deno's "package address must
  end with /" error. Fixed in the bundle, CSS, and module-config absolutizers.
- **`loadDenextConfig` silently dropped `nextCompat` and `classComponents`**, so
  the explicit `nextCompat: true` override never reached `detectNextCompat` (both
  the App Router and SPA mode relied on `node_modules/react` detection instead).
  All `denext.config` fields now carry through.

### Changed

- **Isomorphic soft navigation now transfers a compact JSON payload instead of
  the full HTML document.** A soft nav (`x-denext-nav`) to an interactive route
  that has no Flight boundary previously answered with the entire server-rendered
  HTML document — whose `<body>` the client immediately discarded, since the
  re-run route bundle rebuilds the DOM from its own tree. The server now answers
  such a nav with `{title, data, entry, styles}` (header `x-denext-iso: 1`, the
  isomorphic analogue of the Flight-nav JSON path), and the client applies the
  title, the `#__denext_data` island, and — newly — swaps the **per-route
  stylesheets** before re-injecting the entry. This trims each isomorphic soft
  nav to the bytes it actually uses and fixes a latent bug where per-route CSS was
  never swapped on navigation. Hard requests still return the full HTML document.

### Performance

- **Context-aware memo bailout — a provider value change re-renders only the
  components that actually read that context**, letting a memoized non-consumer
  ancestor between the provider and a consumer bail its subtree (mirrors React's
  `propagateContextChange`). Previously any context value change forced the whole
  subtree below the provider to re-render. A stable-value provider still costs
  nothing.

## [1.1.0] - 2026-08-21

### Added

- **Resumability — `export const resumable = true`** (resumability, the
  automatic mode). Opt a route into resumable rendering and it is interactive
  with **no up-front hydration** — and **plain components work unchanged**
  (`useState` + `onClick`, no `qrl`, no `client:*` directive needed). Each
  island's wake-up moment is chosen automatically from what it does: a
  handler-only island waits for the first interaction (then the triggering event
  is replayed to the just-resumed handler), and an island that runs an effect (a
  clock, a subscription) hydrates on idle so it runs without a click — no
  annotation required. The first interaction resumes only the touched island;
  `useSignal` state is adopted rather than recomputed. Under the hood the server
  carves each island into a foreign `<dnx-island>` the page root never executes,
  stamps handler hosts with `data-dnx-h`, and a single delegated listener
  resumes-and-replays (or, for a `qrl`, dispatches without mounting at all). Off
  by default — a route keeps React-style hydration until it opts in — and the
  whole runtime tree-shakes out of apps that don't use it.
- **`useSignal` / `useStore` — reactive, serializable state** (resumability,
  stage 3; from `@denext/denext`). Opt-in reactive state that transports from
  server to client: `const n = useSignal(0)` returns a stable box (`n.value` /
  `n.peek()`), `useStore(obj)` a shallow reactive object; a write re-renders the
  owning component. Their values are serialized into a `#__denext_state` island
  keyed by position and **adopted** on the client instead of recomputing the
  initializer — the groundwork for resuming state without re-running components.
  Orthogonal to the React-parity hooks: code that doesn't opt in keeps
  `useState` unchanged, and the signal runtime tree-shakes out of apps that
  never use it.
- **`qrl()` — lazily-loaded, code-split, resumable event handlers**
  (resumability, stages 2 & 4; from `@denext/denext/client`). Wrap a handler's
  dynamic import —
  `qrl(() => import("./handlers.ts").then((m) => m.onClick), "id")` — and use it
  as any event-handler prop; the handler's code is fetched only on first
  activation, not shipped in the island bundle. Each `qrl` carries a stable id,
  so a handler **survives serialization** (a new Flight `{$:"e"}` reference) and
  the server stamps it as a `data-dnx-h` descriptor. A single delegated listener
  then **dispatches the handler without ever running its component** — so,
  paired with `client:interaction` and adopted signals, a component is
  interactive with **zero up-front tree execution**. (The _automatic_ transform
  that turns every plain `onClick` into a `qrl` is future work; the authoring
  API ships now.)
- **Island-level lazy hydration — `client:*` directives** (resumability, stage
  1). Opt any client island into deferred hydration with a namespaced JSX
  attribute — `<Counter client:load|idle|visible|interaction />` — and the page
  ships that island's server HTML immediately but defers its hydration
  (component execution + listener attach) until the strategy fires: on idle, on
  scroll into view, or on first interaction. The server carves each lazy island
  into a layout-neutral `<dnx-island>` wrapper the page root adopts but does not
  own (a _foreign_ subtree), and the client hydrates it in place via a
  per-island `hydrateRoot` when its strategy fires — `interaction` uses a single
  delegated capture-phase listener so the triggering event is not lost. Default
  behavior is unchanged (no directive → hydrate at load), and the
  deferred-hydration runtime is a separate `@denext/denext/lazy` chunk,
  dynamically imported only when a page has lazy islands, so non-lazy apps
  bundle none of it. (A per-component `export const hydrate` default is planned;
  the usage-site prop ships now.)
- **Live Server Components — `<Live>`** (new `@denext/denext/live` entrypoint).
  Wrap a server-rendered subtree that reads tagged cache data in
  `<Live tags={["orders"]}>…`; when any of those tags is invalidated
  (`revalidateTag`/`updateTag`, from anywhere — a Server Action, a webhook, a
  cron), the server re-renders **just that boundary, under the viewer's own
  session**, and pushes it over a WebSocket. The client reconciles the subtree
  in place: every other component's state is preserved and no navigation occurs.
  Next.js has no equivalent. It degrades safely — a boundary that can't be
  located (route changed, auth expired) falls back to a route refresh, and with
  no client runtime `<Live>` just renders its children (SSR-safe). The transport
  is opt-in: the socket only opens once a `<Live>` boundary mounts, and an app
  that never imports `<Live>` bundles none of it. Requires a Flight (RSC) route.
- **Live data — `useLive` / `usePresence` / `useLiveOptimistic`** (from
  `@denext/denext/live`), the real-time data family on the same WebSocket hub.
  `useLive(action, args, { tags })` subscribes to a server function's result and
  re-renders whenever one of its cache tags is invalidated — the server re-runs
  the function **under the viewer's own session** and pushes the value
  (real-time data, zero client library). `usePresence(room)` gives who's-online
  / cursors (`{ self, others, peers, setState }`) over the same socket,
  orthogonal to tags. `useLiveOptimistic` pairs an optimistic overlay with a
  live value so a local update reconciles when the authoritative value arrives.
  A Convex / Liveblocks / PartyKit-class real-time layer with **zero npm and
  zero extra infra**; the socket is shared with `<Live>` and opens only when a
  live feature mounts.
- **First-party auth — `denextAuth`** (from `@denext/denext/server`). A
  zero-npm, secure-by-default authentication layer on denext's signed-cookie
  sessions: **OAuth 2.0 / OIDC** (Authorization Code + **PKCE**) with
  **Google**, **GitHub**, and generic **OIDC** presets, plus a **Credentials**
  (email/password) provider. Added as a plugin (`plugins: [denextAuth({ … })]`)
  it **auto-mounts** `/auth/*` (signin/callback/session/providers/signout) — no
  route files to write. OIDC `id_token`s are verified (RS256 via JWKS +
  `iss`/`aud`/`exp`/`nonce`); the session stores only a non-sensitive
  `{ user, provider, expiresAt }` in a signed `__Host-` cookie (never tokens).
  Provider calls go through the SSRF-safe `safeFetch`, the `redirect_uri` is
  pinned to a required `canonicalOrigin` (host-header-injection proof), and
  state-changing POSTs are same-origin gated. Read the session anywhere with
  `auth()`, gate routes with `requireAuth()` middleware, and on the client use
  `<SessionProvider>` / `useSession()` / `signIn()` / `signOut()` (from
  `@denext/denext`).

- **`withWebLock(name, fn, options?)`** (exported from `denext`) — cross-tab /
  cross-worker single-flight built on the standard Web Locks API. Only one
  holder of an exclusive lock runs at a time across every tab of an origin, and
  the lock auto-releases when `fn` settles (or the tab dies), so it can't
  deadlock. It degrades gracefully: on the server (SSR) or in a browser without
  Web Locks, `fn` just runs uncoordinated. Supports `mode: "shared"`,
  `ifAvailable`, and an abort `signal`. The canonical use is coordinating an
  auth-token refresh so concurrent tabs don't stampede a one-time-use refresh
  cookie.
- **`useWakeLock(options?)`** (hook, exported from `denext`) — a React-style
  hook over the Screen Wake Lock API (`navigator.wakeLock`) that keeps the
  display awake. The screen is a device-global resource, so it's a **refcounted
  singleton**: each instance owns its own claim (`request` / `release` / its own
  `released`) and composes safely, but a single real lock is acquired once and
  released when the last claim drops. Instances also share the global reads
  `count` / `active` (via `useSyncExternalStore`) and a `releaseAll()`
  kill-switch. Base surface mirrors the community `react-screen-wake-lock` hook
  (Next.js ships no equivalent); it re-acquires when the tab returns to visible
  and releases on unmount. Client-only; a no-op during SSR / where unsupported.
- **`usePictureInPicture(options?)`** (hook, exported from `denext`) — a
  React-style hook over the Picture-in-Picture API for `<video>`. Attach the
  returned `ref` and drive it with `enter`/`exit`/`toggle`; returns
  `{ isSupported, isActive, isPiPOpen, pipWindow, ... }` with
  `onEnter`/`onExit`/ `onResize`/`onError` callbacks. PiP is a browser
  singleton, so `isActive` is per-video while `isPiPOpen` is a shared global
  read. Next.js ships no equivalent. Client-only; a no-op during SSR / where
  unsupported.

### Security

- **Live Server Components — authorization model + resource caps.** Following a
  pre-release audit of the (unreleased) Live feature, the WebSocket hub gains a
  first-class security model via `experimental.live` in `denext.config`:
  - **Presence rooms and `useLive` data subscriptions are now default-deny**,
    identically in dev and production. Previously any same-origin client could
    join any presence `room` (reading every peer's state and publishing forged
    state) and could `data-subscribe` to any registered server action with
    arbitrary args. Supply a policy — `authorize(ctx)`,
    `canJoinRoom(ctx, room)`, `canSubscribe(ctx, sub)` — to admit them; hooks
    run inside the viewer's own request context so they can call `getSession()`.
    Actions can instead be opted in individually with `liveReadable(action)`.
    Using a gated hook with no policy raises a loud, actionable error the first
    time it runs (there is no dev-only allowance that would work locally and
    silently break in production); `experimental.live.allowAnonymous: true` is
    the one explicit line that opts into open access for genuinely public
    collaboration.
  - **Resource caps** (all with safe defaults, overridable via
    `experimental.live.limits`): max connections, subscriptions-per-connection,
    rooms-per-connection, watched boundaries, and an inbound message-size limit
    — closing an unbounded-registry / amplification DoS where one client could
    exhaust server memory/CPU. The upgrade now also sets an explicit socket idle
    timeout. A refused subscription or a hit cap sends an advisory `error`
    frame.

- **Auth — post-login open redirect closed.** `denextAuth` passed the
  request-supplied `callbackUrl` straight to `safeRedirectLocation`, which by
  design returns a fully-qualified `http(s)://…` URL unchanged — so
  `?callbackUrl=https://evil/…` sent a user to an attacker site after a genuine
  login. Request-derived redirect targets are now coerced to a same-origin path
  (an absolute URL is admitted only when its origin equals `canonicalOrigin`,
  and then only its path is kept). Applied at sign-in, callback, and sign-out.
- **Auth — hardened the OAuth transaction cookie.** `denext_auth_tx` (CSRF
  `state`, PKCE verifier, OIDC nonce, return path) was an unsigned, plain cookie
  with no `__Host-` prefix — overwritable via cookie injection (a login-CSRF
  vector). It is now a signed, `__Host-`-prefixed, short-lived session cookie
  (same infrastructure as the auth session).
- **Auth — OIDC `id_token` validation.** A token that omitted `exp` was accepted
  as non-expiring; `nbf` was not checked. `exp` is now required (a missing `exp`
  is rejected) and a not-yet-valid (`nbf`) token is refused, within clock skew.
- **Auth — `canonicalOrigin` required in production.** Without it the OAuth
  `redirect_uri` and same-origin checks fall back to the attacker-controllable
  `Host` header; `denextAuth` now throws when it is unset and
  `NODE_ENV`/`DENEXT_ENV` is `production` (still a warning in dev).

### Fixed

- **`useWakeLock` could leak an OS wake lock under a concurrent acquire.** Two
  claims added in the same tick both saw no sentinel and each called
  `navigator.wakeLock.request`, so the second overwrote the first and the first
  real lock was never released (the screen stayed awake). Acquisition now
  coalesces through a single in-flight promise, and release awaits it — exactly
  one sentinel.
- **`withWebLock` fallback surfaced errors on the wrong channel.** On the SSR /
  no-Web-Locks path a synchronous throw in the callback escaped synchronously
  (instead of rejecting the returned promise like the real path), and an
  already-aborted `signal` was ignored. The fallback now rejects on both.
- **`usePictureInPicture` leaked a resize listener on unmount-in-PiP.** If the
  component unmounted while still in Picture-in-Picture, `leavepictureinpicture`
  never fired, so the `resize` listener added on the PiP window was never
  removed. The effect cleanup now removes it.

- **Resumability was not re-wired after a Flight soft navigation.**
  `bootResumability` ran only from the full-load entry, so a client-side
  navigation into a route with `client:*`/resumable islands left them inert
  (rendered empty, non-interactive) and event types unique to the new route got
  no delegated listener. The Flight soft-nav payload now carries the route's
  islands + signal state, and `navigation.ts` calls a registered re-boot hook
  that mounts each island from its own Flight and adopts its state. The
  delegated dispatcher now tracks already-registered event types on a global so
  a re-boot adds listeners for newly-appearing ones without double-binding. Also
  hardened along the way: signal-state adoption now drops prototype-polluting
  keys (`__proto__`/`constructor`/`prototype`) — the same filter `parseFlight`
  uses; `qrl()` rejects an id containing whitespace or `:` (the `data-dnx-h`
  delimiters); and island wrapper attributes are HTML-escaped on emission.

- **Interactivity classifier could ship a broken (zero-JS) interactive page.**
  The static-route scan blanks string/comment content before looking for
  interactivity signals, but did not recognize **regex literals** — so a regex
  containing a quote (e.g. a validation `/['"]/g`) opened a spurious "string"
  that blanked real code after it. A client component whose only signal was a
  JSX `onInput=`/`onClick=` sitting after such a regex could be misclassified
  static and shipped with **no JavaScript**, leaving the handler dead. The
  scanner now lexes regex literals (disambiguating regex from division by the
  preceding token, and deliberately never treating JSX `</div>`, `/>`, or
  `{a}/{b}` as a regex) and blanks only the regex interior. A regression
  introduced when the scan moved off raw source; caught before release.

- **Soft navigation re-hydrated against the previous page in dev.** The retained
  reconciler root was held in a module-level variable, which assumed the route
  bundle shared a single runtime chunk. A dev build serves each route bundle
  self-contained, so a soft nav's re-run entry got a fresh module with
  `retainedRoot === null` and fell into the `hydrateRoot` branch — adopting the
  outgoing page's DOM as the incoming tree. The visible result was a flood of
  hydration-mismatch warnings and stale UI (e.g. the docs sidebar keeping the
  previous page's active indicator). The root is now stored on a global so it
  survives across route-bundle module instances; soft nav reconciles in place
  via `root.render` in dev and production alike. Dev-only; production
  code-splitting already shared the runtime chunk.

- **Read-your-writes after a Server Action.** A Server Action that calls
  `revalidateTag`/`updateTag` or `refresh()` already returned those directives
  in its XHR response, but the client discarded them — so the mutated content
  only updated on the next navigation. The client runtime now honours them and
  re-renders the current route in place (preserving component state), matching
  Next.js refresh semantics.

## [1.0.2] - 2026-08-19

Documentation-only patch. Adds an `@module` tag to the bare-`next` barrel
(`src/compat/next/index.ts`) so `deno doc`/JSR attribute its leading comment to
the module — the last entrypoint that wasn't credited a module doc. Flips JSR's
"has module docs in all entrypoints" criterion to passing. No behavior change.

## [1.0.1] - 2026-08-19

Documentation-only patch to complete the public-API doc graph (raises the JSR
score). No runtime or behavior change.

- Export the types the public API exposed only transitively, so JSR/`deno doc`
  see a complete graph: `FontResult` (from `next/font/local` +
  `next/font/google`),
  `RequestCookies`/`ResponseCookies`/`RequestCookie`/`CookieOptions` (from
  `next/server`), the class-component base types (from `react`), and the
  `MetadataRoute.*` members (from `next`).
- `deno doc --lint` is now clean across the full `exports` set (previously only
  a curated subset was linted).

## [1.0.0] - 2026-08-19

The 1.0.0 release, declaring the public API stable. Post-0.12.0 hardening,
verification, and demonstration work, with one small breaking change to the
`instrumentation.ts` `onRequestError` signature (below) for Next.js parity.

### Breaking

- **`onRequestError(error, request, context)` now receives Next's plain
  `{ path, method, headers }` object as `request`, not a `Request`.** This
  matches Next.js so instrumentation (Sentry/OpenTelemetry) written for Next
  works unchanged. If your handler used `request.url` / `request.clone()`, read
  `request.path` / `request.method` instead. `context` also gains `renderType`
  and a `renderSource` for RSC/Flight render errors, and middleware errors are
  now reported with `routeType: "proxy"`.

### Security

- **CVE-2026-64641 (CWE-834) — Server-Action unbounded iteration:** the
  multipart argument decoder trusted an attacker-controlled `fdIndex`, so
  `args[fdIndex] = fd` could inflate the argument array to an arbitrary length
  that the handler then spreads (`handler(...args)`) — a CPU/memory DoS.
  `fdIndex` is now validated as an in-range integer of `others`; anything else
  falls back to a single-FormData arg.
- **CVE-2026-64644 — image-optimizer DoS/XSS via SVG source:** an SVG source is
  now refused outright (`400`, sniffed from the leading bytes before decode)
  instead of failing into an incidental `500`. The optimizer emits only raster
  webp/avif and never rasterizes or echoes a script-bearing SVG. Matches Next's
  default; only the `/_denext/image` optimizer path is affected — static/inline
  SVG is untouched.
- New parity tests for CVE-2024-47831/CVE-2026-44577 (image width-allowlist +
  decompression bomb) and CVE-2026-53668 (`javascript:`/`vbscript:` redirect
  target neutralized to an inert path). Five `CVE-DEFENSE-GUIDE.md` rows moved
  to "Protected (tested)".

### Fixed

- **In-repo RSC/Server-Action boundary detection:** the import-graph boundary
  crawl excluded the entire framework root, so an app living under the repo (an
  example, a monorepo app) could never form a `"use client"`/`"use server"`
  boundary. The exclusion is now scoped to the framework's `src/` subtree. Real
  (jsr:) users were unaffected; this unblocks source-checkout/monorepo apps.

Pre-1.0.0 production-readiness remediation (a whole-app review; all fixes carry
regression tests, no public API break):

- **Flight boundary crawl (H1):** the client/server boundary manifest was built
  from **page files only**, so an interactive island imported solely by a
  `layout`/`template`/slot shipped non-interactive in prod. The crawl now covers
  every route entry (page + layout + template + slot chains) via a shared
  `routeEntryFiles` helper.
- **ISR background regeneration (H2):** a hung upstream during a stale-while-
  revalidate regen leaked the in-flight key and froze staleness for that route
  forever. Regen now runs under its own bounded deadline + `AbortController` and
  frees its key on a hard timer regardless of settle; it also no longer takes
  the render leader-lock.
- **`useSyncExternalStore` hydration (H3):** the hook ignored
  `getServerSnapshot` during hydration (guaranteed mismatch for SSR state libs)
  and could miss a store mutation landing in the subscribe window. It now reads
  the server snapshot while hydrating and re-checks after subscribing.
- **Dynamic-page CDN safety (M1):** an HTML response whose render read
  `cookies()`/`headers()` now carries `Cache-Control: private, no-store` and
  `Vary: Cookie`, so a shared cache can't serve one visitor's per-user render to
  another.
- **Server Action error reporting (M2):** a thrown Server Action now reaches
  `onRequestError` instrumentation (it returns a normal 500, so it never hit the
  top-level reporter before).
- **Fetch cache key includes headers (M3):** `cachedFetch` / the automatic fetch
  cache keyed on URL/body only; two requests differing only by a header (e.g.
  `Authorization`) collided onto one entry. A normalized header fingerprint is
  now part of the key.
- **Data-cache byte budget (M4):** the in-memory data cache was count-bounded
  but not byte-bounded; it now evicts the LRU to hold a byte budget too (~32
  MB).
- **`x-request-id` on error responses (M5):** timeout/abort/shed/global-error
  responses now echo the correlation id.
- **`useTransition` sync throw (M7):** a synchronous throw in the transition
  callback left `isPending` stuck true; `onComplete` is now scheduled before the
  rethrow.
- **Effect cleanup/setup ordering (M8):** within a commit phase, ALL effect
  cleanups now run before ANY setup (React's order), so a resource handed
  between siblings is released before it is re-acquired.
- **Tier-3:** framework-src exclusion now matches on a path-segment boundary (a
  sibling `…/src-app/` is no longer wrongly excluded) and realpath-normalizes
  the framework root for symlinked checkouts; an auto-implemented `HEAD` cancels
  the synthesized `GET` stream instead of leaking it; a real page URL hit by a
  non-GET/HEAD method returns `405` + `Allow` (was `404`).

### Added

- **Examples:** `examples/image` (`<Image>` + `/_denext/image` optimizer + OG
  image), `examples/caching` (`unstable_cache` + `revalidateTag` + ISR),
  `examples/actions` (Server Actions, progressive enhancement + a client
  island), and `examples/streaming` (Suspense, `loading.tsx`, streaming SSR).
  Each has an integration smoke test.
- **Tests:** ~100 new tests — API-route dispatch (previously untested), prod/dev
  server contracts, request-path helpers, router/metadata edge cases, new CVE
  parity cases, plus opt-in real-browser e2e for the new examples.
- **Benchmark:** a load & memory tier (`deno task bench:load`) — high-volume
  concurrent requests with throughput, latency percentiles, error rate, and
  server RSS (idle vs. peak), head-to-head with Next.js when its fixture is
  built.

### Changed — first-party AVIF codec (zero-npm)

- **AVIF output is now first-party.** The image optimizer's AVIF encoder is the
  new `@denext/avif` JSR package (a Deno-native fork of `@jsquash/avif@2.1.1`'s
  prebuilt libavif wasm, driven via emscripten's `instantiateWasm` hook) instead
  of the opt-in `@jsquash/avif` npm peer dep. AVIF output now works with **no
  import-map setup and zero npm** — joining `@denext/photon` (resize/WebP) and
  `@denext/sqlite` (durable cache). The optimizer now passes `quality` (0–100)
  straight through, dropping the lossy `quality → cqLevel` round-trip.
  `tests/image-next16.test.ts`'s AVIF case, which previously self-skipped when
  the peer dep was absent, now runs on CI.

### Changed — first-party OG renderer (`next/og`), zero peer codecs remain

- **`next/og` `ImageResponse` is now first-party.** It renders through the new
  `@denext/og` JSR package — a self-contained esbuild bundle of the full
  **satori + yoga + resvg** stack (vendored from `@cf-wasm/og@0.5.0`'s `node`
  entry, with all wasm and the default Noto Sans font inlined as base64) —
  instead of the opt-in `@cf-wasm/og` npm peer dep. `next/og` now works with
  **no import-map setup and zero npm**, and plain-Latin rendering needs **no
  runtime permissions**. This retires the **last** opt-in peer codec:
  `@denext/photon`, `@denext/avif`, `@denext/og`, and `@denext/sqlite` are all
  first-party JSR packages now — **no npm peer dependencies remain**. The
  internal `src/server/peer-codec.ts` loader was removed.
  `tests/image-response.test.ts`, previously self-skipping when the peer dep was
  absent, now runs on CI.

### Added — Cache Components (`use cache` + PPR), experimental

Behind `experimental: { cacheComponents: true }` (off by default; the render
path is byte-for-byte unchanged when off). Version held at `0.12.0`.

- **`use cache` directive** — module-top or function-body, compiled by a
  build-time swc AST transform (`src/build/use-cache-transform.ts`) into a
  `__useCache` runtime wrapper with single-flight, `cacheLife`, and `cacheTag`.
  A transitive server loader reaches cached helpers imported by directive-free
  modules.
- **New caching APIs** — `cacheLife` profiles, `cacheTag`,
  `revalidateTag(tag, profile)` soft-expire, `updateTag` (read-your-writes in a
  Server Action), and `refresh()`.
- **Partial Prerendering** — a cacheable page renders a request-independent
  **static shell** (cached once, including `use cache` islands) with dynamic
  subtrees (`cookies()`/`headers()` behind a Suspense boundary) postponed to
  **per-request holes** spliced into the shell. New `src/runtime/prerender.ts`
  (Postpone signal), `src/jsx/render-to-ppr.ts` (two-pass shell/hole renderer),
  and gated wiring in `renderPage`/`app.ts`. See
  [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md) for the first-landing scope
  (buffered resume, `useId`/Flight/metadata caveats).
- **Example:** `examples/cache-components` (a `use cache` data helper + a PPR
  page with a static shell and a per-request dynamic hole) with an integration
  smoke test.

### Added — `next/image` alignment (Next.js 16)

- New `images` config: `qualities` (default `[75]`), `minimumCacheTTL` (default
  `14400`), `localPatterns`, `formats` (default `["image/webp"]`; add
  `"image/avif"`), `maximumRedirects` (default `3`), and the
  `dangerouslyAllowLocalIP` SSRF escape hatch.
- The `q=` param is now applied (coerced to the nearest configured quality);
  **AVIF** output is negotiated from `Accept` and encoded via `@jsquash/avif`;
  `Cache-Control` `max-age` derives from `minimumCacheTTL`; `Vary: Accept` is
  emitted; `16` was dropped from the default image sizes; `localPatterns` guards
  local-source enumeration.

### Verified in a real browser

- The `"use client"` island's **Server-Action RPC round-trip on submit** and the
  `/stream` **`__dnxSwap` out-of-order reveal** both work end-to-end under
  headless Chromium (`tests/e2e/actions.e2e.test.ts`,
  `tests/e2e/streaming.e2e.test.ts`). Two earlier e2e assertions were flaky —
  the streaming test checked the fallback text that the swap deliberately
  replaces, and a headless keystroke silently dropped on one input — both now
  deterministic. No framework change was needed.

## [0.12.0] - 2026-08-14

Closes the remaining React-19 and Next.js App-Router gaps — each built
faithfully, no placeholders — **plus** a round of proactive security hardening
driven by `CVE-DEFENSE-GUIDE.md`: all six tracked residual-risk gaps closed or
mitigated, and ten more CVE classes locked in with parity tests. denext is
stricter than Next.js out of the box (Next ships **no** default security headers
or CSP). No breaking public API; the default CSP blocks external scripts/styles
by design (per-route opt-in).

### Security — new defaults

- **Default Content-Security-Policy** on every document response:
  `default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self';
  form-action 'self'; img-src 'self' data:`.
  `script-src` is exactly `'self'` — inline scripts are **never** hashed, so an
  injected inline `<script>` can't self-authorize; each inline `<style>` denext
  emits is allowed by a content `'sha256-…'` (nonces would be useless under the
  byte-identical ISR cache), and `style-src-attr 'unsafe-inline'` keeps React
  `style={{}}` working. **⚠️ Intentional behavior change:** external scripts and
  stylesheets are **blocked by default** — opt in per route via a segment-config
  export,
  `export const csp = { scriptSrc: ["https://…"], styleSrc: ["https://…"] }`
  (opt-ins union down the layout→page chain); an author-supplied inline
  `<Script>` needs an external `src` or such an opt-in. An app CSP set via
  `headers()`/middleware overrides the default. The computed policy is stored
  with the cached page.
- **Default hardening headers** on every response (only where the app hasn't set
  its own): `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`,
  `Referrer-Policy: strict-origin-when-cross-origin`, and HSTS when served over
  HTTPS.
- **Dangerous URL scheme filtering** — `javascript:`/`vbscript:` in any
  URL-bearing attribute (and executable `data:` in navigable/scripty contexts)
  are dropped at a shared chokepoint (all SSR renderers + client
  `setAttribute`), defeating whitespace/control-char obfuscation. React only
  warns; denext neutralizes.
- **Framework redirects normalized** — middleware, server-component and
  server-action redirects route their `Location` through `safeRedirectLocation`
  (protocol-relative escapes collapse to same-origin; explicit `http(s)://`
  targets preserved).
- **Slow-body idle timeout** on the Server-Action body reader (→ 408), so a
  trickled or never-closed body can't pin a handler under the size cap.
- **Soft-nav / prefetch responses** carry `Cache-Control: private, no-store` so
  a shared CDN can't cache the nav variant.
- **Dev reload-stream Origin check** — the dev `/_denext/reload` SSE endpoint
  refuses cross-origin subscribers; `allowedDevOrigins` mirrors Next.js.

### Security — developer aids

- **`dangerouslySetInnerHTML` dev warning** (SSR + client, dev-only), pointing
  at a sanitizer; also fixed a latent client bug where the HTML was never
  applied (a bogus `[object Object]` attribute was set instead).

### Tests

- New parity/regression suites: `tests/url-scheme.test.ts`,
  `tests/dangerous-html.test.ts`, `tests/dev-origin.test.ts`,
  `tests/security-headers.test.ts`, `tests/csp.test.ts`,
  `tests/csp-integration.test.ts`, plus ten new
  `tests/nextjs-cve-parity.test.ts` cases (param injection, segment-prefetch,
  prefetch caching, malformed-URL, error-page escaping, action-id enumeration,
  server-function source non-disclosure, internal-header leakage, invalid-UTF-8
  cache keying, WS-upgrade).

### Added — React 19 fidelity

- **`use(Context)`** — `use()` now handles React 19's context overload (reads
  the nearest provided value, may be called conditionally), on the client and
  under every SSR renderer.
- **Render-phase `useDeferredValue`** — replaced the effect-based approximation
  with a true render-phase deferral driven by the fiber priority lanes: an
  urgent render returns the previous value and self-schedules a time-sliced,
  interruptible catch-up. Adds the React 19 `initialValue` argument.
- **Form-scoped `useFormStatus`** — was a single global "any action pending"
  flag; now tracks the nearest enclosing `<form action={fn}>`, so concurrent
  forms report independent status.
- **StrictMode dev double-invoke** — was a no-op Fragment alias; now really
  double-invokes renders and mount effects (setup → cleanup → setup) in
  development to surface impure renders and missing cleanup. A transparent
  Fragment in production and SSR (zero cost).
- **`SuspenseList` reveal ordering** — `revealOrder`
  (forwards/backwards/together) and `tail` (collapsed/hidden) are now enforced:
  sibling `<Suspense>` boundaries reveal in order regardless of the order their
  data resolves.
- **Profiler actual-vs-base durations** — the reconciler now times each
  component's render, so `actualDuration` counts only the components that
  re-rendered this commit (memoized/bailed excluded) while `baseDuration` covers
  the whole subtree.
- **Transition-aware Suspense** — a `startTransition`/`useDeferredValue` update
  that re-suspends an already-revealed boundary now keeps the current content on
  screen (no fallback flash) and commits the new content once the promise
  settles, matching React's recommended pattern. Because the subtree is never
  unmounted, its local state is preserved across the re-suspend. (An urgent,
  non-transition re-suspend still shows the fallback — full Offscreen
  mount-hidden for that path is tracked in ROADMAP-1.0.)

### Added — Next.js App Router

- **Layout-level `generateMetadata` / `generateViewport`** — layouts previously
  contributed only static `metadata`; their generator functions now run at every
  segment (page metadata still wins on conflict).
- **Stale-while-revalidate ISR** — a numeric `revalidate: N` serves fresh for N
  seconds, then serves the stale render immediately (`x-denext-cache: STALE`)
  while regenerating once in the background, instead of a blocking TTL miss.
  Wired through the in-memory, Deno KV, and SQLite stores.
- **Automatic `fetch()` caching, uncached by default** — a bare `fetch()` is
  passed through uncached (no accidental caching of authed/per-user data); a GET
  given `next: { revalidate, tags }` or `cache: "force-cache"` is cached in the
  data cache and its tags feed `revalidateTag` to purge dependent pages.
- **Reconcile-in-place soft navigation** — a client navigation now reconciles
  the new route through a retained reconciler root (patching the DOM, preserving
  state in unaffected subtrees) instead of replacing the root's innerHTML and
  re-hydrating from scratch.

### Fixed — production-readiness audit

A six-dimension source-level audit found 1 Critical, 5 High, 16 Medium, and 11
Low issues; all are fixed (each its own commit + test where runtime-verifiable).

- **SSRF via IPv4-mapped IPv6 in `safeFetch` (Critical).** The IPv6 guard was
  string-prefix matching; a real parser now expands `::`, reads embedded IPv4,
  and routes IPv4-mapped (`::ffff:7f00:1`), IPv4-compatible, and NAT64
  (`64:ff9b::`) forms through the IPv4 block-list — closing a cloud-metadata
  reachability bypass.
- **Real request cancellation + default timeout (High).** The abort signal
  threads into the render (checkpointed `throwIfAborted`), and `requestTimeout`
  defaults to 30s (background ISR regen exempt; `0` disables) so a wedged render
  can't pin resources. `onError` is guarded against its own throw.
- **Client-runtime resilience (High).** An unboundaried transition throw no
  longer wedges the scheduler (state is reset and re-thrown); effect and
  unmount-cleanup errors route to the nearest error boundary instead of
  stranding the tree.
- **Least-privilege CLI (High).** The CSS re-exec propagates the parent's actual
  permission grants instead of `-A`.
- **Graceful-shutdown drain (High).** `serveWithPortFallback` now calls
  `server.shutdown()` to drain in-flight requests (the `Deno.serve` `signal`
  option hard-closes); covered by a new integration test.
- **Server/redirect hardening (Medium).** Global-error output is redacted in
  production (generic message + correlatable digest); `serve()` forwards every
  `AppConfig` field to `createApp`.
- **Cache correctness & bounds (Medium/Low).** Page cache key normalizes
  query-param order (no forking/thrashing); the in-memory store gains a byte
  budget + expired sweep; the SQLite store retries a failed open and wraps
  writes in transactions; the KV store skips already-expired/oversize writes and
  checks `commit().ok`; `safeKey` throws on non-serializable args instead of a
  colliding fallback.
- **Image optimizer (Medium).** A decode-free header probe (PNG/GIF/JPEG/WebP)
  rejects decompression-bomb dimensions before decode; local `public/` sources
  are byte-capped.
- **Build & config (Medium).** Builds stage into a temp dir and swap atomically
  (no half-written `client/` on failure); `denext.config` is validated on load
  with field-scoped errors; build/export failures print a clean CLI message; the
  dev/prod bundling divergence is documented.
- **Observability (Medium/Low).** A per-request correlation id rides
  `RequestLogInfo`, the error log, and the `x-request-id` header;
  `DENEXT_LOG=json` emits structured JSON; cache-error logging is rate-limited
  per operation; prefetch cache is LRU+TTL-bounded.
- **Tests/CI.** SQLite failure-mode tests (fake module, no optional dep) and a
  nightly, non-blocking e2e workflow.

### Fixed — release-readiness pass (path to 1.0.0)

A final batch of audits (React-19/Next-16 surface, npm-interop, production
readiness, security, test coverage, developer experience) ahead of the 1.0.0
stability commitment. No blocking correctness defects were found; the following
close cheap compat gaps, small feature gaps, and secure-default/test-gate
polish.

- **CLI / package entry never exited.** `denext init`/`create` — and any script
  doing `import "mod.ts"` — finished their work but hung forever: the fiber
  reconciler built a `MessageChannel` with a live listener at module scope (a
  ref'd handle keeping Deno's event loop alive), dragged into the SSR/CLI graph
  by the class runtime's static import of the client reconciler. The channel is
  now lazily created on first real (browser) use, and the class runtime injects
  `scheduleUpdate` instead of statically importing the client reconciler; a
  subprocess regression test asserts a clean, timely exit.
- **npm-interop crash-class fixes.** `react-dom/server` (+`.browser`/`.edge`) is
  now aliased to a denext shim (React-shaped `renderToReadableStream`; the
  synchronous APIs throw a guided error) so importing it no longer pulls a
  second React; `useFormStatus`/`useFormState` are exported from `react-dom`;
  `React.cache` is added (client-safe arg memo); `react-dom/test-utils` (`act`)
  is aliased. `react-is` gains real `isStrictMode`/`isProfiler`/
  `isContextConsumer`; `forwardRef`/`memo` brand fields are now enumerable.
- **Small Next-16 features.** `next/form` (`<Form>` — progressive-enhancement
  GET form that soft-navigates), `connection()` and `after()` exported from
  `next/server`, and `useLinkStatus` (global navigation-pending) from
  `next/link`.
- **Security/ops hardening.** The reused inbound `x-request-id` is sanitized
  (safe token chars, length-bounded) so it can't forge logs or inject the echoed
  header; HSTS's `x-forwarded-proto` trust is gated on `trustForwardedHeaders`;
  new `DEPLOYMENT.md` documents the operational responsibilities left to the
  edge (concurrency ceiling, SSRF-pinning, CSP-on-streaming, proxy origin).
- **Test hardening.** A fast, blocking next-compat build guard runs on every PR
  (the real-npm proof stays nightly); a `test:coverage` task; and new coverage
  for `precompress.ts`, `next/request.ts`, `next/cookies.ts`, and
  `next-intl/routing.ts`.
- **DevTools honesty.** The React DevTools bridge now reports `bundleType`
  honestly (production `0`, development `1`) instead of always advertising a dev
  build.
- **Docs.** New `KNOWN-LIMITATIONS.md` (behavioral divergences, experimental-API
  list, honest DevTools scope) and `ROADMAP-1.0.md` (deferred 1.0.0 work).

### Changed

- **Server Actions body-size default lowered to 1 MiB** (`actionMaxBodyBytes`),
  matching Next.js' `serverActions.bodySizeLimit` default of `1mb` (previously
  10 MiB). A stricter, safer default; large payloads (e.g. multipart uploads)
  opt into a higher limit via `actionMaxBodyBytes`.

## [0.11.1] - 2026-08-10

Docs and a new example for the 0.11.0 fiber concurrency — no runtime code
change.

### Added

- **`examples/concurrency`** ("smoothness under load") — a demo of what the
  fiber reconciler does that cooperative scheduling could not: a
  `requestAnimationFrame` spinner + FPS counter keep advancing and the text
  field stays typable while a transition re-renders a grid of up to 25,000
  cells; a **Blocking-mode toggle** runs the same update as a plain `setState`
  for a direct before/after; and a started/committed counter shows the in-flight
  renders discarded by interruption. `deno task example:concurrency`.

### Docs

- README: corrected the stale "function-components only / classes throw if
  constructed" limit (class components have been supported since 0.9.0); added a
  "Concurrent rendering (fiber)" feature bullet; refreshed the bundle-size table
  to the measured 0.11.0 numbers (~12 KB first load / ~11 KB runtime baseline —
  the fiber reconciler added ~1.8 KB gz, still ~11× smaller than Next.js 16).
- Refreshed the now-stale "cooperative scheduler / no mid-tree interruption"
  wording in `examples/transitions` and the transition test headers.

## [0.11.0] - 2026-08-10

Rewrites the client reconciler around a **fiber architecture**, delivering
genuinely **time-sliced and interruptible concurrent rendering** for the
transition lane — the long-standing gap documented in the migration guide's §10.
Still **no new npm runtime dependency**, and the public API is unchanged.

### Added

- **Fiber reconciler** (`src/client/fiber/`). Rendering proceeds as resumable
  units of work over a double-buffered fiber tree (`child`/`sibling`/`return`
  links + an `alternate` buffer). The next tree is built **off-DOM** and
  committed **atomically**, so an interrupted or discarded render never shows
  partial DOM (no tearing).
- **Time-slicing (transition lane).** A transition render checks a ~5 ms frame
  budget between units of work and yields via `MessageChannel`, resuming on the
  next slice — so a heavy transition no longer blocks paint or input. It commits
  only when the render drains.
- **Priority lanes with interrupt-and-restart.** An urgent (sync) update that
  arrives while a transition is in flight abandons the transition's off-DOM
  work, commits the urgent update immediately, and restarts the transition from
  the freshly-committed state (`useId` counters are snapshot/restored so a
  restart is deterministic).
- **`flushSync`** now reclaims any in-flight transition slice and renders
  everything to completion synchronously.
- **Layout / passive effect phase split.** `useLayoutEffect`,
  `useInsertionEffect`, and class `componentDidMount`/`componentDidUpdate` run
  **synchronously at commit** (before paint); `useEffect` (and
  `useSyncExternalStore` subscriptions) are now **passive** — scheduled on a
  task after commit, flushed before the next render and inside
  `flushSync`/`act`, matching React's effect ordering. This closes the last item
  from the migration guide's §10, so denext now covers React's full
  concurrent-rendering model (fiber work loop, time-slicing, priority lanes,
  double-buffering, phase split).

### Changed

- The **sync (default) lane still renders and commits synchronously** —
  `render()`, `flushSync()`, and `act()` are synchronous. Passive effects
  (`useEffect`) now run on a post-commit task (as in React), so a test asserting
  a `useEffect` side effect after a bare `render()` must flush first
  (`flushSync()` or `act()`); layout effects and class lifecycle remain
  synchronous.
- Extracted the renderer-agnostic pieces (DOM props/events/refs, vnode helpers,
  context maps) into shared modules
  (`src/client/{dom-props,vnode-utils,context-map}.ts`) reused by the
  reconciler.

## [0.10.0] - 2026-08-10

Rounds out the React API surface (the pieces that don't require true concurrent
rendering) and fixes two library-compat gaps uncovered by running real animation
libraries. Still **no new npm runtime dependency**.

### Added

- **`useInsertionEffect`** — runs at commit for CSS-in-JS / animation style
  injection. Unblocks `motion` (motion.dev / framer-motion), and is what emotion
  and styled-components use. (denext has no separate pre-mutation phase, so it
  commits alongside layout effects; a no-op during SSR.)
- **`Context.Consumer`** — `createContext(...)` now returns a working
  render-prop consumer (`<Ctx.Consumer>{value => …}</Ctx.Consumer>`). Also fixes
  libraries that merely reference/assign to `.Consumer` (e.g. react-spring's
  `makeContext`).
- **`Profiler`** — measures a subtree's render timing and calls `onRender` after
  each commit (best-effort durations; denext renders synchronously).
- **`act(callback)`** — the React test helper: runs the callback, flushes
  pending updates/effects (including transitions), and returns a thenable for
  sync/async use.
- **Resource preloading** (`react-dom`): `preload`, `preinit`, `preconnect`,
  `prefetchDNS` — inject deduped `<link>`/`<script>` into `document.head` on the
  client; safe no-ops during SSR.
- **`SuspenseList`** — present as a documented pass-through (renders its
  children); `revealOrder`/`tail` coordination is not yet enforced (planned with
  concurrent rendering).
- **`useDebugValue`** (DevTools-only no-op) and **`useFormState`** (deprecated
  alias of `useActionState`), for API completeness.
- **Examples:** `examples/animation` — real `motion` **and** `@react-spring/web`
  co-existing in one project, both on denext's single React (SSR + hydrate).

### Fixed

- `mod.ts` `VERSION` was stale (`0.8.12`); now tracks the package version.
- CI's doc-lint step now runs the `deno task doc-lint` (single source of truth)
  instead of a hardcoded file list that had drifted and reported false errors.

## [0.9.0] - 2026-08-09

Reconciler-level React fidelity + Next.js runtime fidelity — the compat story
moves from "matching API names" to "being React at the reconciler level" and
running real Next.js apps. Every runtime piece here rides Deno built-ins / JSR
`@std/*` / `Intl.*` / `node:sqlite` — **no new npm runtime dependency**
(enforced by a CI guard).

### Added

- **First-class, context-preserving portals.** `createPortal` is now backed by a
  reconciler `PORTAL` instance kind: the portaled subtree keeps its place in the
  component and **context** tree (context providers and error boundaries above
  the call are visible across the portal), while its DOM mounts into the target
  container. This fixes the previous sub-root portal, which lost context — the
  gating requirement for Radix/shadcn overlays (Dialog/Popover/Tooltip). Also
  exported natively as `denext`'s `createPortal`.
- **`react-is` compat** (`@denext/denext/react-is`) with type branding.
  `forwardRef`, `memo`, `lazy`/`dynamic`, and `Suspense` now carry stable
  `$$typeof` brands, so
  `isForwardRef`/`isMemo`/`isLazy`/`isFragment`/`isPortal`/
  `isSuspense`/`isValidElement`/`typeOf` classify denext's shapes.
- **`Slot` / `Slottable` + `composeRefs`** (`@denext/denext/slot`,
  `@denext/denext/compose-refs`) — the Radix `asChild` primitive: merges props
  onto a single child element (className joins, handlers compose child-first,
  refs merge), no wrapper element.
- **Ref fidelity.** Refs are now detached on unmount and when they change;
  React-19 cleanup-returning callback refs are honored.
- **Event-system fidelity.** `onChange` maps to the DOM **`input`** event
  (per-keystroke, controlled-input semantics), `onDoubleClick` → `dblclick`, and
  `on*Capture` registers a real capture-phase listener (previously produced a
  broken `clickcapture` type).
- **Full `NextRequest` / `NextResponse`** (`next/server`). `NextRequest` adds
  `nextUrl` (cloneable), `cookies` (`@std/http`-backed), and best-effort
  `ip`/`geo`. `NextResponse` is a real `Response` subclass with a `.cookies`
  writer; its statics use Next's `x-middleware-*` header protocol so
  `NextResponse.next()`/`.rewrite()` (with `res.cookies.set(...)`) interoperate
  with denext's middleware runner. Middleware handlers now receive a
  `NextRequest`.
- **`next-intl` compat** (`next-intl`, `/server`, `/navigation`, `/middleware`,
  `/routing`): `useTranslations`/`useLocale`/`useFormatter`/`useMessages`/
  `NextIntlClientProvider`, server `getTranslations`/`getLocale`/`getMessages`/
  `getFormatter`/`getRequestConfig`/`setRequestLocale`, locale-aware navigation,
  and locale-routing middleware — over a compact **ICU MessageFormat** built on
  `Intl.PluralRules`/`NumberFormat`/`DateTimeFormat` (no `intl-messageformat`).
- **`next/font/local` + `next/font/google`.** Local fonts self-host via
  `@font-face`; Google fonts register a stylesheet link (with an optional
  build-time downloader for true self-hosting). Both return the
  `{ className, style, variable }` handle. ~40 popular Google families are
  exposed as named exports.
- **`better-sqlite3` over `node:sqlite`** (`@denext/denext/better-sqlite3`) —
  `prepare().run/get/all/iterate`, `.pluck()/.raw()`, `exec`, `pragma`,
  `transaction` (nesting via savepoints), `function`, `close`. Swaps the native
  npm addon for Deno's built-in SQLite.
- **`denext create/init --next-compat`** now also aliases `react-is`,
  `next-intl` (+ `next-intl/`), and `better-sqlite3`.
- ~60 new tests across portals, events, refs, react-is, Slot, NextRequest/
  Response, next-intl (ICU/hooks/server/navigation/middleware), fonts, and
  sqlite, plus a guard test that fails if any `npm:` specifier enters the compat
  runtime.

### Changed

- The middleware runner recognizes the `x-middleware-next` /
  `x-middleware-rewrite` response headers and preserves `Set-Cookie` across the
  chain.

### Fixed (production-readiness review)

- **POST bodies survive next-compat middleware.** The `NextRequest` adapter now
  wraps a `clone()` of the request, so constructing it no longer consumes the
  original body — Server Actions and API route handlers behind middleware can
  read it. (Previously any POST behind next-compat middleware got an
  already-consumed body.)
- **next-intl locale is request-isolated.** `setRequestLocale`/`getLocale`/
  `getTranslations` store the active locale in the request's `AsyncLocalStorage`
  context instead of a process global, so concurrent SSR for different locales
  can no longer cross-contaminate.
- **`withHeaders` preserves multiple `Set-Cookie`.** It appends cookies (via
  `getSetCookie()`) instead of `set()`-collapsing them, so a
  `NextResponse.next()` that sets several cookies keeps them all.
- **`next/font` CSS is emitted.** `renderFontStyles()` is now wired into the SSR
  `<head>` pipeline, so `@font-face`/font stylesheet links from
  `next/font/local` and `next/font/google` actually reach the page.
- **Event-listener keys no longer collide.** Listeners are keyed by the React
  prop name, so `onChange`+`onInput` (both DOM `input`) and
  `onClick`+`onClickCapture` each keep their own handler.
- **`better-sqlite3` transaction depth** decrements exactly once even if
  `COMMIT`/`RELEASE` throws (no counter corruption); `fileMustExist` now throws
  for a missing file; `Slot` throws (like Radix) instead of silently dropping
  props when given no single element child; the ICU parse cache is bounded.
- **Compat-fidelity polish:** `react-is.isContextProvider` now recognizes a
  denext context; the ICU formatter threads `#` into nested `select` branches
  and renders missing values gracefully (empty / `other`) instead of `"NaN"`;
  `NextResponse.redirect` requires an absolute URL (like Next) and
  `NextResponse.next({ request: { headers } })` now overrides the downstream
  request headers; `ResponseCookies.get`/`getAll` return the full cookie with
  its attributes.

## [0.8.12] - 2026-08-09

### Added

- **Next.js compat entrypoints.** Alias `next/*` to denext in the import map so
  code that imports from `"next/..."` resolves to denext: `next/link`,
  `next/image`, `next/script`, `next/dynamic`, `next/navigation` (App Router
  hooks + `redirect`/`notFound`/…), `next/headers` (`cookies`/
  `headers`/`draftMode`), `next/cache` (`revalidatePath`/`revalidateTag`/
  `unstable_cache`), `next/og` (`ImageResponse`), and `next/server` (a
  `NextResponse` shim mapping to denext middleware returns, plus `userAgent`). A
  single `"next/": "jsr:@denext/denext/next/"` import-map prefix covers them
  all.
- **`denext create/init --next-compat`** — writes the React + Next import-map
  aliases into the scaffolded `deno.json`; also offered in the interactive
  multi-select.
- **React compat improvements:** a real client-side `createPortal` (renders into
  a separate DOM container via a sub-root, preserving the target's existing
  children) and **`useEffectEvent`** (React 19.2), added to the core hooks and
  the `react` shim. +17 compat tests.

  Scope note: these aliases provide **framework-API** compatibility (routing,
  Link/Image, navigation, headers/cache, basic route handlers). They do not make
  denext a drop-in for arbitrary React-ecosystem libraries that depend on
  React's reconciler internals (refs/`Slot`/`react-is`), nor for
  `NextRequest.nextUrl`/ `cookies` or `next-intl`.

## [0.8.11] - 2026-08-09

### Added

- **React compatibility via import aliases.** New entrypoints let code and
  libraries that `import ... from "react"` / `"react-dom"` run on denext by
  aliasing those specifiers in the import map (no React install):
  - `@denext/denext/react` — re-exports denext's hooks/helpers under their React
    names (`createElement`, `Fragment`, every `use*` hook, `memo`,
    `createContext`, `Suspense`, `lazy` = `dynamic`) plus compat shims for
    `forwardRef`, `Children`, `cloneElement`, `isValidElement`, and a default
    `React` object.
  - `@denext/denext/react-dom` and `@denext/denext/react-dom/client` —
    `createRoot` / `hydrateRoot` / `flushSync` plus legacy `render` / `hydrate`.
  - `@denext/denext/react/jsx-runtime` (+ `jsx-dev-runtime`) — the automatic JSX
    runtime under React's specifier.

    Caveats: function-components only (`Component`/`PureComponent` resolve but
    throw if constructed); `createPortal` is a best-effort no-op. +10 tests.
    Combined with 0.8.10's React DevTools support, the ecosystem and tooling see
    denext as React.

## [0.8.10] - 2026-08-09

### Added

- **React DevTools support.** The client reconciler now registers denext as a
  renderer with the React DevTools extension (`__REACT_DEVTOOLS_GLOBAL_HOOK__`)
  and reports its tree as React fibers on each commit — so the extension
  recognizes a denext app and shows its component tree, as if it were React.
  It's a cheap no-op when the extension isn't installed, and every call into the
  extension is guarded so a DevTools error can never affect rendering. New
  `src/client/devtools.ts`; +7 tests (registration, fiber mapping, the guard,
  and an end-to-end commit through the real reconciler).
- **`--desktop` scaffolding includes an app-icon convention** — an
  `icons/README.md` documenting where to drop `app.icns` / `app.ico` / `app.png`
  and the `desktop.app.icons` config to enable them (`deno desktop` uses a
  default icon otherwise, so packaging still works out of the box).
  `examples/native` ships a real cross-platform icon set wired into its
  `desktop` config.

### Fixed

- **`denext build` now cleans its client output dir first**, so content-hashed
  `chunk-*.js` from prior builds no longer accumulate on rebuilds.

### Documentation

- New project logo; README gains the logo, a multi-select prompt preview under
  Quick start, and a React DevTools feature bullet. Refreshed the bundle-size
  numbers (first load ~8 KB after the DevTools bridge, still ~10× under
  Next.js).

## [0.8.9] - 2026-08-09

### Changed

- **`denext create`/`init`: one multi-select instead of five yes/no prompts.**
  On a TTY, the scaffolder now shows a single checkbox list — ↑/↓ (or j/k) to
  move, space to toggle, enter to confirm — for Tailwind, the `src/` layout, the
  compiler, desktop, and mobile, with any features passed as flags pre-checked.
  Flags and `--yes` stay fully non-interactive (unchanged for scripts/CI). New
  dependency-free `src/build/multi-select.ts` with injectable terminal I/O; +7
  tests for the key handling.

## [0.8.8] - 2026-08-09

### Added

- **Native scaffolding — `denext create/init --desktop` and `--capacitor`.** The
  scaffolder can now wire up a native **desktop** app (via Deno 2.9's
  `deno
  desktop`) and/or **iOS/Android** (via Capacitor) — generating config
  files **and** the `deno task`s to drive them (not just config). Both build on
  `denext export` (static SSG to `out/`):
  - `--desktop`: a `desktop.ts` entry (`Deno.serve()` over the static export,
    which `deno desktop` wraps in a native WebView window), a `desktop` block in
    `deno.json` (app name / bundle id), and `export` / `desktop` /
    `desktop:package` tasks.
  - `--capacitor`: a `capacitor.config.ts` (`webDir: "out"`), a `package.json`
    for Capacitor's CLI + platform packages, and `export` / `mobile:sync` /
    `mobile:ios` / `mobile:android` tasks.

    Both are offered as interactive prompts and as flags; `denext --help` lists
    them.
- **`examples/native/`** — one denext app packaged three ways (web,
  `deno desktop`, Capacitor) in a single project, with a README for each path.

### Changed

- **CI pins Deno to 2.9.5** (from a floating `v2.x`) so `deno fmt`/`deno lint`
  are reproducible between contributors and CI. Bump deliberately (e.g. to 3.x
  for stable KV) and re-run `deno fmt` when moving.

## [0.8.7] - 2026-08-09

### Performance

- **Static routes now ship zero JavaScript.** A page route with no interactivity
  anywhere in its tree — no state/effect/ref/context hooks, no DOM event
  handlers, no `dynamic()` island — is served as pure server-rendered HTML with
  **no client bundle and no hydration script**. The build detects these by
  scanning each route's whole transitive import graph and is deliberately
  conservative: any interactivity signal, or any uncertainty (unreadable module,
  failed crawl), errs toward hydrating, so an interactive page is never
  mis-classified as static. A `<Link>` on a static page still works (a plain
  anchor; a soft navigation _into_ the page from an interactive page also still
  works). New `src/build/hydration.ts` (`routeNeedsHydration`); the build
  records `staticRoutes` in `manifest.json`, and the prod server skips both the
  hydration script and the missing-bundle check for them. Content/marketing
  pages are now pure HTML.

### Documentation

- New **"Tiny by default"** section in the README (and a matching module-doc
  bullet) with the measured bundle-size comparison vs Next.js / React.

## [0.8.6] - 2026-08-09

### Performance

- **Client bundling now shares one runtime chunk across all routes.** Each page
  route was previously bundled in isolation, which inlined a full copy of the
  denext client runtime (~19 KB raw / ~6.9 KB gzip) into **every** route entry.
  The production build now bundles all page routes in a single code-split pass,
  hoisting the runtime into **one shared chunk** that every route references —
  downloaded once and cached across client-side navigations. On the example app,
  per-route entries dropped from ~19 KB to ~1 KB each; a navigation after the
  first page now transfers only the route's own delta (~0.6 KB gzip) instead of
  re-downloading the runtime. New `bundleRoutes()` in `src/build/bundle.ts`; the
  dev server's on-demand per-route bundling is unchanged. Added a bundle-budget
  regression test.

## [0.8.5] - 2026-08-09

### Documentation

- **A real landing page on JSR.** The `@denext/denext` package Overview on JSR
  renders the main entrypoint's module doc, which was a single sentence plus one
  `renderToString` example. Rewrote `mod.ts`'s `@module` doc into a proper
  overview: what denext is and why (no npm / no React, App Router parity,
  security-first, Deno-native), a quick-start App Router example, and the list
  of entrypoints. No code or API changes.

## [0.8.4] - 2026-08-09

Continues the Next.js security-parity work against the most recent disclosures
(the July 2026 Next.js release), fixing one real gap it surfaced and restoring
the JSR documentation score. No breaking changes.

### Security

- **`cachedFetch`: the cache key now reflects a non-string request body.** The
  key is derived from the call arguments via `JSON.stringify`, under which a
  `Blob`/`FormData`/`ArrayBuffer`/`URLSearchParams`/stream body all serialize to
  `"{}"` — so two calls to the same URL with **different** such bodies could
  collide onto one cached entry (response-body cache confusion, the class behind
  Next.js CVE-2026-64648 / CVE-2026-64647). denext now buffers a non-string body
  to bytes before keying, so distinct bodies get distinct entries. String bodies
  were already keyed correctly.

### Added

- **More Next.js-parity probes** (`tests/nextjs-cve-parity.test.ts`, now 23):
  the July 2026 disclosures — rewrite/redirect SSRF via a request-built
  destination host (CVE-2026-64645; denext never proxies a rewrite, so it
  re-routes by pathname and cannot reach out), Server Action redirect SSRF
  (CVE-2026-64649; denext returns a client 3xx, never a server-side fetch), i18n
  middleware/proxy bypass (CVE-2026-64642; middleware runs on locale-prefixed
  paths), and the `cachedFetch` body-keying regression test above.

### Fixed

- **JSR module-doc score:** `src/runtime/compiler-runtime.ts` (the
  `denext/compiler-runtime` entrypoint) carried its module doc as a `//`
  comment, which JSR does not recognize as a module doc — dropping the package
  score to 94%. Converted it to a `/** … @module */` block so all entrypoints
  are documented again.

### Documentation

- **Two more security-responsibility callouts** (README): include the locale in
  a middleware `matcher` under i18n (a `/admin` matcher does not catch
  `/fr/admin`), and do not build a redirect/rewrite destination **host** from
  request input (open redirect; rewrites still can't SSRF in denext).

## [0.8.3] - 2026-08-09

Security-parity release. denext was tested against the adversary's exact moves
from Next.js's most serious and hardest-to-fix vulnerabilities; every class
bounced off, and the exercise surfaced one small parser bug (now fixed). No
breaking changes.

### Security

- **`safeFetch` response parser: strict `Content-Length` framing.** The
  hand-rolled HTTP/1.1 client (added in 0.8.2) parsed the `Content-Length`
  header with `Number()`, which coerces an empty/blank value to `0` (truncating
  the body to empty) and `"0x10"` to hex `16`. It now requires a plain
  non-negative integer, so a malformed or hostile origin can't cause a
  blank/mis-framed body. Found by the new parser-fuzzing tests.

### Added

- **Next.js-issue parity test suite** (`tests/nextjs-cve-parity.test.ts`): 13
  live exploit attempts mirrored from real Next.js CVEs — middleware auth bypass
  via `x-middleware-subrequest` (CVE-2025-29927), cache poisoning via a data/RSC
  variant and via non-200/empty responses (CVE-2024-46982 / CVE-2025-32421 /
  CVE-2025-49826), open-redirect + CRLF response splitting, static-file path
  traversal (CVE-2024-51479 class), image-optimizer SSRF + DNS rebinding,
  SVG-XSS via the image endpoint, and Server Action CSRF (CVE-2024-34351 class).
  Each fires the exact payload at denext's equivalent surface and asserts it is
  refused.
- **Response-parser hardening tests** (`tests/safe-fetch.test.ts`): fuzz
  coverage for `parseHttpResponse`/the chunked decoder — lying/blank
  Content-Length, request-smuggling framing (Transfer-Encoding precedence over
  Content-Length), oversized declared chunk sizes (no
  over-read/over-allocation), chunk extensions, non-hex chunk sizes, bare-LF and
  missing terminators, malformed status lines, and invalid header names.

### Changed

- **CI: split the heavy build/bundle tests into a parallel `integration` job and
  cache Deno dependencies.** The subprocess-spawning integration tests
  (example-app builds, scaffold type-checking, Flight/static-export bundling)
  moved to `tests/integration/` and now run as their own CI job alongside the
  fast unit suite, shortening the critical path; both jobs cache
  `~/.cache/deno`. New tasks: `deno task test:unit` / `test:integration`
  (`deno task test` still runs both). The test tasks also run with `--parallel`
  (~40% faster wall-clock locally and in CI; e2e stays sequential).

### Documentation

- **Security responsibilities** (README + `redirect()` JSDoc): the middleware
  `redirect()` helper emits its location verbatim (validate or normalize a
  user-controlled target with `safeRedirectLocation`; config-driven
  `redirects()` are already same-origin-normalized), and
  `absoluteUrl`/`requestOrigin` derive the origin from the spoofable `Host`
  header by default (set `canonicalOrigin` for a fixed origin).

## [0.8.2] - 2026-08-09

### Added

- **`safeFetch` — an SSRF-safe `fetch` for untrusted URLs** (exported from
  `denext/server`). Use it instead of `fetch()` whenever the destination is
  influenced by an end user (link previews, "import from URL", avatar-by-URL,
  webhooks). It resolves the host, **refuses any request whose resolved address
  is loopback/private/link-local**, and connects to the pinned IP with the
  original Host/SNI (closing DNS rebinding). Supports method/headers/body, an
  optional host allowlist (`*.domain` wildcards), per-hop-revalidated redirects,
  byte/time limits, and an `AbortController` `signal`; failures throw a typed
  `SafeFetchError`. (Do not use it to reach your own internal services — that's
  what `fetch`/`cachedFetch` are for.)

### Security

- **Image optimizer: DNS-rebinding protection (closes the residual SSRF gap from
  0.8.1).** Remote sources are no longer fetched by hostname and left to
  `fetch()`'s own DNS resolution. denext now resolves the host itself, **rejects
  the fetch if any resolved A/AAAA record is
  loopback/private/link-local/CGNAT/multicast**, and connects to that pinned IP
  while preserving the original `Host` header and TLS SNI (so certificate
  validation still holds and there is no second, rebindable resolution). An
  allowlisted hostname whose DNS points at an internal address (e.g. cloud
  metadata) is now refused. Implemented as a small SSRF-safe HTTP/1.1 GET client
  (`src/server/safe-fetch.ts`) with time and size bounds; the resolver and
  socket are injectable, so the path is fully unit-tested without network
  access.

## [0.8.1] - 2026-08-09

Security hardening from two independent reviews of 0.8.0. No breaking changes.

### Security

- **XSS via lowercase `on*` handler attributes.** The SSR attribute serializer
  only stripped React-style camelCase handlers (`onClick`), so lowercase
  HTML-native names (`onmouseover`, `onerror`, …) spread from untrusted props
  (`<div
  {...untrusted}>`) were emitted as live event-handler attributes. The
  handler filter is now case-insensitive, and `isValidAttrName` rejects any
  `on*` name — a single chokepoint covering all three SSR renderers **and** the
  client reconciler's `setAttribute`.
- **Image-optimizer SSRF via redirects.** The optimizer validated only the
  initial URL, then followed redirects automatically — an allowlisted host could
  redirect to cloud metadata (`169.254.169.254`), loopback, or a private
  service. Redirects are now followed manually with the full policy re-checked
  on **every** hop: allowlist, http(s) only, a redirect cap, and rejection of
  loopback/private/link-local/CGNAT/ multicast IP literals (v4 and v6, incl.
  IPv4-mapped). (DNS rebinding — an allowlisted host resolving to a private
  address — remains out of scope; keep the allowlist to trusted hosts.)

### Fixed

- **Image endpoint resource limits.** Remote fetches now have a timeout and a
  max download size (declared and streamed); decoded sources are rejected past a
  dimension/pixel cap before resizing (decompression-bomb guard).
- **Server Action request body limit.** Oversized bodies are rejected (413)
  before the handler runs — a declared-`Content-Length` fast path plus a hard
  cap on the buffered body (covers chunked requests). Configurable via
  `actionMaxBodyBytes` (default 10 MiB).
- **CSRF origin check is now scheme-aware.** An `http` Origin is rejected for a
  known- HTTPS app (determined via `canonicalOrigin`, a trusted
  `X-Forwarded-Proto`, or the request URL); full-origin `allowedOrigins` entries
  match scheme-strictly. Bare-host entries stay scheme-agnostic for
  compatibility, and proxied deployments where the scheme is unknown keep the
  prior host-only behavior (no regression).
- **Static serving blocks symlink escapes.** A symlink inside `public/` that
  resolves outside it (via `Deno.realPath`) is no longer served; symlinks that
  stay within `public/` still work.

## [0.8.0] - 2026-08-09

Developer-experience and scaling release: a project scaffolder, first-class
Tailwind, an optional `src/` layout, configurable remote-image optimization, the
deferred operational features from 0.7.1, a memoization foundation, and an
experimental React-Compiler-style auto-memo pass. No breaking changes.

### Added

- **`denext create` / `denext init` scaffolder.** `create <dir>` generates a
  clean starter into a new/empty directory; `init` scaffolds into the current
  (possibly non-empty) directory without ever overwriting existing files. Both
  prompt interactively (or take `--tailwind`, `--src-dir`, `--compiler`,
  `--yes`) and wire up `deno.json`, an `app/` with a hydrating example page, and
  `.gitignore`.
- **Tailwind CSS, driven by denext.** Set `tailwind: { input, output }` in
  `denext.config.ts` and denext downloads and manages the Tailwind v4
  _standalone_ binary (zero npm — a build-time tool like the lightningcss wasm)
  and compiles your stylesheet automatically on `dev`/`build`. Override the
  binary with `TAILWIND_BIN` or the version with `DENEXT_TAILWIND_VERSION`.
- **Optional `src/` directory layout** (Next.js parity). When `src/app` exists,
  the app, middleware, and instrumentation live under `src/`; `public/`, config,
  and `.denext` stay at the project root.
- **Configurable remote image optimization.**
  `images: { domains, remotePatterns }` in `denext.config.ts` allowlists remote
  sources for the `/_denext/image` endpoint (exact hosts, or
  protocol/host-wildcard/pathname patterns). Remote sources remain refused by
  default (local-only, SSRF-safe).
- **Operational hooks (deferred from 0.7.1).** `onRequest(info)` for per-request
  logging/metrics (plus a `DENEXT_LOG=1` default logger), a per-request
  `requestTimeout` (→ 503), and cache single-flight (stampede protection) for
  both the data cache and the ISR page cache — coordinating waiters only, never
  sharing a live per-user render.
- **Memoization foundation.** The client reconciler now bails out of
  re-rendering a component whose props are shallow-equal and whose visible
  context is unchanged (context changes still reach deep consumers correctly).
  New `memo(Component,
  areEqual?)` HOC and `useMemoCache` primitive, plus a
  `denext/compiler-runtime` entrypoint.
- **Experimental auto-memo compiler** (`experimental: { compiler: true }`,
  default off). A build-time pass that lifts JSX component elements into
  `useMemoCache`-guarded memo calls so unchanged subtrees keep a stable
  reference and skip re-render. It runs only on the client bundle (server output
  is unchanged), is conservative (bails to identity on anything it cannot
  analyze), and is proven equivalent + effective by tests. Enable with
  `denext create --compiler`.

### Changed

- The `denext/rules-of-hooks` lint rule now also flags a hook called after a
  conditional early return (it may be skipped on some renders).

## [0.7.1] - 2026-08-09

Production-readiness fixes from a three-lens (correctness / operations /
security) review of 0.7.0. Two of the defects were in 0.7.0's own new features.

### BREAKING

- **`request` removed from `PageProps`.** The raw `Request` is no longer passed
  to page components, `metadata`/`generateMetadata`, or `generateViewport`.
  Reading per-request data off it bypassed the cache-safety tripwire, so a
  personalized render could be cached under a shared key and served to other
  users. **Migration:** read per-request data through `cookies()` / `headers()`
  from `denext/server` (both mark the render dynamic, so it is correctly
  excluded from the cache). `params` and `searchParams` are unchanged (they are
  part of the cache key and safe to read).

### Security

- **Cross-user cache disclosure** via the `request` prop — closed by the
  breaking change above (affected the in-memory page cache too; the shared KV
  cache made it cross-replica).
- **Host-header `og:image` cache poisoning.** When `og:image` is auto-populated
  from a dynamic `opengraph-image` route and no `canonicalOrigin` is configured,
  the URL is derived from the request `Host`; the render is now marked dynamic
  so a poisoned value can't be cached and served to everyone. Set
  `canonicalOrigin` to re-enable caching for such pages.

### Fixed

- **Cache is now fail-safe.** A `CacheStore` error (KV outage, a page body over
  Deno KV's 64 KiB value cap, a non-cloneable value) no longer 500s the request:
  reads degrade to a live render and writes are skipped, both logged
  (throttled). Applies to `unstable_cache`/`cachedFetch` and the ISR page cache.
- **Dev hydration-mismatch false positives.** The 0.7.0 diagnostic warned on
  nearly every page (`Count: {n}`): SSR coalesces adjacent text into one node
  while the client splits it. The reconciler now splits and adopts the coalesced
  node cleanly — no warning — while still reporting genuine divergences. A
  boundary that re-suspends during hydration no longer warns either (its
  fallback mounts fresh).
- **`after()` no longer blocks the response.** Deferred callbacks (and deferred
  cache invalidations) drain after the response is produced, not before it.
- **Un-awaited `revalidateTag`/`revalidatePath` under an async store.** Inside a
  request, the invalidation is registered on the request's deferred queue so it
  drains before the isolate can be reclaimed; awaiting is documented as required
  for a fully-consistent result with an async store.
- **`deno bundle` probe no longer caches a transient failure**, which had
  permanently bricked a long-lived dev server after one spawn hiccup.
- **Bundler resolves root-relative (`/`) import-map paths** to absolute in the
  merged config (previously only `./`/`../`).
- **KV index markers stay bounded**: overwriting an entry drops the markers it
  no longer carries, so re-tagging a non-TTL entry can't leak index keys.
- **Prod server validates the build at startup** — a missing client entry now
  fails fast instead of a page that SSRs but silently never hydrates.
- **Dev file-watcher and live-reload streams close on shutdown**; concurrent
  first-hits for the same route are coalesced so duplicate `deno bundle`
  subprocesses aren't spawned.

### Added

- **`/_denext/health` reports cache reachability** (`{ status, cache }`) — still
  200 for liveness (the site serves even during a cache outage), with
  `cache: "degraded"` surfacing a backend problem to operators. New
  `cacheStoreHealthy()` export.

### Deferred to 0.8

Three net-new operational features from the review are intentionally not in this
patch: opt-in structured request logging/metrics, a per-request
timeout/deadline, and cache-miss single-flight (stampede protection).

## [0.7.0] - 2026-08-08

A production-maturity release that closes the architectural gaps left open after
0.6.1: shared multi-replica caching, a real-browser test suite, hydration
diagnostics, and hardening of the experimental `deno bundle` dependency.

### Added

- **Pluggable shared cache (`CacheStore`) + Deno KV adapter.** The data cache
  and ISR page cache now sit behind a `CacheStore` interface (mirroring
  `setDraftTokenStore`). `setCacheStore(store)` swaps the backend for all
  subsequent operations; the default stays in-memory. A built-in
  `denoKvCacheStore()` backs both caches with Deno KV, so a render or cached
  data entry produced on one replica is served by another and `revalidateTag` /
  `revalidatePath` reach every instance. New exports from `denext/server`:
  `setCacheStore`, `inMemoryCacheStore`, `denoKvCacheStore`, and the
  `CacheStore` / `DataEntry` types.
- **Real-browser E2E suite.** `deno task test:e2e` builds and serves
  `examples/hello` and drives it with a headless Chromium (via `@astral/astral`,
  a test-only dependency — never in the runtime graph, excluded from publish).
  It verifies the SSR→hydration round-trip the in-memory DOM tests cannot: the
  pre-hydration flag flips, the counter is interactive, a
  `dynamic({ ssr: false })` island is code-split and mounted client-side,
  `<Link>` navigation is a true SPA swap, and no console errors occur. Excluded
  from `deno task test`/`check`.
- **Dev-only hydration-mismatch warnings.** The client reconciler now warns (dev
  server only) when server and client markup disagree — a mismatched tag, a
  swapped node, or divergent text — instead of silently patching it. Gated on
  the live hydration cursor, so intentional divergences
  (`dynamic({ ssr: false })`, resolved Suspense, error fallbacks) never trigger
  false positives. Zero cost and fully silent in production.
- **`deno bundle` version guard + build smoke test.** `build`/`dev` now verify
  the resolved `deno` is new enough for the (experimental) `bundle` subcommand
  and fail with an actionable message (`DENO_BIN` hint) on a missing/old binary,
  instead of a cryptic bundle error. A full-build smoke test asserts the on-disk
  artifact shape (client entry + code-split chunks) as a tripwire against
  `deno bundle` output drift.

### Fixed

- **Page-cache tag invalidation.** ISR page-cache entries now inherit the tags
  of the cached data (`unstable_cache`/`cachedFetch`) read during their render,
  so `revalidateTag(tag)` purges the page and not just the underlying data.
  Page-cache writes previously stored no tags, making tag-based page
  invalidation a no-op.
- **Bundling from a project with relative import-map paths.** The bundler now
  resolves a base config's relative `imports` (e.g. `denext` → `../../mod.ts`)
  to absolute when writing its merged config to a temp dir, fixing
  `Module not found` failures when a route imported CSS (the merged-config
  path).

### Changed

- The ISR page cache is now async end to end (`PageCache.get`/`set` return
  promises) so it can be backed by a remote store;
  `revalidateTag`/`revalidatePath` now return a `Promise` you may await (the
  in-memory default still applies synchronously, so existing non-awaited calls
  keep working).

## [0.6.1] - 2026-08-08

A hardening release: a security fix plus the concrete production-readiness
blockers found in a post-0.6.0 review. No API changes.

### Security

- **Open redirect (protocol-relative `Location`).** `trailingSlash`
  normalization and path-preserving config `redirects()` (a `:path*` capture
  reflected into the destination) built a `Location` from request-path data
  without neutralizing protocol-relative (`//host`) or backslash (`/\host`)
  prefixes, which browsers resolve cross-origin. New `safeRedirectLocation()`
  preserves explicit `http(s)://` external redirects but forces everything else
  to a single-slash same-origin path; applied to all redirect sites. Regression
  tests added.

### Fixed

- **Graceful shutdown.** The CLI now traps `SIGINT`/`SIGTERM` (`SIGBREAK` on
  Windows) and aborts an `AbortController` wired into `Deno.serve`, so in-flight
  requests drain on deploy / pod termination instead of being dropped. The CSS
  re-exec forwards the signal to its child process.
- **Unbounded caches (memory-exhaustion).** The ISR `PageCache` and the
  `unstable_cache` / `cachedFetch` data store are now bounded LRUs, so
  high-cardinality keys (e.g. many distinct query strings) can no longer grow
  them without limit.
- **Image endpoint re-encoding.** `/_denext/image` now serves from a
  byte-bounded (64 MB) LRU of encoded webp output keyed on `src`+width, instead
  of decoding/resizing/re-encoding on every request.
- **Silent config failure.** A malformed `denext.config.ts` now fails fast with
  a clear error instead of silently dropping `basePath`/redirects/**security
  headers**.
- **Compiled-binary CSS.** A `deno compile`d binary now warns loudly that it
  cannot apply the CSS import map (`import "./x.css"` would fail), instead of
  failing silently at runtime.

### Added

- **`/_denext/health`** — a liveness/readiness probe endpoint for load balancers
  and Kubernetes.

### Notes

- Known limitations unchanged from 0.6.0 (see below), plus: ISR/data caches and
  `revalidatePath`/`revalidateTag` remain process-local — multi-replica
  deployments should front denext with a CDN and treat per-instance cache
  windows accordingly (a shared-store seam is planned).

## [0.6.0] - 2026-08-08

The "real CSS pipeline + Next.js parity" release: a genuine CSS Modules / global
CSS build (full `lightningcss` semantics) on a bundler-less Deno server, true
code-split `next/dynamic`, `next.config`-style redirects/rewrites/headers, a
complete Metadata + `generateViewport` API, and a batch of utility helpers.

### Added

- **Real CSS pipeline (CSS Modules + global CSS + Tailwind).**
  `import s from
  "./x.module.css"` yields scoped, hashed class names with
  `composes` and `:global` resolved; `import "./globals.css"` is extracted and
  linked. Powered by **`lightningcss` (wasm)** — the engine Parcel/Turbopack
  use. Because Deno cannot `import()` a `.css` module (and offers no runtime
  loader hook), the CLI generates a merged deno config that redirects each
  `.css` to a JS shim (the class map for modules, an empty module for globals)
  and **re-execs the module loader with `--config`**; the same import map feeds
  `deno bundle` for the browser. Extracted, transformed CSS is emitted per route
  and linked in `<head>`. Tailwind works through the global-import path (run the
  Tailwind CLI → import the output). Zero overhead for CSS-free projects.
- **`next/dynamic` — true code-splitting.**
  `dynamic(() => import("./Heavy"), {
  ssr, loading })` loads a component on
  demand as its **own bundle chunk** (via `deno bundle --code-splitting`, which
  hoists shared modules — context symbols, registries — into a common chunk so
  module identity is preserved). `ssr: false` renders the fallback on the server
  and mounts on the client; loading rides the existing Suspense machinery.
- **`denext.config` redirects / rewrites / headers + basePath / trailingSlash /
  assetPrefix.** Declarative `redirects()` (307/308 with `:param` substitution),
  `rewrites()` (internal re-route), and `headers()` (per-path response headers),
  evaluated once at startup; `trailingSlash` normalization (308); `basePath`
  (routing, asset serving, **and** client
  `<Link>`/`navigate()`/`usePathname()`); `assetPrefix` for CDN asset URLs.
- **Complete Metadata API + `generateViewport`.** `Metadata` now covers
  `twitter` cards, structured `alternates` (canonical + `hreflang`),
  `metadataBase` (resolves relative og/twitter images), structured `icons`
  (icon/shortcut/apple), `robots` as an object, `authors`, `verification`, and
  multi-image `openGraph.image` with width/height/alt. New `viewport` /
  `generateViewport` exports drive the viewport, `theme-color`, and
  `color-scheme` tags.
- **File-based metadata icons.** `app/icon.*`, `app/apple-icon.*`, and
  `app/twitter-image.*` (static images or dynamic `.tsx` modules) are
  auto-served at `/icon`, `/apple-icon`, `/twitter-image` and auto-injected as
  `<link rel="icon">` / `apple-touch-icon` / `twitter:image` — zero-config.
- **`next/og` `ImageResponse`** — render JSX to a PNG (satori flexbox layout →
  SVG → resvg raster, via `@cf-wasm/og`, which bundles a font and inlines its
  wasm). Returns a `Response` that flows through the `opengraph-image`
  convention.
- **Self-hosted image optimization** — a built-in `/_denext/image` endpoint
  (decode → resize → webp, via `@cf-wasm/photon`) for local `public/` assets;
  remote sources require an explicit host allowlist (SSRF-safe). `<Image>` gains
  a `loader` prop (`denextImageLoader` targets the endpoint), a generated
  responsive `srcSet` from a widths list, and `placeholder="blur"` +
  `blurDataURL`.
- **`next/font/google`** — `googleFont({ family, weights, styles })` fetches the
  Google Fonts CSS2 stylesheet and returns the same `FontResult`/`FontFace`
  shape as `localFont`.
- **`after()`** — schedule work to run after the response (drained on every exit
  path; throws are logged, not propagated).
- **`userAgent(request)`** — a stdlib UA parser (browser / OS / device / engine
  / bot detection).

### Deferred

- Image optimization covers local `public/` assets by default; remote sources
  need an explicit host allowlist.

### Notes

- New build/server-time dependencies (never enter the client bundle):
  `lightningcss-wasm` (CSS), `@cf-wasm/og` (ImageResponse), `@cf-wasm/photon`
  (image optimization).
- Dev limitation: adding a **new** `.css` file needs a dev restart (editing
  existing ones hot-reloads), because the server CSS import map is fixed at
  boot.

## [0.5.0] - 2026-08-08

The React Server Components release: a real `"use client"`/`"use server"`
boundary built bundler-lessly on Deno, plus the App Router features that were
previously shipped scoped-down. Server Actions folded into `"use server"` are
built with the same defensive posture as 0.4.0 (Next.js's worst CVEs were here).

### Added

- **Flight / RSC boundary (`"use client"` / `"use server"`)** — a true Server
  Components boundary with no third-party bundler. The server still SSRs client
  modules for first paint but emits them as **references** in a **Flight**
  payload (`#__denext_flight` island); only client modules ship to the browser.
  Directives are parsed by a real tokenizer (not a regex), the app-wide
  client/server split is discovered by crawling Deno's own module graph
  (`deno info`), and client islands are tagged as references via ESM singletons.
  `"use server"` exports auto-register and are stripped from the browser bundle
  by redirecting each server module to a generated client stub through a
  `deno bundle` import map — proven by byte-grep tests that server-component and
  server-action code are **provably absent** from the client bundle. `useId` is
  re-based per island so hydration ids stay aligned; streaming Flight
  interleaves boundary rows. Undirected modules stay **isomorphic** (opt-in,
  fully backward compatible). `serverAction("id", fn)` still works. The default
  remains the whole-tree isomorphic hydration for routes with no boundary.
- **Parallel routes done right** — `@slot` folders become full routable subtrees
  (their own segments, dynamic params, `layout`/`loading`/`error`), matched
  against the current URL with a new **`default.tsx`** convention, and
  **layout-scoped** so a slot spans every route under its layout (the canonical
  `@modal/(.)photo/[id]` intercept-in-slot modal works on soft nav).
- **Layout-relative `useSelectedLayoutSegment(s)`** — each layout now sees only
  the path segments **below its own level** (route groups add no depth), via a
  segment-depth provider wrapped around each layout on both server and client.
- **Dynamic OG images** — an `opengraph-image.{tsx,ts,jsx,js}` convention served
  at `/opengraph-image`. The default export may return an **SVG VNode**
  (serialized to `image/svg+xml`, no rasterizer dependency), a **`Uint8Array`**
  (served `image/png` — bring-your-own rasterizer), or a **`Response`**
  (verbatim). `og:image` auto-populates to its absolute URL when a page sets
  none.
- **`useTranslations()`** — a real message-catalog hook. `I18nConfig.messages`
  maps locale → catalog; the active catalog is provided to SSR and embedded in
  the hydration payload, so `t("greeting", { name })` interpolates `{var}`
  placeholders server-side and on the client (re-read on soft navigation).
  Correct under the Flight boundary too.
- **`instrumentation.ts`** — a project-root module exporting `register()` (run
  once at server boot, for tracing/metrics/error-reporting setup) and/or
  `onRequestError(error, request, context)` (called for each server-side request
  error, e.g. to forward to Sentry). Wired into the dev and production servers;
  both hooks are optional, may be async, and are invoked defensively so a
  failing hook never takes the server down. Errors are reported exactly once.
- **`.env` file support with client/server isolation** — `loadEnv` reads `.env`
  then `.env.local` (later wins; real shell vars win unless `override`) into
  `Deno.env`, wired into `dev`/`build`/`export`/`start`. Only variables prefixed
  **`NEXT_PUBLIC_`** (Next.js-compatible) or **`DENEXT_PUBLIC_`** are exposed to
  the browser — embedded in a `#__denext_public_env` island and read by the
  isomorphic `publicEnv()`; server-only variables never reach the client through
  this channel. Also `parseEnv`, `isPublicEnvKey`, `filterPublicEnv`.
- **Hardening & loose ends** — a **pluggable draft-token store**
  (`setDraftTokenStore` / `DraftTokenStore`) for multi-instance deployments
  (default in-memory; server-minted-token security preserved); **`<html lang>`**
  now reflects the active locale; and an **absolute-URL helper**
  (`requestOrigin` / `absoluteUrl`).

### Security

- **Directive scan can't be hidden by a banner** — `readDirective` now grows its
  read window until the module's directive prologue is conclusively resolved,
  instead of reading a fixed 1 KB head. A license banner longer than the window
  could previously hide a `"use server"` directive, failing open and leaking the
  server module into the client bundle.
- **`X-Forwarded-*` untrusted by default** — `requestOrigin`/`absoluteUrl` (used
  to auto-populate `og:image`) now ignore `X-Forwarded-Proto`/`-Host` unless a
  deployment opts in via `trustForwardedHeaders` (trusted reverse proxy) or pins
  the origin with `canonicalOrigin`, closing a header-spoofing vector.

## [0.4.0] - 2026-08-07

Server-first features: mutations, caching, and SEO — with Server Actions built
defensively (Next.js's worst CVEs were here).

### Added

- **Route segment config** — page/layout modules may `export const dynamic`,
  `revalidate`, `dynamicParams`, `runtime`, etc. The effective config is merged
  down the layout chain (shortest `revalidate` wins) and drives static/dynamic
  rendering; the static export skips `dynamic: "force-dynamic"` routes.
- **Data cache & Incremental Static Regeneration** — `cache()` (per-request
  memoization), `unstable_cache` + `cachedFetch` (cross-request TTL + tags), and
  `revalidatePath`/`revalidateTag`. The production server serves a rendered
  **page cache** for routes that opt in via `revalidate`/`force-static`; the
  default (`dynamic: "auto"`, `revalidate: false`) is **never cached**, so pages
  reading `cookies()`/`headers()` stay per-request.
- **Server Actions** — `serverAction(id, handler)` registers a server function
  dispatched over `POST /_denext/action/<id>`, usable as a `<form action>` (with
  no-JS **progressive enhancement**) or via `useActionState`. **Security:**
  every action request is enforced **same-origin** (Origin, then Referer, deny
  when absent) as a CSRF defense; POST-only; only registered ids resolve;
  handler errors are logged server-side but returned to the client as a generic
  message; redirects are forced to 303 and the no-JS redirect target is
  restricted to a same-origin path. Plus `serverOnly()`/`clientOnly()` boundary
  guards.
- **Metadata files** — `app/sitemap.ts` → `/sitemap.xml`, `app/robots.ts` →
  `/robots.txt`, `app/manifest.ts` → `/manifest.webmanifest`, and
  `app/favicon.ico`.
- **Document metadata hoisting** — render `<title>`/`<meta>`/`<link>` anywhere
  in the tree (React 19); they are hoisted into `<head>` during SSR (in-tree
  `<title>` wins over the `metadata` export).
- **Asset & navigation ergonomics** — `<Image>`
  (lazy/async/`priority`/`srcSet`), `<Script>` strategies, `localFont` +
  `<FontFace>` (`@font-face`), `useParams()`, `<Link prefetch>` (hover +
  viewport prefetch with a client HTML cache), and `draftMode()` (httpOnly
  preview cookie).

## [0.3.0] - 2026-08-07

Four "owns-both-halves" wins — things possible because denext owns the
reconciler, the router, the middleware runner, **and** the linter together.

### Added

- **Composable, ordered middleware** — `middleware.ts` / `proxy.ts` may now
  export an **ordered array** of handlers (or `{ handler, config }` entries)
  instead of a single function. They run in order: a `Response` short-circuits
  the chain, a `rewrite()` threads its URL into every later entry, and
  `next({ headers })` accumulates headers across the chain. Per-entry
  `config.matcher` gates individual entries. New `composeMiddleware()`;
  single-function exports keep working unchanged. 7 tests.
- **i18n routing (optional default-locale prefix)** — `/about` serves the
  default locale, `/fr/about` serves `fr`; the locale is peeled at request time
  (the router core is untouched) and merged into route `params`, so pages,
  layouts, templates, and client hydration all see `params.locale`. New
  `useLocale()` client hook, `peelLocale`, `detectLocale`/`parseAcceptLanguage`,
  and a ready-made `localeMiddleware` (cookie + `Accept-Language` negotiation)
  that composes into the chain above. Config comes from a `serve({ i18n })`
  option or a `denext.config.{ts,js}` export; static export emits one variant
  per locale. 10 tests.
- **Convention registry + parallel & intercepting routes** —
  - The scanner's hardcoded file-convention regexes are now a **table-driven
    registry** with a `registerConvention()` seam and a post-scan
    `registerRouteSynthesizer()` hook (extension points for derived routes). A
    golden-manifest test locks scanner output so the refactor is provably
    behavior-preserving.
  - **Parallel routes** — `@slot` folders are collected and rendered into the
    nearest layout as **named props** (server and client), without creating
    standalone routes.
  - **Intercepting routes** — `(.)`, `(..)`, `(..)(..)`, and `(...)` folders are
    parsed (fixing a bug where `(..)` was mis-stripped as a route group) and
    match **only on soft navigation** (via the existing `x-denext-nav` header);
    a hard load falls through to the real route. 8 tests.
- **Error-boundary superpowers** — beyond what React can do:
  - `useErrorBoundary()` returns `{ reset, captureError }` — `captureError(e)`
    routes an error (including async/`setTimeout` failures) to the nearest
    boundary's fallback; `reset()` retries its children.
  - Errors thrown in **event handlers and form actions** are caught and routed
    to the nearest boundary (React silently drops these). A rejected async
    handler/action is routed too.

  6 tests.

### Fixed

- **Client error boundaries no longer swallow control signals.** `redirect()`,
  `notFound()`, `forbidden()`, and `unauthorized()` thrown during client render
  now bubble past `<ErrorBoundary>` (matching the server renderer) instead of
  rendering the error fallback. A `redirect()` from an event handler performs a
  client navigation rather than showing a fallback.

## [0.2.0] - 2026-08-07

### Added

- **React 19 hook parity** — `useId` (deterministic across server render and
  client hydration), `useSyncExternalStore`, `useLayoutEffect`,
  `useDeferredValue`, `useTransition`/`startTransition`, and
  `useImperativeHandle` (with React 19 **ref-as-prop** — components receive
  `ref` in props, no `forwardRef`). Context objects are now usable **directly as
  a provider element** (`<MyContext value={v}>`, React 19 style) in addition to
  `<MyContext.Provider>`. (`useTransition`/`useDeferredValue` are simplified,
  non-interruptible approximations in this synchronous renderer.) 11 tests.
- **Router completeness** — new App Router special files and helpers:
  - `template.tsx` (wraps like a layout, conceptually re-mounted),
    `global-error.tsx` (replaces the whole tree on an uncaught render error →
    500).
  - `forbidden()` / `unauthorized()` control signals (like `notFound()`) that
    render `forbidden.tsx` / `unauthorized.tsx` (nearest up the tree) with a
    real `403` / `401`; they bubble past error boundaries.
  - `useSelectedLayoutSegment()` / `useSelectedLayoutSegments()` (reactive;
    simplified, not layout-relative). The manifest scanner and client entry were
    extended to cover the new files. 7 tests.
- **Server ergonomics** — `redirect()`/`permanentRedirect()` control signals
  (throw from a server component → `307`/`308`), and a per-request async context
  (Deno `AsyncLocalStorage`) powering `cookies()` and `headers()` from
  `denext/server` (read request cookies/headers; `cookies().set()`/`delete()`
  queue `Set-Cookie` on the response). Added the client `useOptimistic` hook. 6
  tests.
- **Form actions** — the React 19 `useActionState` and `useFormStatus` hooks,
  plus `<form action={fn}>` interception (submit calls the action with the
  form's `FormData`). Actions run on the client (typically calling a route
  handler); denext does **not** implement Next.js's bundler-transformed
  `"use server"` RPC. 4 tests.
- **Static generation & SEO** — `denext export` pre-renders the whole app to a
  static, host-anywhere directory (`out/`): every page plus dynamic routes
  enumerated by `generateStaticParams`, with client bundles and `public/` assets
  copied in (still hydratable). Added `generateMetadata` (async) support and an
  expanded `Metadata` type (`keywords`, `robots`, `canonical`, `openGraph`,
  `icon`) rendered into `<head>`. 4 tests.

## [0.1.2] - 2026-08-07

### Fixed

- **JSR module-doc detection** — `jsx-runtime.ts`'s top JSDoc lacked an
  `@module` tag, so deno doc attached it to the first export instead of treating
  it as a module doc, failing JSR's "module docs in all entrypoints" check
  (`./jsx-runtime` and `./jsx-dev-runtime` both map to this file). Added the
  tag; all entrypoints now expose a recognized module doc.

## [0.1.1] - 2026-08-07

### Security

- **Fixed an XSS via unsafe attribute names in SSR and hydration.** An attribute
  name containing tag/attribute-delimiter characters — reachable when a
  component spreads untrusted keys, e.g. `<div {...untrusted}>` — could break
  out of the tag and inject markup. `serializeAttributes` (server) and the
  client reconciler now drop names failing `isValidAttrName` (rejects
  whitespace, quotes, `< > / =`, and control characters;
  `data-*`/`aria-*`/`xml:lang` stay valid). Attribute _values_ were already
  escaped; this closes the name vector. Added 5 security regression tests.

### Added

- **Full API documentation** — JSDoc on every exported symbol across all public
  entrypoints and module docs on each entrypoint (`deno doc --lint` is clean),
  taking JSR documentation coverage to 100%.
- **CI & release automation** — a GitHub Actions `CI` workflow (fmt / lint /
  type-check / tests / `deno doc --lint`) and a `Publish to JSR` workflow that
  runs on `v*` tags with `id-token: write`, so releases carry **build
  provenance**.

## [0.1.0] - 2026-08-07

### Added

- **`denext` executable + packaging**:
  - `deno task compile` produces a standalone `denext` binary via
    `deno compile`. Fixed the compiled case where bundling shelled out to the
    wrong executable — `denoExecutable()` now resolves the real `deno` (via
    `DENO_BIN`, `~/.deno/bin/deno`, or `PATH`) instead of `Deno.execPath()`
    (which is `denext` in a compiled binary). `start` runs fully standalone;
    `dev`/`build` still need a `deno` for client bundling.
  - Exposed `./cli` and `./lint-plugin` exports, so
    `deno install`/`deno run jsr:@denext/denext/cli` and the lint plugin work
    from the published package.
  - Added a `publish.exclude` (tests, examples, build output, binary) —
    `deno publish --dry-run` passes with no slow-type errors, so the package is
    JSR-ready.
  - README: "The `denext` command" (install/compile/task) and "Using denext as a
    package" sections.
- **Port handling** (`src/server/serve-utils.ts`): when no `--port` is given,
  `dev`/`start` now auto-select an open port (trying 3000, 3001, … up to 10),
  logging each fallback, instead of crashing with `AddrInUse`. When `--port`
  **is** given, that exact port is required — an in-use port fails immediately
  with a clean, single-line error (exit 1). 4 tests.
- **Tooling config & clean baseline**: explicit, customizable `deno fmt`
  settings
  (`useTabs`/`lineWidth`/`indentWidth`/`semiColons`/`singleQuote`/`proseWrap`/`exclude`)
  and lint config in `deno.json`, plus `fmt`/`lint`/`check` tasks. The whole
  repo is now `deno fmt` clean and `deno lint` clean (including the denext hook
  rules).
- **Deno-native lint plugin** (`src/lint/denext-plugin.ts`): React/denext hook
  rules enforced by `deno lint` (no ESLint/npm) — `denext/rules-of-hooks` (no
  conditional hooks), `denext/hooks-in-component` (hooks only in
  components/`useX` hooks, not callbacks), and `denext/no-hooks-in-async` (hooks
  in async server components have no client effect). Wired into both `deno.json`
  files; 8 tests via `Deno.lint.runPlugin`.
- **Root not-found rendering**: unmatched page requests render the app's root
  `not-found.tsx` (within the root layout) with a `404` status, instead of a
  generic message. The manifest now tracks `rootNotFound`.
- **README + LICENSE**: full documentation (quick start, routing conventions,
  API surface, middleware, linting, architecture, limitations) and an MIT
  license. The example app (`examples/hello`) gained its own `deno.json` so it
  runs as a realistic standalone project.
- **Client-side navigation** (`src/client/navigation.ts`): SPA soft navigation
  without full reloads.
  - `<Link href>` renders a normal SSR anchor and navigates on the client;
    global click delegation also intercepts plain internal `<a>` links.
  - `navigate()` fetches the target page's server HTML, swaps the hydration
    root, updates `<title>` + history (push/replace/`popstate`), and re-runs the
    route bundle to hydrate; falls back to a full load on cross-origin or
    failure.
  - Router hooks: `useRouter()` (`push`/`replace`/`back`/`forward`/`refresh`),
    reactive `usePathname()` and `useSearchParams()`.
  - Route bundles now boot via `startClient()` (hydrate + install navigation).
- **App Router special files** (`loading.tsx`, `error.tsx`, `not-found.tsx`) and
  the primitives behind them (`src/runtime/error-boundary.ts`):
  - `<ErrorBoundary fallback>` renders a fallback (given `error` + `reset`) when
    a descendant throws during render — server (string + streaming) and client,
    with a working `reset()`.
  - `notFound()` throws a sentinel that bubbles past error boundaries to render
    the not-found UI with a real `404` status.
  - The manifest scanner captures the nearest `loading`/`error`/`not-found` per
    page (inherited down the tree); the render pipeline wraps each page in its
    error boundary and a `<Suspense>` whose fallback is `loading.tsx`; the
    client entry mirrors the same wrapping for hydration.
- **Root middleware** (`src/server/middleware.ts`): a `middleware.ts` (or
  `proxy.ts` alias) at the project root runs before routing. Handlers return a
  `Response` (short-circuit), `redirect()`, `rewrite()` (internal re-route), or
  `next()` (continue, optionally injecting response headers). Supports a
  `config.matcher` (`:name`, `:name*`, `*` patterns). Loaded by dev
  (hot-reloaded) and prod servers; exported from `denext/server`.
- **Suspense + streaming SSR** (`src/runtime/suspense.ts`,
  `src/jsx/render-to-stream.ts`): a `<Suspense fallback>` boundary, a `use()`
  primitive that unwraps promises by suspending, and `createResource()`.
  - `renderToReadableStream()` flushes the shell with each boundary's fallback,
    then streams each boundary's real content as it resolves plus an inline swap
    script — supporting multiple concurrent and nested boundaries.
  - `renderToString()` transparently resolves Suspense (no streaming).
  - Client reconciler supports Suspense: shows the fallback while a descendant
    suspends and swaps in real content when the promise settles.
- **Project scaffolding**: `deno.json` with a self-contained JSX toolchain
  (`jsxImportSource: "denext"`), standard-library-only import map, and
  dev/start/ build/test tasks. No runtime npm dependencies.
- **JSX runtime** (`src/jsx/`): a self-contained mini virtual DOM. `jsx`/`jsxs`/
  `jsxDEV`/`Fragment` for the automatic runtime, plus a classic `h()` helper. No
  React dependency.
- **Server-side rendering** (`src/jsx/render-to-string.ts`): `renderToString`
  supporting function components (sync and async), fragments, context providers,
  correct HTML escaping, void elements, boolean attributes, style-object
  serialization, and `dangerouslySetInnerHTML`.
- **Hooks** (`src/runtime/hooks.ts`): swappable-dispatcher `useState`,
  `useReducer`, `useEffect`, `useMemo`, `useCallback`, `useRef`, `useContext`,
  shared between server and (upcoming) client runtimes.
- **Context** (`src/runtime/context.ts`): `createContext` with provider/consumer
  resolution during rendering.
- **File-based router** (`src/router/`): Next.js App Router-style conventions —
  `page`, `layout`, `route` files; static, dynamic (`[slug]`), catch-all
  (`[...rest]`), and optional catch-all (`[[...rest]]`) segments; route groups
  (`(group)`); specificity-ordered matching; filesystem manifest scanner.
- **HTTP server** (`src/server/`): request handler dispatching to API routes,
  server-rendered pages, static assets, or a 404. Includes:
  - Page render pipeline composing the layout chain around a page and merging
    layout + page `metadata` (title/description/meta/head).
  - Full HTML document assembly with `<head>` metadata and a hydration bootstrap
    (serialized route data + client module script).
  - API dispatch by HTTP method (`GET`/`POST`/… exports) with automatic `HEAD`
    from `GET` and `405` + `Allow` for unsupported methods.
  - Static file serving from `public/` with path-traversal protection and
    content-type detection.
  - `serve()` helper over `Deno.serve`, and an injectable module loader.
- **Client runtime** (`src/client/`): a small virtual-DOM reconciler with real
  hooks and in-place DOM patching. Includes:
  - `createRoot` (fresh mount) and `hydrateRoot` (adopts server markup in place,
    binding events without recreating nodes; self-heals on mismatch).
  - Full hooks on the client (`useState`/`useReducer`/`useEffect` with
    dependency tracking + cleanup, `useMemo`/`useRef`/`useContext`).
  - Keyed children reconciliation that preserves element identity across
    reorders; microtask-batched updates with a `flushSync` escape hatch.
  - Context provider/consumer resolution through the live instance tree.
  - `bootstrap.ts` browser entry that rebuilds the server's tree from the
    embedded hydration payload and hydrates `#__denext`.
  - Injectable `document` (`setDocument`) so the reconciler stays DOM-agnostic
    and testable without a third-party DOM.
- **Toolchain & CLI** (`src/build/`, `cli.ts`): dev/build/start commands driven
  by Deno's own toolchain — **no third-party bundler**.
  - Browser bundling via `deno bundle`: one entry per route (page + layouts +
    client runtime as a single module graph, preserving context identity).
  - `denext dev`: SSR + on-demand per-route bundling + live reload over SSE,
    with a filesystem watcher and generation-based module/bundle cache busting.
  - `denext build`: pre-bundles + minifies each route to `.denext/client/` and
    writes a build manifest.
  - `denext start`: serves SSR pages plus the pre-built, immutably-cached client
    bundles.
- **Example app** (`examples/hello/`): App Router demo — root layout, an
  interactive home page (`useState`/`useEffect` hydration), a static about page,
  a dynamic async blog route (`/blog/[slug]`), an API route, and CSS. Verified
  end-to-end: SSR, hydration payload, API GET/POST, static serving, dynamic
  params, and the production build/start path.
- **Tests**: coverage for the JSX runtime, SSR renderer, route-segment matching,
  the manifest scanner, the request handler, static serving, the client
  reconciler (hydration, keyed reordering, effects, context), and the build
  layer (route ids, generated entries), Suspense/streaming, error boundaries and
  `notFound()`, middleware, client navigation, and the lint plugin — 75 passing.
  Ships a tiny in-memory DOM shim so reconciler tests need no third-party DOM.

[1.0.2]: https://jsr.io/@denext/denext@1.0.2
[1.0.1]: https://jsr.io/@denext/denext@1.0.1
[1.0.0]: https://jsr.io/@denext/denext@1.0.0
[0.12.0]: https://jsr.io/@denext/denext@0.12.0
[0.6.1]: https://jsr.io/@denext/denext@0.6.1
[0.6.0]: https://jsr.io/@denext/denext@0.6.0
[0.5.0]: https://jsr.io/@denext/denext@0.5.0
[0.4.0]: https://jsr.io/@denext/denext@0.4.0
[0.3.0]: https://jsr.io/@denext/denext@0.3.0
[0.2.0]: https://jsr.io/@denext/denext@0.2.0
[0.1.2]: https://jsr.io/@denext/denext@0.1.2
[0.1.1]: https://jsr.io/@denext/denext@0.1.1
[0.1.0]: https://jsr.io/@denext/denext@0.1.0
