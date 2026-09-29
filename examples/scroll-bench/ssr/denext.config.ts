import type { DenextConfig } from "denext/server";

// The server-rendered side of the scroll benchmark: an App Router app (not SPA mode). Every
// route is a cell, `/list/<impl>?kind=…&n=…`; harness/ssr-measure.ts drives them.
export default {} satisfies DenextConfig;
