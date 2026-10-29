// The full texts of the client reconciler's errors (errors.ts), installed in dev by
// `installDevtools` and by `denext/testing`. A production bundle never imports this module.

import { componentDisplayName } from "../../runtime/react-brands.ts";
import { classComponentsDisabledError } from "../../compat/class-detect.ts";
import { devHydrationActive } from "./fiber-utils.ts";
import {
  ERR_ASYNC_COMPONENT,
  ERR_CLASS_DISABLED,
  ERR_FORM_ACTIONS_OFF,
  ERR_HOOK_BOUNDARIES_OFF,
  ERR_HREF_PARAMS_OFF,
  ERR_IMAGE_BLUR_OFF,
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
  [ERR_CLASS_DISABLED]: () => classComponentsDisabledError().message,
  [ERR_FORM_ACTIONS_OFF]: (name) =>
    `denext: a function-valued \`${name}\` was rendered, but this build left the form-action ` +
    "runtime out: no source file of the app names `action` or `formAction`. Name it once in the " +
    "app's own code (a library's form is not scanned).",
  [ERR_HOOK_BOUNDARIES_OFF]: (name) =>
    `denext: <${name}> calls useErrorBoundary, but this build left the reconciler's hook-boundary ` +
    "support out: no source file of the app names `useErrorBoundary` or imports preact-iso. " +
    "Name it once in the app's own code (a library is not scanned).",
  [ERR_HREF_PARAMS_OFF]: (name) =>
    `denext: a route-pattern href (${name}) was rendered, but this build left the pattern ` +
    "filling out: no source file of the app passes `params` with a `[segment]` pathname, so it " +
    "would navigate to the literal pattern. Write one once in the app's own code (a library " +
    "is not scanned), or pass a filled pathname.",
  [ERR_IMAGE_BLUR_OFF]: () =>
    'denext: the page has a blur placeholder (placeholder="blur"), but this build left its ' +
    'clearing out: no source file of the app names `placeholder="blur"`, so the placeholder ' +
    "would stay painted. Name it once in the app's own code (a library is not scanned).",
};

/** Install (or, with `false`, remove) the full texts of the client reconciler's errors. */
export function installErrorTexts(on = true): void {
  setErrorTexts(on ? TEXTS : null);
}
