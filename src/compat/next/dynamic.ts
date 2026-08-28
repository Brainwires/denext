/**
 * `next/dynamic` compat — denext's `dynamic()` as the default export.
 * @module
 */
import { dynamic } from "../../../mod.ts";
import type { DynamicLoader, DynamicOptions } from "../../runtime/dynamic.ts";
import type { Component } from "../../jsx/types.ts";

export { dynamic as default };
export type { DynamicOptions } from "../../../mod.ts";

/**
 * `next/dynamic`'s `noSSR` helper — a {@linkcode dynamic} import that never renders on the
 * server (equivalent to `dynamic(loader, { ssr: false })`). Exposed because some code (and
 * Next internals) import it directly.
 *
 * @param loader Returns the dynamic import (its `default` is the component).
 * @param options Rendering options (`ssr` is forced to `false`).
 * @returns A client-only component.
 */
export function noSSR<P = Record<string, unknown>>(
  loader: DynamicLoader<P>,
  options?: DynamicOptions<P>,
): Component<P> {
  return dynamic(loader, { ...options, ssr: false });
}
