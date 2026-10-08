/**
 * # denext/spa-island — SPA mode's deferred mounts
 *
 * In SPA mode a `client:*` directive on a component element (`<Chart client:visible />`, the
 * same syntax as a Flight route's islands) defers the component's mount, and its module, until
 * the trigger: the build rewrites the element to {@linkcode SpaIsland} with a loader for the
 * component, and drops the component's static import when the directive elements are its only
 * use, so the module is its own chunk. Until then the element renders its `client:placeholder`
 * (or an empty element). See https://denext.dev/docs/islands.
 *
 * The build emits the import of this module; app code does not import it. An app that uses no
 * directive bundles none of it.
 *
 * @module
 */

export { SpaIsland, type SpaIslandLoader, type SpaIslandProps } from "./client/spa-island.ts";
