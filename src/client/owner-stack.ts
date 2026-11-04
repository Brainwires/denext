// `captureOwnerStack()` for the client fiber renderer (development only).
//
// The owner chain is the one the DevTools panel shows (`getOwnerStack` in
// ./devtools-inspect.ts), nearest first: React's JSX-owner chain — the component whose render
// created each element. A dev build's `jsxDEV` records the rendering component and the JSX's
// source on the element (through the recorder this module installs); an element made by
// `h()` / `createElement` is given its owner when a render returns it: the component whose
// render result first holds it (its `children`, or an element-valued prop) owns it, since `h()`
// itself records nothing — it is the production path too. An element that never passed through
// a render (the root) has none, and the chain ends there.
// It is formatted the way React 19 formats an owner stack — one `\n    at Name (location)`
// line per owner, the component calling `captureOwnerStack()` itself not included — so code
// that logs or parses React's string reads this one the same way. The location is where the
// owner wrote the JSX of the next element down when `jsxDEV` recorded it, else where the
// component was declared (the Fast Refresh family registry and the dev metadata pass); a
// component neither knows prints as `\n    at Name`.
//
// Installed on the client dispatcher by the dev path only (`installDevRender`, which the dev
// entries and `denext/testing` call), so a production bundle never contains it and the
// public `captureOwnerStack()` returns `null` there, as React's does.

import type { Fiber } from "./fiber/fiber.ts";
import { componentDisplayName } from "../runtime/react-brands.ts";
import { familyIdOf } from "./refresh-runtime.ts";
import { componentMetaOf } from "./devtools-meta.ts";
import { clientDispatcher, currentFiber } from "./fiber/hooks-dispatcher.ts";
import { devHydrationActive } from "./fiber/fiber-utils.ts";
import { installRenderOwners } from "./fiber/render-component.ts";
import { REACT_ELEMENT_TYPE } from "../runtime/react-brands.ts";

/** Where a component was declared — the build-time position behind the panel's source link. */
export interface SourceLocation {
  /** The declaring module's URL (`file:///…/app/page.tsx`), cache-buster stripped. */
  file: string;
  /** 1-based line of the declaration, when the dev metadata pass instrumented it. */
  line?: number;
  /** 1-based UTF-16 column of the declaration, when known. */
  column?: number;
  /** The binding the component is registered under (the family id's `#` suffix). */
  export?: string;
}

/**
 * A component's source location: its module + export from the Fast Refresh family
 * registry, overlaid with the line/column the dev metadata pass recorded for the
 * declaration. Line/column are absent when the module wasn't instrumented.
 *
 * @param type The component type.
 * @returns The location, or `undefined` when the registry doesn't know the component.
 */
export function sourceOf(type: unknown): SourceLocation | undefined {
  const fam = familyIdOf(type);
  if (!fam) return undefined;
  const hash = fam.lastIndexOf("#");
  const loc: SourceLocation = {
    file: (hash >= 0 ? fam.slice(0, hash) : fam).replace(/\?[^#]*$/, ""),
  };
  const exp = hash >= 0 ? fam.slice(hash + 1) : "";
  if (exp) loc.export = exp;
  const meta = componentMetaOf(type);
  if (meta) {
    loc.line = meta.line;
    loc.column = meta.column;
  }
  return loc;
}

/** The `source` a dev build's `jsxDEV` passes: where the JSX was written. */
interface JsxSource {
  fileName?: string;
  lineNumber?: number;
  columnNumber?: number;
}

/** An element as a dev build's `jsxDEV` leaves it: its owner and its JSX source. */
interface OwnedElement {
  /** The component fiber that rendered when the element was made (`null`: outside a render). */
  _owner?: Fiber | null;
  /** Where the element's JSX was written. */
  _source?: JsxSource | null;
}

/** The `jsxDEV` recorder's registry slot (the runtime reads the same symbol). */
const JSX_DEV = Symbol.for("denext.jsxDev");

/**
 * Note an element's owner (the component rendering now) and its JSX source — non-enumerable,
 * so props spreading, `JSON.stringify` and equality checks over an element never see them.
 */
function recordElement(el: object, source: unknown): void {
  if (!devHydrationActive()) return;
  Object.defineProperty(el, "_owner", { value: currentFiber, configurable: true });
  if (source && typeof source === "object") {
    Object.defineProperty(el, "_source", { value: source, configurable: true });
  }
}

/** How deep {@linkcode stampOwners} follows nested children (a pathological tree stays cheap). */
const MAX_STAMP_DEPTH = 64;

/**
 * Record `owner` on each element of a render result that has none yet — the ones this render
 * made with `h()` / `createElement` — following `children` and element-valued props. An
 * element that already has one (`jsxDEV` recorded it, or the render that made it passed it on
 * as a prop) is left as it is, and so is what is below it.
 */
function stampOwners(result: unknown, owner: Fiber): void {
  if (devHydrationActive()) stampNode(result, owner, 0);
}

function stampNode(node: unknown, owner: Fiber, depth: number): void {
  if (depth > MAX_STAMP_DEPTH) return;
  if (Array.isArray(node)) {
    for (const child of node) stampNode(child, owner, depth + 1);
  } else if (isElement(node) && !("_owner" in node) && claim(node, owner)) {
    stampProps((node as { props?: unknown }).props, owner, depth + 1);
  }
}

/** Record `owner` on `el`; false for a frozen element (it keeps the render-parent fallback). */
function claim(el: object, owner: Fiber): boolean {
  try {
    Object.defineProperty(el, "_owner", { value: owner, configurable: true });
    return true;
  } catch {
    return false;
  }
}

/** Stamp an element's `children` and its element-valued props. */
function stampProps(props: unknown, owner: Fiber, depth: number): void {
  if (props === null || typeof props !== "object") return;
  const record = props as Record<string, unknown>;
  stampNode(record.children, owner, depth);
  for (const key in record) {
    if (key !== "children" && isElement(record[key])) stampNode(record[key], owner, depth);
  }
}

function isElement(value: unknown): value is object {
  return value !== null && typeof value === "object" &&
    (value as { $$typeof?: unknown }).$$typeof === REACT_ELEMENT_TYPE;
}

/** A JSX source as a location (`fileName` as the dev build wrote it: a path or a URL). */
function jsxLocation(src: JsxSource | null | undefined): SourceLocation | undefined {
  if (!src || typeof src.fileName !== "string") return undefined;
  const loc: SourceLocation = { file: src.fileName };
  if (typeof src.lineNumber === "number") loc.line = src.lineNumber;
  if (typeof src.columnNumber === "number") loc.column = src.columnNumber;
  return loc;
}

/** One component in an owner chain, nearest first. */
export interface OwnerFrame {
  /** The owner's component fiber. */
  fiber: Fiber;
  /**
   * Where the owner wrote the JSX of the element below it in the chain, when a dev build's
   * `jsxDEV` recorded it (absent on the render-parent fallback).
   */
  callSite?: SourceLocation;
}

/** At most this many owners are listed (an owner cycle or a pathological tree stays cheap). */
const MAX_OWNERS = 200;

/**
 * The owner chain of `fiber`, nearest first: the JSX owners when its element came from a dev
 * build's `jsxDEV` (each frame with the call site of the element below it), else the
 * component fibers above it.
 *
 * @param fiber A component fiber.
 * @returns The owners.
 */
export function ownerFrames(fiber: Fiber): OwnerFrame[] {
  const first = fiber.vnode as OwnedElement;
  if (!("_owner" in first)) return renderParents(fiber);
  const out: OwnerFrame[] = [];
  const seen = new Set<Fiber>();
  for (let el: OwnedElement = first; el._owner && out.length < MAX_OWNERS;) {
    const owner = el._owner;
    if (seen.has(owner)) break;
    seen.add(owner);
    out.push({ fiber: owner, callSite: jsxLocation(el._source) });
    el = owner.vnode as OwnedElement;
  }
  return out;
}

/** The component fibers above `fiber`, nearest first (the owner chain without `jsxDEV`). */
function renderParents(fiber: Fiber): OwnerFrame[] {
  const out: OwnerFrame[] = [];
  for (let f = fiber.return; f !== null; f = f.return) {
    if (f.tag === "component") out.push({ fiber: f });
  }
  return out;
}

/** One stack frame's location, `file:line:column` as far as it is known. */
function frameLocation(loc: SourceLocation): string {
  if (loc.line === undefined) return loc.file;
  return loc.column === undefined
    ? `${loc.file}:${loc.line}`
    : `${loc.file}:${loc.line}:${loc.column}`;
}

/**
 * The owner stack of `fiber`, formatted as React 19's `captureOwnerStack()` returns it: a
 * `\n    at Name (location)` line per component above it, nearest first.
 *
 * @param fiber The rendering component's fiber.
 * @returns The stack (`""` for a component with no owner).
 */
function formatOwnerStack(fiber: Fiber): string {
  let out = "";
  for (const { fiber: owner, callSite } of ownerFrames(fiber)) {
    const type = owner.vnode.type;
    const loc = callSite ?? sourceOf(type);
    out += `\n    at ${componentDisplayName(type)}${loc ? ` (${frameLocation(loc)})` : ""}`;
  }
  return out;
}

/** The dispatcher method: the rendering component's owner stack, or `null` outside a render. */
function captureRenderOwnerStack(): string | null {
  if (!devHydrationActive()) return null;
  const fiber = currentFiber;
  return fiber === null ? null : formatOwnerStack(fiber);
}

/**
 * Install (`true`) or remove (`false`) `captureOwnerStack()` on the client dispatcher, and the
 * recorder a dev build's `jsxDEV` hands each element to (its owner and JSX source). Called
 * from the dev path only (`installDevRender`), so a production bundle never contains it; both
 * still act only while `__denextDev` is set.
 *
 * @param on Install (default) or remove.
 */
export function installOwnerStack(on = true): void {
  const d = clientDispatcher as { captureOwnerStack?: () => string | null };
  const g = globalThis as { [JSX_DEV]?: (el: object, source: unknown) => void };
  if (on) {
    d.captureOwnerStack = captureRenderOwnerStack;
    g[JSX_DEV] = recordElement;
  } else {
    delete d.captureOwnerStack;
    delete g[JSX_DEV];
  }
  installRenderOwners(on ? stampOwners : null);
}
