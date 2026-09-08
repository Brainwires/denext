// Install the Activity offscreen scheduler into the reconciler seam for unbundled tests.
//
// In a real app the generated route/Flight entry emits `installActivitySupport()` (gated by
// a build scan for `Activity`). `deno test` has no generated entry, so a test that renders
// an `<Activity>` through the client reconciler imports this module for its side effect.
// Idempotent.
import { installActivitySupport } from "../../src/client/fiber/activity-runtime.ts";

installActivitySupport();
