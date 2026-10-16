// The HTTP side every Live replica script shares (tests/helpers/live-redis-instance.ts,
// tests/helpers/live-view-instance.ts): serve the Live socket and the script's own routes on a
// free port, then print `{"port": N}` for the parent to read.

import { handleLiveUpgrade } from "../../src/server/live.ts";

/**
 * Serve a replica.
 *
 * @param route The script's own routes: a response, or `null` for a 404.
 */
export function serveLiveReplica(route: (url: URL) => Promise<Response | null>): void {
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (req) => {
    const u = new URL(req.url);
    if (u.pathname === "/_denext/live") return handleLiveUpgrade(req);
    return await route(u) ?? new Response("not found", { status: 404 });
  });
  console.log(JSON.stringify({ port: (server.addr as Deno.NetAddr).port }));
}
