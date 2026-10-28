// Importing this module stops the in-process esbuild service after each test of the importing
// file. A build in the test process starts that service (src/build/esbuild/mod.ts) and keeps it
// warm for the next build, as a CLI does; a test that ends with it running leaves a child process
// the op / resource sanitizers (on in deno.json) report, and the next test inherits it.

import { stop } from "../../src/build/esbuild/mod.ts";

Deno.test.afterEach(() => stop());
