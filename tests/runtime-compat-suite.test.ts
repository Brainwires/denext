// The runtime-compat legs' unit suite (scripts/ci/runtime-compat-suite.ts): each release's own
// `test:unit` ignores plus the curated exclusions, and the workflow wiring that runs them
// hermetically with the gleam install verb that release has.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  compatExclusions,
  compatIgnore,
  RUNTIME_COMPAT_EXCLUDED,
  taskIgnore,
} from "../scripts/ci/runtime-compat-suite.ts";

const WORKFLOW = new URL("../.github/workflows/runtime-compat.yml", import.meta.url);
const TASK =
  "deno run -A scripts/test-run.ts --ignore=tests/e2e/,tests/migration-bed/,tests/integration/";

Deno.test("runtime-compat suite: a leg's ignores are its task's plus the exclusions it has", () => {
  assertEquals(taskIgnore(TASK), "tests/e2e/,tests/migration-bed/,tests/integration/");
  const files = new Set(["tests/runtime-select.test.ts"]);
  assertEquals(
    compatIgnore(TASK, compatExclusions("4.22.0"), (f) => files.has(f)),
    "tests/e2e/,tests/migration-bed/,tests/integration/,tests/runtime-select.test.ts",
  );
  // A minor with no exclusions runs its whole unit suite.
  assertEquals(compatExclusions("4.23.0"), []);
  assertEquals(compatIgnore(TASK, compatExclusions("4.23.1"), () => true), taskIgnore(TASK));
  // A task of another shape is a loud failure, never a silently wider suite.
  assertThrows(() => taskIgnore("deno test -A"), Error, "update");
  assertThrows(() => compatExclusions("next"), Error, "not a denext version");
});

Deno.test("runtime-compat suite: every exclusion names a test file and why", () => {
  for (const [minor, list] of Object.entries(RUNTIME_COMPAT_EXCLUDED)) {
    assert(/^\d+\.\d+$/.test(minor), minor);
    for (const e of list) {
      assert(/^tests\/[\w./-]+\.test\.ts$/.test(e.file), e.file);
      assert(e.reason.length > 20, `${minor} ${e.file} needs a reason`);
    }
  }
  // The current tests carry none of these problems: nothing past 4.22 is excluded.
  assert(Object.keys(RUNTIME_COMPAT_EXCLUDED).every((m) => Number(m.split(".")[1]) <= 22));
});

Deno.test("runtime-compat.yml: hermetic legs, the curated unit suite, the gleam verb each release has", async () => {
  const yml = await Deno.readTextFile(WORKFLOW);
  for (const line of ["DENEXT_REVOCATION_CHECK=0", "DENEXT_RUNTIME_CHANNEL=0"]) {
    assertStringIncludes(yml, line);
  }
  assertStringIncludes(yml, "DENEXT_RUNTIME_DEFAULT_FILE=");
  assertStringIncludes(yml, "cd ../tooling && deno run -A scripts/ci/runtime-compat-suite.ts");
  assertStringIncludes(yml, 'deno run -A scripts/test-run.ts "--ignore=$ignore"');
  // `runtime install` exists from 4.21 only; 4.20 has `toolchain install`.
  assertStringIncludes(yml, "if [ -f src/cli/commands/runtime.ts ]; then verb=runtime");
  assertStringIncludes(yml, 'deno run -A cli.ts "$verb" install --with gleam');
  assert(!yml.includes("run: deno run -A cli.ts runtime install --with gleam"));
  // The suite script runs from the tooling checkout: that is the dispatched commit (which has it),
  // never `development` (which may not yet).
  const tooling = yml.match(/ref: (\S+)\n\s+path: tooling/);
  assertEquals(tooling?.[1], "${{ github.sha }}");
});
