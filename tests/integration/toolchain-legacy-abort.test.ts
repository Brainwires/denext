// `denext start` started directly on denext's Deno toolchain serves without Deno's legacy abort.
//
// The toolchain re-exec gives its child `--unstable-no-legacy-abort`, but a CLI started ON the
// pinned toolchain (`toolchain link` puts it on PATH as `deno`; a `deno task` step runs the same
// `deno`) never re-execs, so it served with the legacy behaviour and printed Deno's
// "request.signal aborts on successful responses (legacy behavior)" notice on the first request
// that read the signal (the server loop reads it on every request). Now a serving verb on the
// toolchain without the flag re-runs once on the same binary with it. This runs the real CLI on
// the pinned toolchain binary, the way a linked `deno` would, with a route handler that reads
// `request.signal`. It needs the toolchain in the cache (`denext toolchain install`), and skips
// without it.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { cachedToolchain, linkedEnv } from "../helpers/toolchain.ts";
import { boundedOutput } from "../helpers/bounded-command.ts";

const ROOT = fromFileUrl(new URL("../..", import.meta.url));
const CLI = join(ROOT, "cli.ts");

const TOOLCHAIN = cachedToolchain();

/** A free loopback port. */
function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = l.addr as Deno.NetAddr;
  l.close();
  return port;
}

Deno.test({
  name: "denext start on the pinned toolchain serves without Deno's legacy-abort notice",
  ignore: TOOLCHAIN === null,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const deno = TOOLCHAIN!;
    const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-legacy-abort-" }));
    try {
      await Deno.mkdir(join(dir, "app/api/sig"), { recursive: true });
      await Deno.writeTextFile(
        join(dir, "app/api/sig/route.ts"),
        "export function GET(req: Request): Response {\n" +
          "  return Response.json({ aborted: req.signal.aborted });\n}\n",
      );
      const env = linkedEnv(deno);
      const cli = (
        verb: string[],
      ) => ["run", "-A", "--config", join(ROOT, "deno.json"), CLI, ...verb];
      const built = await boundedOutput(deno, {
        args: cli(["build", dir]),
        cwd: dir,
        env,
      });
      const dec = new TextDecoder();
      assertEquals(built.code, 0, `${dec.decode(built.stdout)}${dec.decode(built.stderr)}`);

      const port = freePort();
      const child = new Deno.Command(deno, {
        args: cli(["start", dir, "--port", String(port), "--hostname", "127.0.0.1"]),
        cwd: dir,
        env,
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      let output = "";
      const drain = async (stream: ReadableStream<Uint8Array>) => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
      };
      const drained = Promise.all([drain(child.stdout), drain(child.stderr)]);
      let exited = false;
      child.status.then(() => exited = true);
      const bodies: unknown[] = [];
      try {
        // Generous: a loaded machine takes a while to load the app's modules.
        for (let i = 0; i < 1200 && !exited && bodies.length === 0; i++) {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/api/sig`);
            if (res.status === 200) bodies.push(await res.json());
            else await res.body?.cancel();
          } catch { /* not listening yet */ }
          if (bodies.length === 0) await new Promise((r) => setTimeout(r, 100));
        }
        // A second request after the first was delivered: the notice prints on the first
        // response whose signal was read, so it is out by now if it is coming at all.
        const res = await fetch(`http://127.0.0.1:${port}/api/sig`);
        bodies.push(await res.json());
        await new Promise((r) => setTimeout(r, 300));
      } finally {
        if (!exited) child.kill("SIGTERM");
        await child.status;
        await drained;
      }
      assertEquals(bodies, [{ aborted: false }, { aborted: false }], output);
      assert(!output.includes("(legacy behavior)"), output);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
