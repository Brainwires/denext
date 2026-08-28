/**
 * First-party denext DevTools — public API (`denext/devtools`).
 *
 * A native, dev-only inspector over the running reconciler: read the live component
 * tree with each node's props, hooks/state, and contexts; edit `useState` values live;
 * subscribe to commits; and read the page's render-mode view. It also ships an in-page
 * panel that the dev route entries mount automatically ({@link installDevtools}) — this
 * module is the programmatic surface (for tooling and tests) over the same primitives.
 *
 * Everything here is dev-only: the API no-ops (and the tree is empty) unless
 * `globalThis.__denextDev` is set, and the implementation is imported only by dev
 * bundles, so it never enters a production build. It reads denext's OWN reconciler, and
 * is independent of the React-DevTools browser extension.
 *
 * @module
 */

export {
  type BoundaryTiming,
  clearPropOverrides,
  type CommitSummary,
  type DenextDevtoolsApi,
  disableRenderReasons,
  dispatchReducer,
  enableRenderReasons,
  type FlameNode,
  getBoundaryTimings,
  getCommits,
  getCommitTree,
  getFiberIdForDom,
  getHostNode,
  getInspectorTree,
  getOwnerStack,
  getPageRenderMode,
  getProfile,
  getRenderModes,
  getRenderReason,
  getValueAt,
  type InspectContext,
  type InspectHook,
  type InspectNode,
  type InspectProp,
  installInspector,
  isProfiling,
  logValueAt,
  type PageRenderMode,
  type ProfileEntry,
  type RenderModeEntry,
  type RenderReason,
  resetProfile,
  type SerializedValue,
  setHookState,
  setPropOverride,
  setRefValue,
  startProfiling,
  stopProfiling,
  storeAsGlobal,
  subscribe,
  subscribeBoundaries,
  type ValueRef,
} from "./client/devtools-inspect.ts";

export { installDevtools } from "./client/devtools-panel.ts";
