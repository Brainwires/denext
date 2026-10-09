// Shared context-map derivation + the props/context bailout predicate, used by
// both the recursive reconciler and the fiber reconciler. The key idea is
// context-map *identity*: an unchanged provider reuses the same child-map
// reference, which makes reference equality an exact "did any context above
// change" signal for the component bailout.

import { PROVIDER } from "../runtime/context.ts";
import { areEqualOf } from "../runtime/memo.ts";
import type { VNode } from "../jsx/types.ts";
import { type Fiber, fiberExt } from "./fiber/fiber.ts";

/**
 * Compute the context map visible to a fragment's children. When the fragment is
 * a context provider, derive a child map from `parent` + the provided value —
 * *reusing the previous child-map reference* when neither the parent map nor the
 * provided value changed. That reference stability is what lets the component
 * bailout treat context-map identity as an exact "no context above me changed"
 * signal (see {@link propsAndContextEqual}). Non-provider fragments pass `parent`
 * through unchanged.
 *
 * @param state The fragment fiber (its `contexts`, and the memo of its last derivation —
 *   `provParent` / `provValue` — on its extension).
 * @param vnode The fragment vnode (carries the provider info, if any).
 * @param parent The context map inherited from above.
 */
export function providerContexts(
  state: Fiber,
  vnode: VNode,
  parent: Map<symbol, unknown>,
): Map<symbol, unknown> {
  const info = vnode.props[PROVIDER as unknown as string] as
    | { id: symbol; value: unknown }
    | undefined;
  if (!info) return parent;
  const memo = state.ext;
  if (
    memo !== undefined && memo.provParent === parent && Object.is(memo.provValue, info.value) &&
    state.contexts.get(info.id) === info.value
  ) {
    return state.contexts; // unchanged provider — reuse the same child-map reference
  }
  const next = new Map(parent);
  next.set(info.id, info.value);
  const x = fiberExt(state);
  x.provParent = parent;
  x.provValue = info.value;
  return next;
}

/**
 * Whether a component's props and visible context are unchanged enough to reuse
 * its rendered subtree: the visible context map is reference-identical (so no
 * context above changed value — see {@link providerContexts}) and its props
 * satisfy the bailout comparator (shallow-equal, or a custom `memo()` comparator).
 * Callers combine this with their own "no pending state update" check.
 */
export function propsAndContextEqual(
  type: VNode["type"],
  prevProps: Record<string, unknown>,
  nextProps: Record<string, unknown>,
  prevContexts: Map<symbol, unknown>,
  nextContexts: Map<symbol, unknown>,
  readContexts: Set<symbol> | undefined,
): boolean {
  // When the inherited maps differ in identity, an ancestor provider re-rendered.
  // React re-renders only actual consumers, so bail unless a context THIS fiber read
  // last render changed value. `undefined` readContexts = read nothing → still bail.
  // (Same-identity maps are the common re-render case and skip the value compare.)
  if (prevContexts !== nextContexts && readContexts !== undefined) {
    for (const id of readContexts) {
      if (!Object.is(prevContexts.get(id), nextContexts.get(id))) return false;
    }
  }
  return areEqualOf(type)(prevProps, nextProps);
}
