// The server loop and Deno's legacy request abort: denext reads `request.signal` on every request
// (to cancel work when a client goes away), and under Deno.serve's legacy behavior that makes the
// runtime warn on the first delivered response. Every runtime denext 5.0 runs on (3.0.0-rc.5 and
// later) has the new abort by default, with no flag: the warning is gone, a disconnect still
// aborts `requestSignal()` mid-request, and a delivered response still aborts it afterwards (from
// `info.completed`), as the legacy signal did.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { childToolchainMarker } from "../src/cli/self-exec.ts";

const src = (path: string) => toFileUrl(join(Deno.cwd(), path)).href;

Deno.test("childToolchainMarker: the marker, else this process's own toolchain build", () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  assertEquals(
    childToolchainMarker(env({ DENEXT_TOOLCHAIN_ACTIVE: "3.0.0-rc.6" }), { deno: "x" }),
    "3.0.0-rc.6",
  );
  const rc5 = { deno: "3.0.0-rc.5", denext: "3.0.0-rc.5" };
  assertEquals(childToolchainMarker(env({}), rc5), "3.0.0-rc.5");
  // A user DENO_BIN no longer hides this process's own build (it is verified as denext's).
  assertEquals(childToolchainMarker(env({ DENO_BIN: "/my/deno" }), rc5), "3.0.0-rc.5");
  assertEquals(childToolchainMarker(env({}), { deno: "3.0.0-rc.5" }), undefined, "upstream");
});

Deno.test({
  name: "the server loop on denext's runtime: no legacy-abort warning, same request signal",
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "dnx-legacy-abort-" });
  try {
    await Deno.mkdir(join(dir, "app/slow"), { recursive: true });
    await Deno.mkdir(join(dir, "app/fast"), { recursive: true });
    const route = (ms: number) =>
      `import { requestSignal } from ${JSON.stringify(src("src/server/request-context.ts"))};
export async function GET(req: Request) {
  const signal = requestSignal()!;
  const name = new URL(req.url).pathname;
  // Each step is also an event the script waits on (globalThis.steps), instead of guessing times.
  const step = (what) => globalThis.steps?.dispatchEvent(new Event(what + " " + name));
  signal.addEventListener("abort", () => (console.log("aborted " + name), step("aborted")));
  step("started");
  await new Promise((r) => setTimeout(r, ${ms}));
  console.log("returning " + name + " aborted=" + signal.aborted);
  step("returned");
  return new Response("ok");
}
`;
    await Deno.writeTextFile(join(dir, "app/slow/route.ts"), route(1500));
    await Deno.writeTextFile(join(dir, "app/fast/route.ts"), route(0));
    const script = join(dir, "serve.ts");
    await Deno.writeTextFile(
      script,
      `import { pathToFileURL } from "node:url";
import { createApp } from ${JSON.stringify(src("src/server/app.ts"))};
import { scanRoutes } from ${JSON.stringify(src("src/router/manifest.ts"))};
import { serveWithPortFallback } from ${JSON.stringify(src("src/server/serve-utils.ts"))};
const manifest = await scanRoutes(${JSON.stringify(join(dir, "app"))});
// The manifest holds paths; a Windows path is no module specifier.
const load = (p) => import(pathToFileURL(p).href);
const handler = createApp({ getManifest: () => manifest, load });
const done = new AbortController();
const server = serveWithPortFallback({
  port: 0, hostname: "127.0.0.1", strict: true, signal: done.signal, onListen() {},
}, handler);
const base = "http://127.0.0.1:" + server.addr.port;
globalThis.steps = new EventTarget();
const step = (type) => new Promise((r) => globalThis.steps.addEventListener(type, r, { once: true }));
const fastAborted = step("aborted /fast");
console.log(await (await fetch(base + "/fast")).text());
await fastAborted;
const client = new AbortController();
const slowStarted = step("started /slow");
const slowReturned = step("returned /slow");
const slow = fetch(base + "/slow", { signal: client.signal }).catch(() => {});
// The client goes away mid-request: once the handler runs, with its whole wait still ahead.
await slowStarted;
client.abort();
await slow;
await slowReturned;
done.abort();
await server.finished;
`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        join(Deno.cwd(), "deno.json"),
        script,
      ],
      cwd: Deno.cwd(),
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(out.stdout);
    const stderr = new TextDecoder().decode(out.stderr);
    assert(out.success, stderr);
    assert(!/legacy behavior/.test(stderr + stdout), stderr);
    const lines = stdout.trim().split("\n");
    // The delivered response still aborts the request's signal afterwards (as legacy did).
    assertEquals(lines[0], "returning /fast aborted=false");
    assertEquals(lines.slice(1, 3).sort(), ["aborted /fast", "ok"]);
    // A client that goes away mid-request aborts it at once, before the handler returns.
    assertEquals(lines.indexOf("aborted /slow") >= 0, true, stdout);
    assert(lines.indexOf("aborted /slow") < lines.indexOf("returning /slow aborted=true"), stdout);
    assertStringIncludes(stdout, "returning /slow aborted=true");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
