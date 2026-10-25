/**
 * `denext/fresh/runtime` — Fresh's `fresh/runtime` (and 1.x `$fresh/runtime.ts`) on denext, for
 * server components and islands alike: `Head`, `asset`, `assetSrcSet`, `IS_BROWSER`, `Partial`,
 * `HttpError`, and 1.x's content-security-policy helpers.
 *
 * `<Head>` renders its children in place: denext hoists `<title>`, `<meta>` and `<link>` into the
 * document head. `<Partial>` is a region Fresh's client navigation (`f-client-nav`, `f-partial`)
 * updates in place (see `denext/fresh/partial`). `asset()` returns the path unchanged (denext
 * fingerprints its own bundles; files in `public/` are served as they are).
 *
 * @module
 */

import { Fragment, h } from "../../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../../jsx/types.ts";

export { HttpError } from "./http-error.ts";
export { Partial, type PartialMode, type PartialProps } from "./partial.ts";

/** True in the browser, false while rendering on the server. */
export const IS_BROWSER: boolean = typeof document !== "undefined";

/**
 * A static asset's URL (Fresh adds a cache-busting query; denext serves `public/` as is).
 *
 * @param path The asset path.
 * @returns The path.
 */
export function asset(path: string): string {
  return path;
}

/**
 * A `srcset` with each URL passed through {@link asset}.
 *
 * @param srcset The `srcset` value.
 * @returns The `srcset`.
 */
export function assetSrcSet(srcset: string): string {
  return srcset;
}

/** Props of {@link Head}. */
export interface HeadProps {
  /** Head elements: `<title>`, `<meta>`, `<link>`, … */
  children?: VNodeChildren;
}

/**
 * Elements for the document head. They render in place and denext hoists `<title>`, `<meta>`
 * and `<link>` into `<head>` (a later `<title>` wins, as with Fresh's `<Head>`).
 *
 * @param props The head elements.
 * @returns The elements.
 */
export function Head(props: HeadProps): VNode {
  return h(Fragment, null, props.children);
}

// ── Fresh 1.x content-security-policy helpers (denext applies its own `csp` config) ─────────

/** `'self'`. */
export const SELF = "'self'";
/** `'unsafe-inline'`. */
export const UNSAFE_INLINE = "'unsafe-inline'";
/** `'unsafe-eval'`. */
export const UNSAFE_EVAL = "'unsafe-eval'";
/** `'unsafe-hashes'`. */
export const UNSAFE_HASHES = "'unsafe-hashes'";
/** `'none'`. */
export const NONE = "'none'";
/** `'strict-dynamic'`. */
export const STRICT_DYNAMIC = "'strict-dynamic'";

/**
 * A `'nonce-…'` source.
 *
 * @param val The nonce.
 * @returns The source expression.
 */
export function nonce(val: string): string {
  return `'nonce-${val}'`;
}

/** Fresh 1.x's per-render policy object. */
export interface ContentSecurityPolicy {
  /** The directives. */
  directives: Record<string, string[] | string | boolean | undefined>;
  /** Report-only. */
  reportOnly: boolean;
}

/**
 * Fresh 1.x's `useCSP`: denext builds the policy from the `csp` config key, so the mutator is
 * not called (set the directives there instead).
 *
 * @param _mutator Would edit the page's policy.
 */
export function useCSP(_mutator: (csp: ContentSecurityPolicy) => void): void {}
