/**
 * The `client:*` directive props as one interface, for apps that type-check against
 * `@types/react` (a `tsc` run over a migrated app, whose JSX types are React's, not denext's).
 *
 * denext's own JSX types already admit the directives on every element. Under `@types/react`
 * they are unknown props until React's `Attributes` (the props every element accepts) is
 * extended with them, which an app does with a two-line `.d.ts` its type check includes (with
 * `deno check`, list it in `compilerOptions.types`):
 *
 * ```ts
 * // client-directives.d.ts
 * import type { ClientDirectives } from "denext/jsx-directives";
 * declare module "react" { interface Attributes extends ClientDirectives<import("react").ReactNode> {} }
 * ```
 *
 * The augmentation has to live in the app: a published module may not change another
 * package's types, so this module only declares the shape.
 *
 * @module
 */

/**
 * The `client:*` directive props: a Flight route's island hydration markers, and in SPA mode the
 * deferred mount of a code-split component. The build strips every `client:*` key before it
 * reaches the component or the DOM; they are authoring markers, not real props.
 *
 * @typeParam Placeholder What `client:placeholder` accepts: `ReactNode` under `@types/react`,
 * denext's `VNodeChild` in denext's own JSX types.
 */
export interface ClientDirectives<Placeholder = unknown> {
  /** Hydrate this client island eagerly, per-island (`client:load`). */
  "client:load"?: boolean;
  /** Hydrate when the main thread is idle (`client:idle`). */
  "client:idle"?: boolean;
  /** Hydrate when the island scrolls into view (`client:visible`). */
  "client:visible"?: boolean;
  /** Hydrate on first interaction — focus/pointer/keydown (`client:interaction`). */
  "client:interaction"?: boolean;
  /**
   * Hydrate when a CSS media query matches. The query is the attribute value:
   * `client:media="(min-width: 800px)"`. Bare `client:media` (boolean) is accepted
   * for symmetry but a query string is the useful form.
   */
  "client:media"?: boolean | string;
  /** Render on the client only, skipping SSR entirely (`client:only`). */
  "client:only"?: boolean;
  /**
   * SPA mode: what a `client:*` element renders until its trigger mounts the component
   * (and what `client:interaction` listens on). A Flight route ignores it: the island's
   * server HTML is its placeholder.
   */
  "client:placeholder"?: Placeholder;
}
