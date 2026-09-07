// `useApiLive` — `useApi` with tag invalidations delivered over the Live socket.
//
// Importing this (from `denext/live`) is what pulls the Live transport into an app that has no
// other Live feature; `useApi` itself never imports the socket, and the transport never imports
// the typed client (a `<Live>`-only bundle carries neither). Once any `useApiLive` has rendered,
// plain `useApi({ tags })` in the same app is wired too (the source is process-wide).

import {
  type ApiEndpointOf,
  setApiInvalidationSource,
  useApi,
  type UseApiOptions,
  type UseApiResult,
} from "./use-api.ts";
import { subscribeLiveTags } from "./live-client.ts";
import type {
  ErrorsOf,
  HttpMethod,
  RegisteredSchema,
  RequestOf,
  ResponseOf,
} from "../runtime/api-client.ts";

let installed = false;

/**
 * {@link useApi} whose `tags` refetch on a server-side `revalidateTag` — the Live socket
 * delivers the invalidation; the refetch itself is an ordinary HTTP call with the viewer's
 * cookies. Same signature and result as `useApi`.
 *
 * @param path The route pattern.
 * @param method The HTTP method the route exports.
 * @param opts Params / query / body for the call.
 * @param options Tags, suspense, enabled, client.
 * @returns The `useApi` result.
 */
export function useApiLive<
  P extends keyof RegisteredSchema & string,
  M extends keyof RegisteredSchema[P] & HttpMethod,
>(
  path: P,
  method: M,
  opts?: RequestOf<ApiEndpointOf<P, M>>,
  options?: UseApiOptions,
): UseApiResult<ResponseOf<ApiEndpointOf<P, M>>, ErrorsOf<ApiEndpointOf<P, M>>> {
  if (!installed) {
    installed = true;
    setApiInvalidationSource(subscribeLiveTags);
  }
  return useApi(path, method, opts, options);
}
