/**
 * `next/form` compat — the `<Form>` component.
 *
 * `<Form action="/search">` renders a real `<form>` that works without JS (a
 * plain GET submit), and on the client intercepts submit into a soft navigation
 * with the form fields encoded as search params — the same progressive-
 * enhancement contract as Next's `<Form>`. When `action` is a function (a Server
 * Action), it renders a plain form and lets denext's action machinery handle the
 * submit (no navigation interception).
 *
 * @module
 */

import { h, navigate, prefetch, useEffect } from "../../../mod.ts";
import type { VNode, VNodeChildren } from "../../jsx/types.ts";

/** Props for the {@link Form} component. */
export interface FormProps {
  /**
   * Where to submit. A string path navigates (GET) with the form fields as
   * search params; a function is treated as a Server Action (plain form submit).
   */
  action: string | ((formData: FormData) => void | Promise<void>);
  /** Replace the current history entry instead of pushing a new one. */
  replace?: boolean;
  /** Scroll to the top after navigating (defaults to true). */
  scroll?: boolean;
  /** Prefetch the `action` path in the background (string actions only). */
  prefetch?: boolean;
  /** A submit handler run before navigation; call `preventDefault()` to cancel. */
  onSubmit?: (event: Event) => void;
  /** Form contents. */
  children?: VNodeChildren;
  /** Any additional attributes forwarded to the underlying `<form>`. */
  [key: string]: unknown;
}

/**
 * A form that submits via client-side navigation (GET) with progressive
 * enhancement, or delegates to a Server Action when `action` is a function.
 */
export default function Form(props: FormProps): VNode {
  const { action, replace, scroll, prefetch: pf, onSubmit, children, ...rest } = props;
  const isStringAction = typeof action === "string";

  // Prefetch the navigation target (string actions only, browser only).
  useEffect(() => {
    if (isStringAction && pf !== false) prefetch(action as string);
  }, [isStringAction ? action : null, pf]);

  // Function action → a Server Action: render a plain form, no interception.
  if (!isStringAction) {
    return h("form", {
      ...rest,
      action: action as unknown as string,
      onSubmit,
      children,
    });
  }

  const handleSubmit = (event: Event): void => {
    onSubmit?.(event);
    if (event.defaultPrevented) return;
    // Server-side (no DOM) or a non-form target: let the native GET submit happen.
    const form = event.currentTarget as HTMLFormElement | null;
    if (typeof document === "undefined" || !form) return;
    event.preventDefault();
    // Encode text fields as search params (GET semantics; files are dropped, as a
    // GET form would drop them).
    const params = new URLSearchParams();
    for (const [name, value] of new FormData(form)) {
      if (typeof value === "string") params.append(name, value);
    }
    const qs = params.toString();
    navigate(qs ? `${action}?${qs}` : (action as string), { replace, scroll });
  };

  return h("form", {
    ...rest,
    action: action as string,
    method: "get",
    onSubmit: handleSubmit,
    children,
  });
}
