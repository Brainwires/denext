// The server renderers' seam for `captureOwnerStack()` (development only): the renderers call
// these, and they forward to the implementation the dev server installs on a registry symbol
// (`installServerOwnerStack` in src/server/owner-stack.ts, which carries `node:async_hooks`, so
// this module stays free of it and safe for a client bundle). Nothing installed — production `start`, a client bundle that
// reaches a renderer module — each call is one global read, and `captureOwnerStack()` returns
// `null` during a server render, as React's does in production.

import { invokeComponent, resolveComponentType } from "../runtime/react-brands.ts";
import { invokeWithRenderPhase } from "./render-phase.ts";

/** What the dev server installs on {@linkcode SERVER_OWNERS}. */
export interface ServerOwners {
  /** Run a component invocation as `type`'s render frame, then stamp the elements it returned. */
  invoke(type: unknown, props: object, run: () => unknown): unknown;
  /** Give an element copy (a new props object) the owner and source of the original. */
  carry(from: object, to: object): void;
  /** The rendering component's owner stack, or `null` outside a server render. */
  capture(): string | null;
  /** Note the owner and JSX source of an element a dev build's `jsxDEV` made. */
  record(el: object, source: unknown): void;
}

/** The registry slot (a symbol, so two runtime copies in one process share one install). */
export const SERVER_OWNERS: unique symbol = Symbol.for("denext.serverOwners");

type Holder = { [SERVER_OWNERS]?: ServerOwners };

/** The server dispatcher's `captureOwnerStack()`. */
export function serverOwnerStack(): string | null {
  return (globalThis as Holder)[SERVER_OWNERS]?.capture() ?? null;
}

/** Carry an element's owner over to a copy of it with new props (a keyed component's output). */
export function carryServerOwner(from: object | undefined, to: object): void {
  if (from) (globalThis as Holder)[SERVER_OWNERS]?.carry(from, to);
}

/**
 * Invoke a function component (a memo / forwardRef wrapper resolved) with render-phase state,
 * as the component's owner-stack frame when the dev server installed one. Every server renderer's
 * component call goes through here.
 *
 * @param type The component type as the element names it.
 * @param props Its element's props.
 * @returns What it rendered (a promise for an async Server Component).
 */
export function invokeFunctionComponent(type: unknown, props: Record<string, unknown>): unknown {
  const component = resolveComponentType(type);
  const run = () => invokeWithRenderPhase(() => invokeComponent(component, props));
  const owners = (globalThis as Holder)[SERVER_OWNERS];
  return owners === undefined ? run() : owners.invoke(type, props, run);
}
