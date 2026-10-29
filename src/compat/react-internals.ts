/**
 * React's shared internals, for renderers built on `react-reconciler`.
 *
 * A custom React renderer (`react-reconciler`: React Native Skia's `<Canvas>`, react-three-fiber,
 * react-konva, ink, react-pdf) brings its own fiber tree. It reads React's
 * `__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE` object when it loads, and while
 * it renders a component it puts its hooks dispatcher in `H`, so the `useState` / `useEffect` /
 * `useContext` the component imported from `react` run against ITS fiber. denext's `react` exports
 * the same object, and its hooks hand the call to `H` whenever denext itself is not rendering
 * (after its first render a renderer leaves a dispatcher in `H` that throws on any hook call).
 *
 * Fields (React 19): `H` the hooks dispatcher, `A` the async dispatcher (`cache`), `T` the current
 * transition, `S` the start-transition callback a renderer chains onto, and the development
 * fields a development build reads (`actQueue` and the rest). denext's own renderer uses none of
 * them.
 *
 * Context crosses into such a renderer's tree the way it does in React. A renderer recognizes a
 * provider by an element type that is React's context object (`$$typeof: react.context`), and
 * reads a context's value from that object's `_currentValue2` (its `isPrimaryRenderer: false`
 * slot), which it sets while a provider renders. denext's context is a function (it is its own
 * provider component), so each one gets a React-shaped twin (`reactContextOf`): a hook
 * the foreign renderer handles gets the twin, and a denext provider a foreign renderer calls
 * returns an element of the twin. Contexts from the denext tree around the renderer's root cross
 * the way React apps carry them: react-three-fiber's `<Canvas>`, react-konva's `<Stage>` and
 * its-fine's `useContextBridge()` walk React's fiber tree from a class component's
 * `this._reactInternals` for the providers above them, and re-provide their values inside the
 * root. A denext class instance answers `_reactInternals` with a read-only, React-shaped view of
 * its fiber (`FiberView`).
 *
 * @module
 */

// Side-effect: the un-bundled default for the bare `__DENEXT_CLASS_COMPONENTS__` read below.
import "../runtime/class-flag.ts";
import { type Context, rendering } from "../runtime/hooks.ts";
import { FOREIGN_PROVIDER } from "../runtime/context.ts";
import { REACT_ELEMENT_TYPE } from "../runtime/react-brands.ts";
import { Component, internals } from "./class-base.ts";
// Type only: the view reads the client fiber's fields, and imports nothing of the reconciler.
import type { Fiber } from "../client/fiber/fiber.ts";

/** A hooks dispatcher a foreign renderer installs (`useState`, `useEffect`, …). */
// deno-lint-ignore no-explicit-any
export type ReactDispatcher = Record<string, (...args: any[]) => any>;

/** The shared-internals object a `react-reconciler` build reads from `react`. */
export interface ReactSharedInternals {
  /** The hooks dispatcher while a foreign renderer renders a component, else null. */
  H: ReactDispatcher | null;
  /** The async dispatcher (`getCacheForType`, `getOwner`), set by a foreign renderer. */
  A: unknown;
  /** The current transition, set by a foreign renderer's `startTransition`. */
  T: unknown;
  /** The start-transition callback a renderer chains onto. */
  S: ((transition: unknown, returnValue: unknown) => void) | null;
  /**
   * React's development fields, which a development build of `react-reconciler` (what
   * `denext dev` loads) reads: `act()`'s queue (null outside `act`, else it queues every render
   * there) and its bookkeeping, the errors `act` rethrows, and the component-stack getter.
   */
  actQueue: unknown[] | null;
  /** Development: legacy-root batching inside `act`. */
  isBatchingLegacy: boolean;
  /** Development: a legacy update was scheduled inside `act`. */
  didScheduleLegacyUpdate: boolean;
  /** Development: a component suspended with `use` inside `act`. */
  didUsePromise: boolean;
  /** Development: the errors `act` collects to rethrow. */
  thrownErrors: unknown[];
  /** Development: the current component stack, set by a renderer. */
  getCurrentStack: (() => string) | null;
}

/** The one shared-internals object (React keeps one per `react` instance). */
export const sharedInternals: ReactSharedInternals = {
  H: null,
  A: null,
  T: null,
  S: null,
  actQueue: null,
  isBatchingLegacy: false,
  didScheduleLegacyUpdate: false,
  didUsePromise: false,
  thrownErrors: [],
  getCurrentStack: null,
};

/**
 * Wrap one of denext's hooks so that, while a foreign renderer's dispatcher is installed, the call
 * goes to that dispatcher's hook of the same name (as React's own `useState` does).
 *
 * @param name The hook's name on React's dispatcher.
 * @param own denext's hook.
 * @returns The hook React code imports.
 */
// deno-lint-ignore no-explicit-any
export function dispatched<F extends (...args: any[]) => any>(name: string, own: F): F {
  // `use` / `useContext` take a context: the foreign renderer reads its React twin, denext the
  // denext context behind a twin (its-fine reads one with `use` while denext renders).
  const readsContext = name === "use" || name === "useContext";
  const hook = function (this: unknown, ...args: Parameters<F>): ReturnType<F> {
    // React leaves its "context only" dispatcher in `H` between renders (a hook called there
    // throws), so `H` alone does not say a foreign renderer is rendering: denext's own render
    // (its dispatcher installed) always takes denext's hooks.
    const foreign = rendering() ? undefined : sharedInternals.H?.[name];
    if (readsContext) args[0] = foreign ? reactContextOf(args[0]) : denextContextOf(args[0]);
    return foreign ? foreign(...args) : own.apply(this, args);
  };
  Object.defineProperty(hook, "name", { value: own.name || name });
  return hook as unknown as F;
}

/** React's context object, as a `react-reconciler` renderer reads and provides it. */
interface ReactContext {
  /** `Symbol.for("react.context")`: an element of this type is a provider. */
  $$typeof: symbol;
  /** The value a primary renderer reads (it sets it while a provider renders). */
  _currentValue: unknown;
  /** The value a secondary renderer (`isPrimaryRenderer: false`) reads. */
  _currentValue2: unknown;
  /** React's concurrent-render counter. */
  _threadCount: number;
  /** React 19: the context is its own provider. */
  Provider: ReactContext;
  /** The render-prop consumer type. */
  Consumer: { $$typeof: symbol; _context: ReactContext };
  /** Shown by React DevTools. */
  displayName?: string;
}

/** Where a denext context keeps its twin, and a twin its denext context (registry symbols, so
 * two copies of this module agree). */
const TWIN: unique symbol = Symbol.for("denext.reactContext");
const OWNER: unique symbol = Symbol.for("denext.reactContextOwner");

/** Whether `value` is a denext context (a function carrying its symbol id). */
function isDenextContext(value: unknown): value is Context<unknown> {
  return typeof value === "function" && typeof (value as { _id?: unknown })._id === "symbol";
}

/**
 * The React-shaped twin of a denext context, created on first use; any other value as is. A
 * foreign renderer provides and reads a context through this object.
 *
 * @param value A denext context, or anything else.
 * @returns The context's twin, or `value` unchanged.
 */
function reactContextOf(value: unknown): unknown {
  if (!isDenextContext(value)) return value;
  const held = value as unknown as { [TWIN]?: ReactContext };
  const existing = held[TWIN];
  if (existing) return existing;
  const fallback = value._defaultValue;
  const twin = {
    $$typeof: Symbol.for("react.context"),
    _currentValue: fallback,
    _currentValue2: fallback,
    _threadCount: 0,
    displayName: (value as { displayName?: string }).displayName,
  } as ReactContext;
  twin.Provider = twin;
  twin.Consumer = { $$typeof: Symbol.for("react.consumer"), _context: twin };
  Object.defineProperty(twin, OWNER, { value });
  Object.defineProperty(value, TWIN, { value: twin });
  return twin;
}

/** The denext context behind a twin; any other value as is. */
function denextContextOf(value: unknown): unknown {
  return (value as { [OWNER]?: unknown } | null)?.[OWNER] ?? value;
}

/**
 * React's view of one denext fiber, the fields its-fine and react-three-fiber read off
 * `this._reactInternals`: the tree links, the element `type` (a provider's is its context's
 * twin), the props, the host node or class instance, and the hook list (`memoizedState` →
 * `next`, each hook's value in its own `memoizedState`). Read-only and computed on access, so it
 * always shows the fiber's present state. One view per fiber, so a view is a stable value.
 */
class FiberView {
  /** The fiber shown. */
  readonly #fiber: Fiber;

  /** @param fiber The fiber shown. */
  constructor(fiber: Fiber) {
    this.#fiber = fiber;
  }

  /**
   * The element type. A denext provider's is its context's twin, as React's provider fiber's
   * type is the context; one providing a fiber view (its-fine's own `FiberContext`, which a
   * bridge must not carry into another tree, as React's identity check keeps it out) stays the
   * provider function.
   */
  get type(): unknown {
    const type = this.#fiber.vnode?.type;
    const value = (this.#fiber.vnode?.props as { value?: unknown } | undefined)?.value;
    return isDenextContext(type) && !(value instanceof FiberView) ? reactContextOf(type) : type;
  }
  /** The element type (React keeps both). */
  get elementType(): unknown {
    return this.type;
  }
  /** The element's key. */
  get key(): unknown {
    return this.#fiber.vnode?.key ?? null;
  }
  /** The element's props. */
  get memoizedProps(): unknown {
    return this.#fiber.vnode?.props;
  }
  /** The element's props (React's in-progress copy; the same here). */
  get pendingProps(): unknown {
    return this.memoizedProps;
  }
  /** A class component's instance, the host node, or at the root React's `{ containerInfo }`. */
  get stateNode(): unknown {
    const fiber = this.#fiber;
    if (fiber.tag === "root") return { containerInfo: fiber.stateNode };
    return fiber.ext?.classInstance ?? fiber.stateNode;
  }
  /** A class component's state, else the first hook (`{ memoizedState, next }`) or null. */
  get memoizedState(): unknown {
    const instance = this.#fiber.ext?.classInstance as { state?: unknown } | undefined;
    if (instance) return instance.state;
    let list: { memoizedState: unknown; next: unknown } | null = null;
    const hooks = this.#fiber.hooks ?? [];
    for (let i = hooks.length - 1; i >= 0; i--) {
      list = { memoizedState: hooks[i].value, next: list };
    }
    return list;
  }
  /** The first child's view. */
  get child(): FiberView | null {
    return viewOf(this.#fiber.child);
  }
  /** The next sibling's view. */
  get sibling(): FiberView | null {
    return viewOf(this.#fiber.sibling);
  }
  /** The parent's view. */
  get return(): FiberView | null {
    return viewOf(this.#fiber.return);
  }
  /** The other buffer's view. */
  get alternate(): FiberView | null {
    return viewOf(this.#fiber.alternate);
  }
}

/** One view per fiber. */
const views = new WeakMap<Fiber, FiberView>();

/** `fiber`'s view (null for none). */
function viewOf(fiber: Fiber | null | undefined): FiberView | null {
  if (!fiber) return null;
  let view = views.get(fiber);
  if (!view) views.set(fiber, view = new FiberView(fiber));
  return view;
}

// A denext provider (or `.Consumer`) a foreign renderer calls renders an element of its twin (or
// of the twin's consumer), which the renderer provides (reads) as a React context (context.ts).
(globalThis as { [FOREIGN_PROVIDER]?: unknown })[FOREIGN_PROVIDER] = (
  context: Context<unknown>,
  props: unknown,
  consumer: boolean,
) => {
  const twin = reactContextOf(context) as ReactContext;
  return { $$typeof: REACT_ELEMENT_TYPE, type: consumer ? twin.Consumer : twin, props, key: null };
};

if (__DENEXT_CLASS_COMPONENTS__) {
  // `this._reactInternals`: the instance's fiber, as React's view of it (undefined during a
  // server render, which has no fiber). A foreign renderer that renders the class sets its own
  // fiber here, which then shadows the accessor.
  Object.defineProperty(Component.prototype, "_reactInternals", {
    configurable: true,
    get(this: Component): FiberView | undefined {
      return viewOf(internals(this)?.inst as unknown as Fiber) ?? undefined;
    },
    set(this: Component, fiber: unknown) {
      Object.defineProperty(this, "_reactInternals", {
        value: fiber,
        writable: true,
        configurable: true,
      });
    },
  });
}
