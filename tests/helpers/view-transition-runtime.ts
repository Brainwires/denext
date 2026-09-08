// Install the ViewTransition marking runtime into the reconciler seam for unbundled tests.
//
// In a real app the generated route/Flight entry emits `installViewTransitionSupport()`
// (gated by a build scan for `<ViewTransition>`). `deno test` has no generated entry, so a
// test that exercises the marking imports this module for its side effect. Idempotent.
import { installViewTransitionSupport } from "../../src/client/fiber/view-transition-runtime.ts";

installViewTransitionSupport();
