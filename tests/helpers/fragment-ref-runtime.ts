// Install the Fragment-ref runtime into the reconciler seam up front, for unbundled tests.
//
// In an app the first `<Fragment ref>` a render reaches loads it (fragment-ref-support.ts) and
// suspends that render until it lands. A test that wants its first render to commit the ref
// synchronously imports this module for its side effect. Idempotent.
import * as runtime from "../../src/client/fiber/fragment-instance.ts";
import { installFragmentRuntime } from "../../src/client/fiber/fragment-ref-support.ts";

installFragmentRuntime(runtime);
