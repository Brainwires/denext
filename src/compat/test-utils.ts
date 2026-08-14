/**
 * React-compatible `react-dom/test-utils` entrypoint for denext.
 *
 * Aliased at bundle time so testing libraries that still import from
 * `react-dom/test-utils` resolve to denext's single React runtime. Only `act` is
 * provided — React 18 already moved `act` to the `react` package and React 19
 * removed the rest of the legacy `test-utils` surface (Simulate,
 * renderIntoDocument, findRenderedComponentWithType, …). Those removed members
 * throw a guided error rather than resolve to `undefined`.
 *
 * @module
 */

import { act } from "../client/mod.ts";

export { act };

/** The default `react-dom/test-utils` namespace object. */
export default { act };
