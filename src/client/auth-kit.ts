/**
 * The client-side core internal `@denext/auth`'s `next-auth/react` compat uses: the in-process
 * API dispatcher a server render calls `/api` routes through. Like `denext/auth-kit`, it moves
 * with this denext version and is **not** a stable API.
 *
 * @module
 */

export { getApiDispatcher } from "../runtime/api-dispatch.ts";
export type { ApiDispatcher, ApiDispatchInit } from "../runtime/api-dispatch.ts";
