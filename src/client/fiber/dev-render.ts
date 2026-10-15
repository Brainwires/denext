// The reconciler's dev-only render aids, installed together by the dev entries (via
// `installDevtools`) and by `denext/testing`: StrictMode's double render and mount-effect
// double-invoke, `useDebugValue`'s recording and `captureOwnerStack()`. A production bundle never imports this
// module, so the StrictMode boundary check, its second render pass and the debug-value
// recorder are tree-shaken out; there StrictMode is a plain Fragment, `useDebugValue` a no-op and
// `captureOwnerStack()` returns `null`.

import { installStrictBoundaries } from "./begin-work.ts";
import { installStrictRender } from "./render-component.ts";
import { installDebugValues } from "./hooks-dispatcher.ts";
import { installOwnerStack } from "../owner-stack.ts";

/**
 * Install (`true`) or remove (`false`) StrictMode's dev double-invoke, the `useDebugValue`
 * recorder and `captureOwnerStack()`. All still act only while `__denextDev` is set.
 */
export function installDevRender(on = true): void {
  installStrictBoundaries(on);
  installStrictRender(on);
  installDebugValues(on);
  installOwnerStack(on);
}
