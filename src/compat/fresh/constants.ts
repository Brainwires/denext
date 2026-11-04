// Names the Fresh compat modules share between the server and the browser. Isomorphic.

/** The header that marks the response `ctx.next()` stands in for (the page denext renders). */
export const CONTINUE_HEADER = "x-denext-fresh-continue";

/** The query parameter Fresh's client navigation adds to a partial request. */
export const PARTIAL_SEARCH_PARAM = "fresh-partial";

/** The attribute that turns Fresh's client navigation on (or, `"false"`, off) for a subtree. */
export const CLIENT_NAV_ATTR = "f-client-nav";

/** The attribute naming the URL a link, button or form fetches its partials from. */
export const PARTIAL_ATTR = "f-partial";
