/**
 * `next/router` compat for libraries: the Pages Router API, which an App Router app does not
 * mount. A library that supports both routers imports it (`@clerk/nextjs`'s Pages Router
 * provider) and only calls it when `next/compat/router` reports a Pages Router — never, on
 * denext's App Router. Calling {@linkcode useRouter} throws Next's own "not mounted" error;
 * importing the module (and reading `Router.events`) is harmless. A Pages Router app gets the
 * real thing from the `@denext/pages-router` plugin (`denext migrate` maps `next/router` there).
 *
 * @module
 */

/** Next's message when the Pages Router is used where none is mounted. */
const NOT_MOUNTED =
  "NextRouter was not mounted. https://nextjs.org/docs/messages/next-router-not-mounted";

/**
 * `next/router`'s `useRouter`: throws, as Next does under the App Router.
 *
 * @returns Never.
 */
export function useRouter(): never {
  return notMounted();
}

/** Throw Next's "not mounted" error. */
function notMounted(): never {
  throw new Error(NOT_MOUNTED);
}

/**
 * `next/router`'s `withRouter`: a component that calls {@linkcode useRouter} when rendered.
 *
 * @param Component The wrapped component.
 * @returns The wrapper (throws when rendered).
 */
export function withRouter<P>(Component: (props: P & { router: never }) => unknown) {
  return (props: P): unknown => Component({ ...props, router: notMounted() });
}

/** A no-op event emitter (`Router.events.on("routeChangeStart", …)` at module scope). */
const events = { on() {}, off() {}, emit() {} };

/** The `Router` singleton: its events are inert; navigating throws "not mounted". */
const Router: {
  readonly events: typeof events;
  push(...args: unknown[]): never;
  replace(...args: unknown[]): never;
  back(): never;
  reload(): never;
  prefetch(...args: unknown[]): Promise<void>;
} = {
  events,
  push: () => notMounted(),
  replace: () => notMounted(),
  back: () => notMounted(),
  reload: () => notMounted(),
  prefetch: () => Promise.resolve(),
};

export default Router;
