// `denext ui` / `denext dashboard` ask the running app's admin endpoint with the backend's secret
// key (`apikey`). fetch forwards a custom header across a cross-origin redirect (only
// `Authorization` is dropped), so a redirect the app answers — a canonical-host middleware, an
// auth redirect — must never be followed: the key would reach the other host. Real servers, real
// fetch.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { adminStatus, appProbe } from "../packages/ui/src/app-admin.ts";

/** A loopback server for the test's lifetime. */
function serve(handler: (req: Request) => Response): { url: string; close: () => Promise<void> } {
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, handler);
  return { url: `http://127.0.0.1:${server.addr.port}`, close: () => server.shutdown() };
}

Deno.test("the admin fetch never follows a redirect, so the secret key stays with the app", async () => {
  const seen: (string | null)[] = [];
  const other = serve((req) => {
    seen.push(req.headers.get("apikey"));
    return Response.json({ ok: true, realtime: null, functions: null, services: [] });
  });
  const app = serve((req) =>
    new Response(null, {
      status: 307,
      headers: { location: `${other.url}${new URL(req.url).pathname}` },
    })
  );
  try {
    const target = { url: app.url, key: "sb_secret_TOPSECRET" };
    const status = await adminStatus(target);
    assertEquals(status.ok, false);
    assertStringIncludes((status as { reason: string }).reason, "redirect");
    const probe = await appProbe(target);
    assertEquals(probe.status, "degraded");
    assertEquals(probe.httpStatus, 307);
    assertEquals(seen, [], "the other origin was never asked");
  } finally {
    await app.close();
    await other.close();
  }
});
