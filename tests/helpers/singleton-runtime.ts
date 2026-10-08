// Install the host-singleton runtime into the reconciler seam for unbundled tests.
//
// In a real app the generated entry emits `installSingletonSupport()` (gated by a build scan for
// a document tag in the app's sources). `deno test` has no generated entry, so a test that
// renders a client root layout imports this module for its side effect. Idempotent.
import { installSingletonSupport } from "../../src/client/fiber/singleton-runtime.ts";

installSingletonSupport();
