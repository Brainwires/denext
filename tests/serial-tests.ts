// The test files that change process-wide state: `Deno.env.set` / `Deno.env.delete` or
// `Deno.chdir`, directly, through a helper, or by running a src export that does
// (`SERIAL_SOURCES`). `deno test --parallel` runs every test file in ONE
// process, so such a change reaches whatever test reads that variable (or a relative path) at the
// same moment, and a `finally` that restores it does not help that test. `scripts/test-run.ts`
// runs these files one at a time after the parallel pass, and `tests/serial-tests.test.ts` fails
// when a file starts changing process-wide state without being listed here.
//
// A test that can take its value explicitly, or run its subject in a child process
// (`tests/helpers/isolated.ts`), stays out of this list.

/** The test files run one at a time (paths from the repo root). */
export const SERIAL_TESTS: readonly string[] = [
  // Sets and restores DENEXT_SERVER_ACTIONS_ENCRYPTION_KEY around each case (the bound-action key).
  "tests/action-bound.test.ts",
  "tests/action-ids-exposure.test.ts",
  "tests/auth-example.test.ts",
  // Sets and restores DENEXT_BOOT_DDL around each case (the revocation-list boot check).
  "tests/auth-revocation-boot.test.ts",
  "tests/backend-identity.test.ts",
  "tests/backend-postgres.test.ts",
  "tests/backend-supabase-functions.test.ts",
  "tests/build-next-config-eval.test.ts",
  "tests/build.test.ts",
  "tests/bundle-define.test.ts",
  "tests/bundle-side-effects.test.ts",
  "tests/cache-default-store.test.ts",
  "tests/cli-analyze-coverage.test.ts",
  "tests/cli-dashboard.test.ts",
  "tests/clerk-example.test.ts",
  "tests/cli-help-dir.test.ts",
  "tests/cli-plugin-add-remove.test.ts",
  // Sets DENEXT_STATE_DIR and clears the standalone variables around `runStandalone`.
  "tests/compile-app.test.ts",
  "tests/cli-desktop-coverage.test.ts",
  "tests/cli-desktop-publish-update.test.ts",
  "tests/cli-env-tier.test.ts",
  "tests/cli-generate-ops.test.ts",
  "tests/config.test.ts",
  "tests/conformance.test.ts",
  "tests/deno-exec.test.ts",
  "tests/dep-age.test.ts",
  "tests/desktop-app-dirs.test.ts",
  "tests/desktop-deno-flags.test.ts",
  "tests/desktop-doctor.test.ts",
  "tests/desktop-pinned-runtime.test.ts",
  "tests/desktop-run.test.ts",
  "tests/desktop-security.test.ts",
  "tests/desktop-sidecar-child.test.ts",
  "tests/desktop-updater.test.ts",
  "tests/desktop-windows-cef-trust.test.ts",
  "tests/devtools-meta.test.ts",
  "tests/devtools-route-meta.test.ts",
  "tests/docs-tutorial-islands.test.ts",
  "tests/docker-cmd-port.test.ts",
  "tests/e2e-harness-env.test.ts",
  "tests/env.test.ts",
  "tests/examples-offline-sync.test.ts",
  "tests/fresh-parity.test.ts",
  "tests/instrumentation.test.ts",
  "tests/integration/build-smoke.test.ts",
  "tests/integration/example-notes.test.ts",
  "tests/integration/example-offline-sync.test.ts",
  "tests/integration/rate-limit-header-server.test.ts",
  "tests/integration/server-action-stubs.test.ts",
  "tests/jail-scripts.test.ts",
  "tests/job-discovery.test.ts",
  "tests/legacy-migrate-job.test.ts",
  "tests/live-views.test.ts",
  // Sets and restores DENEXT_CHILD_PROBE around one case (the probed loader `deno info`).
  "tests/loader-deno-info.test.ts",
  "tests/mcp-dev-logs-spa.test.ts",
  "tests/mcp-devtools.test.ts",
  "tests/migrate-check.test.ts",
  "tests/migrate-effect-fixture.test.ts",
  "tests/migrate-spa.test.ts",
  "tests/mobile-build-hardening.test.ts",
  "tests/mobile-build.test.ts",
  "tests/mobile-fastlane.test.ts",
  "tests/mobile-sentry.test.ts",
  "tests/module-graph.test.ts",
  "tests/native-inline-action-form.test.ts",
  "tests/next-auth-react-v4.test.ts",
  "tests/next-auth-v4-app.test.ts",
  "tests/next-auth-v4.test.ts",
  "tests/next-compat-build.test.ts",
  // Deno.chdir into a fixture: next/font/local resolves its files against the cwd.
  "tests/next-font-local-fallback.test.ts",
  "tests/ota-app-binding.test.ts",
  "tests/ota-manifest.test.ts",
  // Both set and restore DENEXT_BOOT_DDL around each case (the boot-DDL opt-out every Postgres
  // store reads when it starts): a parallel test starting a store would see the other value.
  "tests/postgres-boot-integration.test.ts",
  "tests/postgres-boot.test.ts",
  "tests/profile-android.test.ts",
  "tests/public-env.test.ts",
  "tests/react-native-uniwind-css.test.ts",
  // Sets the variables a migrated load context reads (`process.env.*`) and runs it.
  "tests/remix-load-context.test.ts",
  "tests/scaffold-monorepo.test.ts",
  "tests/security-remediation.test.ts",
  "tests/server-misc-coverage.test.ts",
  "tests/sourcemap-attribution.test.ts",
  "tests/spa-export.test.ts",
  "tests/start-tls.test.ts",
  "tests/stock-deprecation.test.ts",
  "tests/tailwind.test.ts",
  "tests/toolchain-audit.test.ts",
  "tests/toolchain-download-timeouts.test.ts",
  "tests/ui-desktop-feature.test.ts",
];

/** Helpers that change process-wide state: a test file importing one is serial too. */
export const SERIAL_HELPERS: readonly string[] = [
  "tests/helpers/desktop-run-boot.ts",
];

/**
 * src modules that change process-wide state when one of the named exports runs (or, for a CLI
 * command, when a test runs its verb through the registry: `.get("<verb>")!.run(`). A test file or
 * helper that imports one of those exports from a module reaching the source through its imports,
 * or runs one of those verbs, is serial; `tests/serial-tests.test.ts` follows the imports, and
 * fails when a src module starts changing process-wide state without being listed here or in
 * {@linkcode SERIAL_SOURCE_EXEMPT}.
 *
 * `setNextRuntimeEnv` also runs inside every `createApp` and dev app; that write is set-if-unset
 * to one constant (`NEXT_RUNTIME=nodejs`), so a test reading the variable sees the same value
 * whichever test set it, and the app tests stay parallel. Only a test running the export itself is
 * serial.
 */
export const SERIAL_SOURCES: Readonly<
  Record<string, { readonly exports: readonly string[]; readonly verbs?: readonly string[] }>
> = {
  "src/cli/commands/analyze.ts": { exports: ["analyzeCommand"], verbs: ["analyze"] },
  "src/cli/commands/desktop.ts": { exports: ["desktopCommand"], verbs: ["desktop"] },
  // `applyRawFlag` sets DENEXT_RAW_DIAGNOSTICS=1 for the whole process when `--raw` is given
  // (the verbs that call it are serve.ts's, listed below).
  "src/cli/explain-output.ts": { exports: ["applyRawFlag"] },
  // `markProduction` sets DENEXT_ENV / NODE_ENV when neither is set (`denext start` and a compiled
  // app's start do; their verbs are listed with serve.ts, and compile-app's test is serial).
  "src/cli/commands/start-options.ts": { exports: ["markProduction"] },
  "src/cli/commands/serve.ts": {
    exports: ["devCommand", "exportCommand", "startCommand"],
    verbs: ["dev", "export", "start"],
  },
  "src/profile/core.ts": { exports: ["profileApp"] },
  "src/server/env.ts": { exports: ["loadEnv"] },
  "src/server/instrumentation.ts": { exports: ["setNextRuntimeEnv"] },
  "src/server/phase.ts": { exports: ["markBuildPhase"] },
};

/** src modules that change process-wide state without making a test that reaches them serial. */
export const SERIAL_SOURCE_EXEMPT: Readonly<Record<string, string>> = {
  "src/build/fumadocs-mdx-worker.ts": "the entry point of its own `deno run` child process",
  "src/build/stock-deprecation.ts":
    "warnStockDeprecation sets DENEXT_STOCK_DEPRECATION_SHOWN=1 (set-once, one constant) only on " +
    "a stock-Deno path run with the process's own env; tests pass env / setEnv seams, and the " +
    "real process tree runs in `deno eval` children",
  "src/build/desktop.ts":
    "runDesktop clears DENO_SERVE_ADDRESS (the desktop runtime's page transport) only for an app " +
    "that declares sidecars, after its own server took it; no test sets or reads that variable",
  "src/ts/engine.ts":
    "applyNativeCheckEngine sets DENO_CHECK_ENGINE for the verb's Deno children only when the " +
    "`denext` entrypoint's run half calls it (src/cli/run-verb.ts, exempt below); tests pass their " +
    "own setEnv / env seams",
  "src/cli/run-verb.ts":
    "the `denext` entrypoint's run half: it sets DENO_BIN / PATH / DENEXT_TOOLCHAIN_ACTIVE only " +
    "inside a compiled binary (the toolchain handed to its children); tests reach it only " +
    "through CLI child processes",
  "src/desktop/sidecar-child.ts":
    "readSidecarChildLaunch removes DENEXT_SIDECAR_CHILD / _ARGC only when they are set, which " +
    "only a sidecar's child process (and the serial test of it) does",
};

/**
 * The test files that build or serve an app IN the test process (a dev server, `createTestApp`,
 * the esbuild service), where the subject needs the process itself (returned objects, a live
 * server, module state) and so can't move to a child (`tests/helpers/bounded-build.ts`). On
 * Windows `scripts/test-run.ts` runs them in the serial pass too: in `deno test --parallel` a
 * long-lived child one of them spawns (the esbuild service, a server) inherits the pipes of a
 * `deno info` / `deno bundle` another thread just started, which then never sees EOF — a stall
 * the watchdog can only fail, not stop, since an in-process build can't be killed. Alone in the
 * process they can't meet another thread's children. Elsewhere pipes are close-on-exec, and they
 * stay in the parallel pass. `tests/serial-tests.test.ts` keeps the list complete.
 */
export const WINDOWS_SERIAL_TESTS: readonly string[] = [
  "tests/dev-server-module-refresh.test.ts",
  "tests/integration/next-compat-flight.test.ts",
  "tests/npm-boundary.test.ts",
  "tests/optimize-package-imports.test.ts",
  "tests/platform-extensions-css.test.ts",
  "tests/platform-extensions-dev.test.ts",
  "tests/platform-extensions-pages-router.test.ts",
  "tests/react-compiler-runtime.test.ts",
  "tests/services.test.ts",
  "tests/spa-dev-plugins.test.ts",
  "tests/tanstack-start-mock.test.ts",
  "tests/tanstack-start-plugin.test.ts",
  "tests/test-app-plugins.test.ts",
  "tests/ui-config-cron.test.ts",
];

/**
 * The files the serial pass runs on `os`: {@linkcode SERIAL_TESTS}, plus
 * {@linkcode WINDOWS_SERIAL_TESTS} on Windows.
 *
 * @param os `Deno.build.os`.
 */
export function serialTestsFor(os: string): readonly string[] {
  return os === "windows" ? [...SERIAL_TESTS, ...WINDOWS_SERIAL_TESTS] : SERIAL_TESTS;
}
