// The full texts of the client reconciler's errors (errors.ts), installed in dev by
// `installDevtools` and by `denext/testing`. A production bundle never imports this module.

import { componentDisplayName } from "../../runtime/react-brands.ts";
import { classComponentsDisabledError } from "../../compat/class-detect.ts";
import { devHydrationActive } from "./fiber-utils.ts";
import {
  ERR_ASYNC_COMPONENT,
  ERR_CLASS_DISABLED,
  ERR_MEMO_CLASS,
  ERR_MORE_HOOKS,
  ERR_UPDATE_DEPTH,
  type ErrorText,
  setErrorTexts,
} from "./errors.ts";

const TEXTS: Record<number, ErrorText> = {
  [ERR_MORE_HOOKS]: () =>
    "Rendered more hooks than during the previous render. Hooks must be called in the " +
    "same order on every render (not inside conditions, loops or after an early return).",
  // React's "Maximum update depth exceeded", naming the component. In dev it also lists the
  // components above the fiber (React's component stack).
  [ERR_UPDATE_DEPTH]: (name, fiber) => {
    let stack = "";
    if (devHydrationActive()) {
      for (let n = fiber ?? null; n !== null; n = n.return) {
        if (n.tag === "component") stack += `\n    in ${componentDisplayName(n.vnode.type)}`;
      }
    }
    return `denext: Maximum update depth exceeded. <${name}> repeatedly schedules an update ` +
      `during render (e.g. calling setState unconditionally while rendering).${stack}`;
  },
  [ERR_ASYNC_COMPONENT]: () =>
    "denext: async components are server-only; cannot render on the client.",
  [ERR_MEMO_CLASS]: () =>
    "denext: memo() of a class component is unsupported; wrap the class in a " +
    "function component (or memo the function) instead.",
  [ERR_CLASS_DISABLED]: () => classComponentsDisabledError().message,
};

/** Install (or, with `false`, remove) the full texts of the client reconciler's errors. */
export function installErrorTexts(on = true): void {
  setErrorTexts(on ? TEXTS : null);
}
