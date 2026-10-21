/**
 * # denext/action-call — a Flight page's Server Action call
 *
 * The generated Flight entry registers `import("denext/action-call")` as the Flight client's
 * action loader, so a page whose payload carries a Server Action reference loads it (the dispatch
 * and the wire encoder) on demand, and a page with none never does. App code does not import it.
 *
 * @module
 */

export { callAction } from "./client/action-call.ts";
