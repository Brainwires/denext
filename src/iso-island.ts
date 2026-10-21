/**
 * # denext/iso-island — isomorphic `client:*` islands
 *
 * On an isomorphic (non-Flight) route a `client:*` directive on a component element defers that
 * island's hydration to its strategy while the rest of the page hydrates as one tree (see
 * https://denext.dev/docs/islands). The build emits the imports of this module: the route entry's
 * {@linkcode installIsoIslands} when the app's sources write a directive, and the island
 * rewrite's {@linkcode isoIslandChunk} stand-in for a component split into its own chunk. App
 * code does not import it.
 *
 * It is its own entrypoint, not part of the generated entries' `denext/client-runtime` barrel:
 * the bundler places code by FILE, so a module the startup graph reaches through any static
 * import, even an unused re-export, and a lazily loaded chunk also uses ships in a chunk every
 * page loads. The island runtime shares its hydration scheduler with the Flight path's lazily
 * loaded `denext/lazy`, so the barrel's re-export put both into every Flight app's startup.
 *
 * @module
 */

export { installIsoIslands, isoIslandChunk } from "./client/iso-island.ts";
