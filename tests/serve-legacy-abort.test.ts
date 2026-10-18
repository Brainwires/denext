// The server loop and Deno's legacy request abort: denext reads `request.signal` on every request
// (to cancel work when a client goes away), and under Deno.serve's legacy behavior that makes the
// runtime warn on the first delivered response. The toolchain child runs with
// `--unstable-no-legacy-abort` (`toolchainRuntimeFlags`), so the warning is gone, a disconnect
// still aborts `requestSignal()` mid-request, and a delivered response still aborts it afterwards
// (from `info.completed`), as the legacy signal did.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  childToolchainMarker,
  legacyAbortActive,
  toolchainRuntimeFlags,
} from "../src/cli/self-exec.ts";

const src = (path: string) => toFileUrl(join(Deno.cwd(), path)).href;

Deno.test("toolchainRuntimeFlags: the toolchain child opts in to Deno.serve's new request abort", () => {
  assertEquals(toolchainRuntimeFlags("2.9.7-denext.16"), ["--unstable-no-legacy-abort"]);
  // A DENEXT_DENO=<path> binary may predate the flag; no toolchain, no flag.
  assertEquals(toolchainRuntimeFlags("path"), []);
  assertEquals(toolchainRuntimeFlags(undefined), []);
  // Which toolchain a CLI child runs: the marker, else this process's own toolchain build.
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  const marker = "DENEXT_TOOLCHAIN_ACTIVE";
  assertEquals(childToolchainMarker(env({ [marker]: "path" }), "2.9.6"), "path");
  assertEquals(childToolchainMarker(env({}), "2.9.7-denext.17"), "2.9.7-denext.17");
  assertEquals(childToolchainMarker(env({ DENO_BIN: "/x/deno" }), "2.9.7-denext.17"), undefined);
  assertEquals(childToolchainMarker(env({}), "2.9.6"), undefined);
});

Deno.test({
  name: "the server loop under the toolchain's flags: no legacy-abort warning, same request signal",
  sanitizeResources: false,
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
  signal.addEventListener("abort", () => console.log("aborted " + name));
  await new Promise((r) => setTimeout(r, ${ms}));
  console.log("returning " + name + " aborted=" + signal.aborted);
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
console.log(await (await fetch(base + "/fast")).text());
await new Promise((r) => setTimeout(r, 100));
const client = new AbortController();
const slow = fetch(base + "/slow", { signal: client.signal }).catch(() => {});
setTimeout(() => client.abort(), 300);
await slow;
await new Promise((r) => setTimeout(r, 1600));
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
        ...toolchainRuntimeFlags("2.9.7-denext.16"),
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

Deno.test("legacyAbortActive: tells the legacy abort from the flag, and prints no notice itself", async () => {
  const script = join(await Deno.makeTempDir({ prefix: "dnx-legacy-probe-" }), "probe.ts");
  try {
    await Deno.writeTextFile(
      script,
      `import { legacyAbortActive } from ${JSON.stringify(src("src/cli/self-exec.ts"))};
console.log(JSON.stringify(await legacyAbortActive()));
`,
    );
    const run = async (flags: string[]) => {
      const out = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--config", join(Deno.cwd(), "deno.json"), ...flags, script],
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stderr = new TextDecoder().decode(out.stderr);
      assert(out.success, stderr);
      assert(!/legacy behavior/.test(stderr), stderr);
      return new TextDecoder().decode(out.stdout).trim();
    };
    assertEquals(await run([]), "true");
    assertEquals(await run(["--unstable-no-legacy-abort"]), "false");
  } finally {
    await Deno.remove(join(script, ".."), { recursive: true });
  }
  // In this process (the suite may run with or without the flag) it answers a boolean.
  assertEquals(typeof await legacyAbortActive(), "boolean");
});
