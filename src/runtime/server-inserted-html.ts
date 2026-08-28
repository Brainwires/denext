/**
 * `useServerInsertedHTML` — the CSS-in-JS SSR style-injection hook (styled-components,
 * emotion, …). During a server render the callback is registered with the active
 * {@link ../jsx/render-to-string.ts renderToString} pass; after the tree renders, the
 * callbacks run and their returned markup (typically collected `<style>` tags) is placed
 * in `<head>`. On the client there is no active render sink, so the hook is a no-op —
 * hydration reuses the server-inserted styles already in the document.
 *
 * The sink is read straight off `globalThis` (a `Symbol.for` singleton set by the
 * renderer) rather than importing the renderer, so this module stays lightweight and
 * client-safe (it never pulls the SSR string renderer into a browser bundle). Mirrors
 * the `renderToString` sink; keep the Symbol in sync with it.
 * @module
 */
import type { VNodeChildren } from "../jsx/types.ts";

const INSERT_SINK_KEY = Symbol.for("denext.serverInsertSink");
interface SinkHolder {
  [INSERT_SINK_KEY]?: ((cb: () => VNodeChildren) => void) | null;
}

/**
 * Register a callback whose returned markup is inserted into the server-rendered
 * `<head>`. No-op on the client. Matches Next's `useServerInsertedHTML` from
 * `next/navigation`.
 */
export function useServerInsertedHTML(callback: () => VNodeChildren): void {
  (globalThis as SinkHolder)[INSERT_SINK_KEY]?.(callback);
}
