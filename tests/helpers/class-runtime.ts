// Install the class-component runtime into the reconciler seam for unbundled tests.
//
// In a real app the generated route/Flight entry emits `installClassSupport()` (gated by a
// build scan). `deno test` has no generated entry, so a test that renders a class component
// through the client reconciler imports this module for its side effect. Idempotent.
import { installClassSupport } from "../../src/compat/class-component.ts";

installClassSupport();
