// A denext prod server hosted in its OWN process, so the load benchmark can
// measure its RSS in isolation (the load generator lives in a separate process).
// Reuses the on-disk build (the parent runs `build()` first) and prints the bound
// origin so the parent can target it, then stays alive until killed.

import { join } from "@std/path";
import { serveDenext } from "../lib/serve.ts";

const REPO = new URL("../../", import.meta.url).pathname;
const APP = Deno.args[0] ?? join(REPO, "examples/hello");

const server = await serveDenext(APP, { reuseBuild: true });
console.log(`READY ${server.origin}`);

// Park until the parent terminates this process.
await new Promise<void>(() => {});
void server;
