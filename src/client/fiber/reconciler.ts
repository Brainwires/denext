// The fiber reconciler: denext's own React-compatible renderer (hooks, Suspense,
// transitions, hydration, portals, class components) over a double-buffered fiber tree.
//
// This module is the public surface; the engine is split into layered modules under this
// directory, each importing only from the layers below it:
//
//   fiber.ts               the Fiber node, flags and lanes (pure data)
//   fiber-utils.ts         pure helpers over fibers
//   state.ts               the shared mutable singletons + root registry
//   root-callbacks.ts      RootOptions error callbacks
//   hydration.ts           claiming server DOM during hydrateRoot
//   scheduler.ts           lanes, the sync flush, time-sliced transitions
//   devtools-bridge.ts     inspector / React DevTools bridge
//   hooks-dispatcher.ts    the client hook implementations
//   boundaries.ts          Suspense retry + error-boundary routing
//   render-component.ts    rendering one component fiber
//   reconcile-children.ts  child diffing
//   context-propagation.ts provider-change propagation
//   begin-work.ts          render phase: per-tag beginWork handlers
//   complete-work.ts       render phase: host DOM creation / update
//   unwind.ts              throw handling (suspend / error capture)
//   commit.ts              the commit phases, deletion, Offscreen, passive effects
//   work-loop.ts           renderRoot + the concurrent render loop
//   root.ts                createRoot / hydrateRoot / flushSync / act

export { setDocument } from "./state.ts";
export {
  __pumpForTests,
  __setAsyncContextScoping,
  __setAsyncTransitionWarnMs,
  __setManualSlicingForTests,
  __setYieldEveryForTests,
} from "./scheduler.ts";
export {
  clearFiberProps,
  devRootFibers,
  fiberPropOverrides,
  overrideFiberProp,
  setCommitObserver,
  setDevIdForFiber,
  setRenderProfiler,
} from "./devtools-bridge.ts";
export { act, createPortal, createRoot, flushSync, hydrateRoot } from "./root.ts";
export type { RootOptions } from "./root.ts";
export type { Root } from "./root.ts";
