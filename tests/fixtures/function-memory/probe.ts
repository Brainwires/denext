// Run under `--unstable-worker-options` by tests/backend-functions.test.ts: one Edge Function
// worker with a 16 MB heap cap that allocates without end. Prints the response's status and body.
import { fromFileUrl } from "@std/path";
import { FunctionHost } from "../../../packages/backend/src/functions.ts";

const hog = fromFileUrl(new URL("./hog.ts", import.meta.url));
const host = new FunctionHost("hog", hog, undefined, undefined, 16);
const res = await host.call(
  { url: "https://x.test/hog", method: "GET", headers: [], body: null },
  {},
  60_000,
);
console.log(JSON.stringify({ status: res.status, body: await res.json() }));
host.stop();
