/**
 * # denext/class-runtime — the on-demand class-component runtime
 *
 * The reconciler-side half of React class-component support (mount/update/unmount
 * lifecycle, `setState` batching, `shouldComponentUpdate`/`PureComponent`, class error
 * boundaries). It is a **separate entrypoint**, loaded by the generated browser entry only
 * when a page actually renders a class component — so an app whose classes live in a
 * dependency it never names still works in production, and a function-only app bundles
 * none of it (the same discipline as `denext/lazy` and `denext/live`). The `Component` /
 * `PureComponent` base classes themselves stay in the eager `react` alias (a module
 * `extends` them at evaluation time).
 *
 * `installClassSupport` is called by the generated entry, not by app code.
 *
 * @module
 */

export { installClassSupport } from "./compat/class-component.ts";
