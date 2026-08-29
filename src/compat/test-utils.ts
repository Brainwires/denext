/**
 * React-compatible `react-dom/test-utils` entrypoint for denext.
 *
 * Aliased at bundle time so testing libraries that still import from
 * `react-dom/test-utils` resolve to denext's single React runtime. Only `act` is
 * provided — React 18 already moved `act` to the `react` package and React 19
 * removed the rest of the legacy `test-utils` surface (Simulate,
 * renderIntoDocument, findRenderedComponentWithType, …). Those removed members are
 * not re-exported here: a named import of one fails to resolve at bundle time, and a
 * namespace access reads `undefined`. Migrate to `act` (from `react`) plus a DOM
 * testing library.
 *
 * @module
 */

import { act } from "../client/mod.ts";

export { act };

/** The default `react-dom/test-utils` namespace object. */
export default { act };
