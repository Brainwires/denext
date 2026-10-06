// The test files that change process-wide state: `Deno.env.set` / `Deno.env.delete` or
// `Deno.chdir`, directly or through a helper. `deno test --parallel` runs every test file in ONE
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
  "tests/clerk-example.test.ts",
  "tests/cli-desktop-coverage.test.ts",
  "tests/cli-desktop-publish-update.test.ts",
  "tests/cli-env-tier.test.ts",
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
