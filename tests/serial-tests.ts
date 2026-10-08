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
  "tests/auth-example.test.ts",
  "tests/build-next-config-eval.test.ts",
  "tests/build.test.ts",
  "tests/cache-default-store.test.ts",
  "tests/cli-analyze-coverage.test.ts",
  "tests/clerk-example.test.ts",
  "tests/cli-desktop-coverage.test.ts",
  "tests/cli-desktop-publish-update.test.ts",
  "tests/cli-env-tier.test.ts",
  "tests/cli-generate-ops.test.ts",
  "tests/config.test.ts",
  "tests/conformance.test.ts",
  "tests/deno-exec.test.ts",
  "tests/desktop-app-dirs.test.ts",
  "tests/desktop-deno-flags.test.ts",
  "tests/desktop-doctor.test.ts",
  "tests/desktop-run.test.ts",
  "tests/desktop-security.test.ts",
  "tests/desktop-updater.test.ts",
  "tests/devtools-meta.test.ts",
  "tests/devtools-route-meta.test.ts",
  "tests/docs-tutorial-islands.test.ts",
  "tests/env.test.ts",
  "tests/instrumentation.test.ts",
  "tests/integration/build-smoke.test.ts",
  "tests/integration/example-notes.test.ts",
  "tests/mcp-dev-logs-spa.test.ts",
  "tests/mcp-devtools.test.ts",
  "tests/migrate-effect-fixture.test.ts",
  "tests/migrate-spa.test.ts",
  "tests/mobile-build.test.ts",
  "tests/mobile-sentry.test.ts",
  "tests/next-compat-build.test.ts",
  "tests/ota-manifest.test.ts",
  "tests/public-env.test.ts",
  "tests/security-remediation.test.ts",
  "tests/server-misc-coverage.test.ts",
  "tests/spa-export.test.ts",
  "tests/tailwind.test.ts",
  "tests/task-discovery.test.ts",
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
  "src/cli/commands/serve.ts": {
    exports: ["devCommand", "exportCommand", "startCommand"],
    verbs: ["dev", "export", "start"],
  },
  "src/profile/core.ts": { exports: ["profileApp"] },
  "src/server/env.ts": { exports: ["loadEnv"] },
  "src/server/instrumentation.ts": { exports: ["setNextRuntimeEnv"] },
};

/** src modules that change process-wide state without making a test that reaches them serial. */
export const SERIAL_SOURCE_EXEMPT: Readonly<Record<string, string>> = {
  "src/build/fumadocs-mdx-worker.ts": "the entry point of its own `deno run` child process",
};
