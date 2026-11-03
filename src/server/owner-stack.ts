// `captureOwnerStack()` during a server render (development only): the server half of the
// owner stack the client fiber renderer keeps (src/client/owner-stack.ts).
//
// The server renderers walk elements, not fibers, so a component's render is a frame: its
// type, and the frame of the component that owns its element. An element's owner is the
// component rendering when a dev build's `jsxDEV` made it, else the component whose render
// result first holds it (its `children`, or an element-valued prop), since `h()` /
// `createElement` record nothing — the client's rule. The owner is kept per props object
// (the renderers hand a component its element's own props), so the element itself is never
// touched. The frame survives an `await` inside an async Server Component (AsyncLocalStorage).
//
// The stack is formatted as React 19 formats one — one `\n    at Name (location)` line per
// owner, nearest first, the calling component left out. The location is where the owner wrote
// the JSX of the element below it when `jsxDEV` recorded it; a server module compiled with
// `react-jsx` records none, so its frames carry the name only.
//
// The dev server installs it (`denext dev`); production `start` never does, so its render
// pays one global read per component and `captureOwnerStack()` returns `null` there.

import { AsyncLocalStorage } from "node:async_hooks";
import { componentDisplayName, REACT_ELEMENT_TYPE } from "../runtime/react-brands.ts";
import { SERVER_OWNERS, type ServerOwners } from "../jsx/server-owner.ts";

/** The `source` a dev build's `jsxDEV` passes: where the JSX was written. */
interface JsxSource {
  fileName?: string;
  lineNumber?: number;
  columnNumber?: number;
}

/** One component's render on the server. */
interface Frame {
  /** The component type, as the element names it (a memo / forwardRef wrapper included). */
  type: unknown;
  /** The frame of the component that owns this one's element (`null`: the root). */
  owner: Frame | null;
  /** Where the owner wrote this component's JSX, when `jsxDEV` recorded it. */
  source?: JsxSource;
}

/** An element's owner and JSX source, kept by its props object. */
interface Ownership {
  owner: Frame | null;
  source?: JsxSource;
}

/** How deep the stamp follows nested children (a pathological tree stays cheap). */
const MAX_STAMP_DEPTH = 64;
/** At most this many owners are listed (an owner cycle stays cheap). */
const MAX_OWNERS = 200;

function isElement(value: unknown): value is { props?: unknown } {
  return value !== null && typeof value === "object" &&
    (value as { $$typeof?: unknown }).$$typeof === REACT_ELEMENT_TYPE;
}

function isDev(): boolean {
  return (globalThis as { __denextDev?: boolean }).__denextDev === true;
}

function locationOf(src: JsxSource | undefined): string {
  if (!src || typeof src.fileName !== "string") return "";
  let loc = src.fileName;
  if (typeof src.lineNumber === "number") {
    loc += `:${src.lineNumber}`;
    if (typeof src.columnNumber === "number") loc += `:${src.columnNumber}`;
  }
  return ` (${loc})`;
}

/**
 * The owner stack of `frame`: a `\n    at Name (location)` line per owner, nearest first.
 *
 * @param frame The rendering component's frame.
 * @returns The stack (`""` for a component with no owner).
 */
function formatStack(frame: Frame): string {
  let out = "";
  const seen = new Set<Frame>();
  for (let f = frame; f.owner && !seen.has(f.owner) && seen.size < MAX_OWNERS;) {
    seen.add(f.owner);
    out += `\n    at ${componentDisplayName(f.owner.type)}${locationOf(f.source)}`;
    f = f.owner;
  }
  return out;
}

/** Build the implementation the renderers reach through {@linkcode SERVER_OWNERS}. */
function createServerOwners(): ServerOwners {
  const storage = new AsyncLocalStorage<Frame>();
  const owned = new WeakMap<object, Ownership>();

  const stampNode = (node: unknown, owner: Frame, depth: number): void => {
    if (depth > MAX_STAMP_DEPTH) return;
    if (Array.isArray(node)) {
      for (const child of node) stampNode(child, owner, depth + 1);
      return;
    }
    if (isElement(node)) stampProps(node.props, owner, depth);
  };

  // An element's props: owned by `owner`, and so are the elements among them (once per props).
  const stampProps = (props: unknown, owner: Frame, depth: number): void => {
    if (props === null || typeof props !== "object" || owned.has(props)) return;
    owned.set(props, { owner });
    const record = props as Record<string, unknown>;
    stampNode(record.children, owner, depth + 1);
    for (const key in record) {
      if (key !== "children" && isElement(record[key])) stampNode(record[key], owner, depth + 1);
    }
  };

  return {
    invoke(type, props, run) {
      if (!isDev()) return run();
      const of = owned.get(props);
      const frame: Frame = { type, owner: of?.owner ?? null, source: of?.source };
      return storage.run(frame, () => {
        const out = run();
        if (out instanceof Promise) {
          return out.then((v) => {
            stampNode(v, frame, 0);
            return v;
          });
        }
        stampNode(out, frame, 0);
        return out;
      });
    },
    carry(from, to) {
      const of = owned.get(from);
      if (of) owned.set(to, of);
    },
    capture() {
      if (!isDev()) return null;
      const frame = storage.getStore();
      return frame === undefined ? null : formatStack(frame);
    },
    record(el, source) {
      if (!isDev()) return;
      const frame = storage.getStore();
      const props = (el as { props?: unknown }).props;
      if (frame === undefined || props === null || typeof props !== "object") return;
      owned.set(props, {
        owner: frame,
        source: source && typeof source === "object" ? source as JsxSource : undefined,
      });
    },
  };
}

/**
 * Install (`true`) or remove (`false`) `captureOwnerStack()` for the server renderers — the
 * string, streaming, Flight and PPR passes alike. `denext dev` installs it; it still acts only
 * while `globalThis.__denextDev` is set.
 *
 * @param on Install (default) or remove.
 */
export function installServerOwnerStack(on = true): void {
  const g = globalThis as { [SERVER_OWNERS]?: ServerOwners };
  if (!on) delete g[SERVER_OWNERS];
  else g[SERVER_OWNERS] ??= createServerOwners();
}
