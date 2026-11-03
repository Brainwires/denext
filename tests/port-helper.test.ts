// tests/helpers/port.ts: the port a server started on `--port 0` says it bound, from each of
// denext's listen banners, and the waits built on it.

import { assertEquals } from "@std/assert";
import { boundPort, listenedPort } from "./helpers/port.ts";

Deno.test("listenedPort: every denext listen banner, the mangled arrow of a Windows pipe included", () => {
  assertEquals(listenedPort("denext listening on http://0.0.0.0:41234\n"), 41234);
  assertEquals(listenedPort("noise\ndenext start ▸ http://localhost:5001\n"), 5001);
  assertEquals(listenedPort("\n  denext dev  ▸  http://127.0.0.1:3010\n  watching app\n"), 3010);
  assertEquals(listenedPort("  denext dev (SPA)  ▸  http://[::1]:3011\n"), 3011);
  assertEquals(listenedPort("denext start \u00e2\u2013\u00b8 http://localhost:49376\n"), 49376);
  assertEquals(listenedPort("denext dev  ▸  http://192.168.1.2:3000?__denext_dev=t\n"), 3000);
});

Deno.test("listenedPort: nothing yet, or a line that is not a listen banner", () => {
  assertEquals(listenedPort(""), undefined);
  assertEquals(listenedPort("denext: see https://denext.dev/docs/config\n"), undefined);
  assertEquals(listenedPort("listening on http://localhost:3000\n"), undefined, "not denext's");
});

Deno.test("boundPort: the port once printed, or undefined when the server exits or time runs out", async () => {
  let out = "";
  const waiting = boundPort(() => out, () => false);
  out = "denext start ▸ http://localhost:7777\n";
  assertEquals(await waiting, 7777);
  assertEquals(await boundPort(() => 8080, () => false), 8080, "a reader that kept the port");
  assertEquals(await boundPort(() => "", () => true), undefined, "exited without saying");
  assertEquals(await boundPort(() => "", () => false, 0), undefined, "out of time");
});
