// `captureOwnerStack()` for the client fiber renderer (development only).
//
// The owner chain is the one the DevTools panel shows (`getOwnerStack` in
// ./devtools-inspect.ts): the component fibers above the one rendering, nearest first.
// It is formatted the way React 19 formats an owner stack — one `\n    at Name (location)`
// line per owner, the component calling `captureOwnerStack()` itself not included — so code
// that logs or parses React's string reads this one the same way. The location is where the
// component was declared, from the Fast Refresh family registry and the dev metadata pass;
// a component they don't know prints as `\n    at Name`.
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
  for (let f = fiber.return; f !== null; f = f.return) {
    if (f.tag !== "component") continue;
    const type = f.vnode.type;
    const loc = sourceOf(type);
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
 * Install (`true`) or remove (`false`) `captureOwnerStack()` on the client dispatcher. Called
 * from the dev path only (`installDevRender`), so a production bundle never contains it; it
 * still answers only while `__denextDev` is set.
 *
 * @param on Install (default) or remove.
 */
export function installOwnerStack(on = true): void {
  const d = clientDispatcher as { captureOwnerStack?: () => string | null };
  if (on) d.captureOwnerStack = captureRenderOwnerStack;
  else delete d.captureOwnerStack;
}
