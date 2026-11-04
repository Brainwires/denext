// Hook kinds — a per-cell tag consumed by the dev Fast Refresh signature guard (see
// renderComponent) and by the render-phase re-render (which keeps memo cells). Distinct
// constant per hook so a same-count reorder across an edit is detected, not just a
// changed count. A leaf module: the per-hook modules (./hooks/) import their kind from here and
// nothing else of the reconciler.

/** useState. */
export const HK_STATE = 1;
/** useReducer (./hooks/use-reducer.ts). */
export const HK_REDUCER = 2;
/** useEffect. */
export const HK_EFFECT = 3;
/** useMemo / useCallback. */
export const HK_MEMO = 4;
/** useRef. */
export const HK_REF = 5;
/** useId (./hooks/use-id.ts). */
export const HK_ID = 6;
/** useSyncExternalStore (./hooks/use-sync-external-store.ts). */
export const HK_STORE = 7;
/** useMemoCache (./hooks/use-memo-cache.ts). */
export const HK_MEMOCACHE = 8;
/** useDeferredValue (./hooks/use-deferred-value.ts). */
export const HK_DEFERRED = 9;
/** useLayoutEffect. */
export const HK_LAYOUT = 10;
/** useInsertionEffect (./hooks/use-insertion-effect.ts). */
export const HK_INSERTION = 11;
