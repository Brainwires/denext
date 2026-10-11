// The reconciler's dev-only render aids, installed together by the dev entries (via
// `installDevtools`) and by `denext/testing`: StrictMode's double render and mount-effect
// double-invoke, and `useDebugValue`'s recording. A production bundle never imports this
// module, so the StrictMode boundary check, its second render pass and the debug-value
// recorder are tree-shaken out; there StrictMode is a plain Fragment and `useDebugValue` a no-op.

import { installStrictBoundaries } from "./begin-work.ts";
import { installStrictRender } from "./render-component.ts";
import { installDebugValues } from "./hooks-dispatcher.ts";

/**
 * Install (`true`) or remove (`false`) StrictMode's dev double-invoke and the `useDebugValue`
 * recorder. Both still act only while `__denextDev` is set.
 */
export function installDevRender(on = true): void {
  installStrictBoundaries(on);
  installStrictRender(on);
  installDebugValues(on);
}
