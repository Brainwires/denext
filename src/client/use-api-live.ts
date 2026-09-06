// `useApiLive` — `useApi` with tag invalidations delivered over the Live socket.
//
// Importing this (from `denext/live`) is what pulls the Live transport into an app that has no
// other Live feature; `useApi` itself never imports the socket. Any app that already configures
// Live gets the same behavior from plain `useApi({ tags })` (configureLive installs the source).

import { useApi } from "./use-api.ts";
import { setApiInvalidationSource } from "./use-api.ts";
import { subscribeLiveTags } from "./live-client.ts";

let installed = false;

/**
 * {@link useApi} whose `tags` refetch on a server-side `revalidateTag` — the Live socket
 * delivers the invalidation; the refetch itself is an ordinary HTTP call with the viewer's
 * cookies. Same signature and result as `useApi`.
 *
 * @param args The `useApi` arguments: path, method, opts, options.
 * @returns The `useApi` result.
 */
export function useApiLive(...args: Parameters<typeof useApi>): ReturnType<typeof useApi> {
  if (!installed) {
    installed = true;
    setApiInvalidationSource(subscribeLiveTags);
  }
  return useApi(...args);
}
