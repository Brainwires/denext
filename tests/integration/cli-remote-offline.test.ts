// A CLI loaded over the network (as `deno install -g jsr:@denext/denext/cli` runs it) imports each
// verb's implementation on first use, so caching the entrypoint alone leaves the verbs uncached.
// This serves the checkout over loopback HTTP as a stand-in for JSR, caches only the entrypoint's
// graph (what an install caches), shows that a verb then fails under `--cached-only`, and that both
// ways the CLI caches its verbs — the background warm-up on any first run, and `denext toolchain
// install` — make it load offline.
//
// Opt-in and heavy (a fresh DENO_DIR downloads every dependency of every verb):
// DENEXT_TEST_REMOTE_CLI=1.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { contentType } from "@std/media-types";
import { extname, fromFileUrl, join, normalize } from "@std/path";
import { boundedOutput } from "../helpers/bounded-command.ts";

const ROOT = fromFileUrl(new URL("../..", import.meta.url));
const enabled = Deno.env.get("DENEXT_TEST_REMOTE_CLI") === "1";

/** Serve the checkout read-only on a loopback port. */
function serveCheckout(): { server: Deno.HttpServer; origin: string } {
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (req) => {
    const path = normalize(decodeURIComponent(new URL(req.url).pathname));
    if (path.includes("..")) return new Response("no", { status: 403 });
    try {
      const body = await Deno.readFile(join(ROOT, path));
      const type = contentType(extname(path)) ?? "application/typescript";
      return new Response(body, { headers: { "content-type": type } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
  return { server, origin: `http://127.0.0.1:${server.addr.port}` };
}

/** The checkout's import map with its local targets served from `origin` (as JSR would). */
async function remoteConfig(origin: string, dir: string): Promise<string> {
  const { imports } = JSON.parse(await Deno.readTextFile(join(ROOT, "deno.json"))) as {
    imports: Record<string, string>;
  };
  const remote = Object.fromEntries(
    Object.entries(imports).map((
      [k, v],
    ) => [k, v.startsWith("./") ? `${origin}/${v.slice(2)}` : v]),
  );
  const path = join(dir, "deno.json");
  await Deno.writeTextFile(path, JSON.stringify({ imports: remote, lock: false }));
  return path;
}

Deno.test({
  name: `a CLI run from a URL caches its verbs for offline use${
    enabled ? "" : " (skipped: set DENEXT_TEST_REMOTE_CLI=1)"
  }`,
  ignore: !enabled,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const tmp = await Deno.makeTempDir({ prefix: "denext_remote_cli_" });
    const { server, origin } = serveCheckout();
    try {
      const config = await remoteConfig(origin, tmp);
      const project = join(tmp, "app");
      await Deno.mkdir(join(project, "app"), { recursive: true });
      await Deno.writeTextFile(join(project, "app", "page.tsx"), "export default () => null;\n");
      const cli = `${origin}/cli.ts`;
      const run = async (args: string[], env: Record<string, string> = {}) => {
        const out = await boundedOutput(Deno.execPath(), {
          args,
          cwd: tmp,
          env: { DENO_DIR: join(tmp, "deno-dir"), DENEXT_DENO: "stock", NO_COLOR: "1", ...env },
        });
        const decoder = new TextDecoder();
        return { code: out.code, out: decoder.decode(out.stdout), err: decoder.decode(out.stderr) };
      };
      const offline = (verb: string[]) =>
        run(["run", "-A", "--cached-only", "--config", config, cli, ...verb]);

      // What an install caches: the entrypoint's graph.
      const cached = await run(["cache", "--allow-import", "--config", config, cli]);
      assertEquals(cached.code, 0, cached.err);
      const before = await offline(["routes", project]);
      assertNotEquals(before.code, 0, "the verb's modules were not in the cache yet");

      // `denext toolchain install` (here with an explicit toolchain path: no download) caches them.
      const install = await run(["run", "-A", "--config", config, cli, "toolchain", "install"], {
        DENEXT_DENO: Deno.execPath(),
      });
      assertEquals(install.code, 0, install.err);
      assert(install.out.includes("cached for offline use"), install.out);
      const after = await offline(["routes", project]);
      assertEquals(after.code, 0, after.err);

      // The background warm-up: a fresh cache, any first run (`--version`), then offline verbs.
      await Deno.remove(join(tmp, "deno-dir"), { recursive: true });
      assertEquals((await run(["cache", "--allow-import", "--config", config, cli])).code, 0);
      const version = await run(["run", "-A", "--config", config, cli, "--version"]);
      assertEquals(version.code, 0, version.err);
      const marker = join(tmp, "deno-dir", "denext-cli");
      const deadline = Date.now() + 300_000;
      let warmed = false;
      while (!warmed && Date.now() < deadline) {
        warmed = [...(() => {
          try {
            return Deno.readDirSync(marker);
          } catch {
            return [];
          }
        })()].some((e) => e.name.endsWith(".cached"));
        if (!warmed) await new Promise((r) => setTimeout(r, 1000));
      }
      assert(warmed, "the background warm-up never finished");
      const warm = await offline(["routes", project]);
      assertEquals(warm.code, 0, warm.err);
    } finally {
      await server.shutdown();
      await Deno.remove(tmp, { recursive: true });
    }
  },
});
