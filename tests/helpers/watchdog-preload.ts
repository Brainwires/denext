// `deno test --preload tests/helpers/watchdog-preload.ts`: the per-test stall watchdog
// (`tests/helpers/watchdog.ts`) for every test of the file, whether or not the file calls
// `watchTests()` itself. `scripts/test-run.ts` adds it to every stock pass, so a test that hangs
// (an in-process child whose await never settles) fails at its deadline with the open
// subprocesses and the process tree, and the run goes on, instead of holding the CI job until its
// timeout. `DENEXT_TEST_DEADLINE_MS` sets the deadline (`0` turns it off).

import { watchAllTests } from "./watchdog.ts";

watchAllTests();
