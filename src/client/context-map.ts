// Shared context-map derivation + the props/context bailout predicate, used by
// both the recursive reconciler and the fiber reconciler. The key idea is
// context-map *identity*: an unchanged provider reuses the same child-map
// reference, which makes reference equality an exact "did any context above
// change" signal for the component bailout.

import { PROVIDER } from "../runtime/context.ts";
import { areEqualOf } from "../runtime/memo.ts";
import type { VNode } from "../jsx/types.ts";

/** The provider bookkeeping both reconcilers' node types satisfy. */
export interface ProviderState {
  /** Context values visible to this instance's subtree. */
  contexts: Map<symbol, unknown>;
  /** The parent map the current `contexts` was derived from (memo key). */
  provParent?: Map<symbol, unknown>;
  /** The provided value the current `contexts` was derived from (memo key). */
  provValue?: unknown;
}

/**
 * Compute the context map visible to a fragment's children. When the fragment is
 * a context provider, derive a child map from `parent` + the provided value —
 * *reusing the previous child-map reference* when neither the parent map nor the
 * provided value changed. That reference stability is what lets the component
 * bailout treat context-map identity as an exact "no context above me changed"
 * signal (see {@link propsAndContextEqual}). Non-provider fragments pass `parent`
 * through unchanged.
 *
 * @param state The fragment node (stores the memo of its last derivation).
 * @param vnode The fragment vnode (carries the provider info, if any).
 * @param parent The context map inherited from above.
 */
export function providerContexts(
  state: ProviderState,
  vnode: VNode,
  parent: Map<symbol, unknown>,
): Map<symbol, unknown> {
  const info = vnode.props[PROVIDER as unknown as string] as
    | { id: symbol; value: unknown }
    | undefined;
  if (!info) return parent;
  if (
    state.provParent === parent && Object.is(state.provValue, info.value) &&
    state.contexts.get(info.id) === info.value
  ) {
    return state.contexts; // unchanged provider — reuse the same child-map reference
  }
  const next = new Map(parent);
  next.set(info.id, info.value);
  state.provParent = parent;
  state.provValue = info.value;
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
): boolean {
  if (prevContexts !== nextContexts) return false;
  return areEqualOf(type)(prevProps, nextProps);
}
