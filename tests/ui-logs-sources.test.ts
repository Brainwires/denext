// The Logs page's two readers, at their edges: the real `docker` runner (against a stand-in
// `docker` on PATH, never the host's), the relay source's query and refusals, the source picker,
// and the Docker Engine reader over a real Unix socket. ui-logs.test.ts drives the page and the
// relay with scripted seams; this file covers what those seams stand in for.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  composeSource,
  pickLogSource,
  relaySource,
  setDockerRunner,
} from "../src/ui/logs/source.ts";
import { containerLogs, type EngineGet, projectOf } from "../src/ui/logs/engine.ts";
import { inChild } from "./helpers/isolated.ts";

const POSIX = Deno.build.os !== "windows";

/** Run `fn` with PATH set to `path` only, restoring it after. */
async function withPath(path: string, fn: () => Promise<void>): Promise<void> {
  const before = Deno.env.get("PATH");
  Deno.env.set("PATH", path);
  try {
    await fn();
  } finally {
    if (before === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", before);
  }
}

/** The module's real runner (put back at once: the swap is only how it is reached). */
function realRunner() {
  const real = setDockerRunner(() => Promise.reject(new Error("unused")));
  setDockerRunner(real);
  return real;
}

Deno.test({
  name:
    "the real docker runner runs `docker` from PATH with argv only, and a failing compose call names its last stderr line",
  ignore: !POSIX, // the stand-in is a shell script
  async fn() {
    const bin = await Deno.makeTempDir({ prefix: "dnx-fake-docker-" });
    try {
      // A stand-in docker: `config --services` lists services (one not a service name),
      // `ps` answers compose's JSON lines, `logs` fails the way a stopped daemon does.
      await Deno.writeTextFile(
        join(bin, "docker"),
        `#!/bin/sh
case "$*" in
  *"config --services"*) printf 'web\\n\\ndb\\n-bad\\n' ;;
  *"ps --all"*) printf '{"Service":"db","State":"running","Health":"healthy"}\\n{"Service":"web","State":"exited","ExitCode":1}\\n' ;;
  *) echo "warming up" >&2; echo "Cannot connect to the Docker daemon" >&2; exit 2 ;;
esac
`,
      );
      await Deno.chmod(join(bin, "docker"), 0o755);
      const real = realRunner();
      assert(real !== undefined);
      await withPath(bin, async () => {
        const source = composeSource(bin, "compose.yml");
        assertEquals(
          await source.services(),
          ["db", "web"],
          "sorted; blanks and bad names dropped",
        );
        const health = await source.health();
        assertEquals(health.map((s) => [s.name, s.ok]), [["db", true], ["web", false]]);
        const error = await assertRejects(() => source.read({ service: "web", tail: 10 }));
        assertEquals(
          (error as Error).message,
          "docker compose logs exited 2: Cannot connect to the Docker daemon",
        );
      });
    } finally {
      await Deno.remove(bin, { recursive: true });
    }
  },
});

Deno.test("the real docker runner: no docker on PATH is the hint, in process", async () => {
  const empty = await Deno.makeTempDir({ prefix: "dnx-no-docker-" });
  try {
    await withPath(empty, async () => {
      const error = await assertRejects(() => realRunner()(["--version"], empty));
      assertStringIncludes((error as Error).message, "docker is not on PATH");
    });
  } finally {
    await Deno.remove(empty, { recursive: true });
  }
});

Deno.test("compose source: a service name that is not one is skipped, never passed to docker", async () => {
  const calls: string[][] = [];
  const previous = setDockerRunner((args) => {
    calls.push(args);
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  });
  try {
    assertEquals(await composeSource("/p", "c.yml").read({ service: "--rm", tail: 5 }), []);
    assertEquals(calls, []);
  } finally {
    setDockerRunner(previous);
  }
});

Deno.test("relay source: the service and window ride the query, and a refusal carries the relay's reason", async () => {
  const seen: URL[] = [];
  const ac = new AbortController();
  const { promise, resolve } = Promise.withResolvers<number>();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen: (a) => resolve(a.port) },
    (req) => {
      const url = new URL(req.url);
      seen.push(url);
      if (url.pathname === "/v1/logs") {
        return Response.json({
          ok: true,
          lines: [
            { service: "web", time: "2026-10-14T09:00:02Z", text: "b" },
            { service: "web", time: "2026-10-14T09:00:01Z", text: "a" },
            { service: "web", time: "2026-10-14T09:00:03Z", text: "c" },
          ],
        });
      }
      if (url.pathname === "/v1/health") {
        return Response.json({ ok: false, reason: "engine unreachable" }, { status: 200 });
      }
      return new Response("not json", { status: 502 });
    },
  );
  const port = await promise;
  try {
    const source = relaySource(`http://127.0.0.1:${port}`, "tok");
    const lines = await source.read({ service: "web", tail: 2, sinceSeconds: 600 });
    assertEquals(lines.map((l) => l.text), ["b", "c"], "the newest two, oldest first");
    const q = seen[0].searchParams;
    assertEquals([q.get("tail"), q.get("service"), q.get("since")], ["2", "web", "600"]);
    // A 200 whose body says ok: false is still a refusal, with the relay's own reason.
    const health = await assertRejects(() => source.health());
    assertEquals((health as Error).message, "the logs relay answered 200: engine unreachable");
    // A body that is not JSON has no reason to give.
    const services = await assertRejects(() => source.services());
    assertEquals((services as Error).message, "the logs relay answered 502: no reason");
  } finally {
    ac.abort();
    await server.finished;
  }
});

Deno.test("pickLogSource: the relay wins, else the project's compose file, else nothing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "dnx-logs-pick-" });
  try {
    const relay = await pickLogSource(dir, { url: "http://127.0.0.1:1", token: "t" });
    assertEquals(relay?.label, "the stack's dashboard-logs relay");
    assertEquals(await pickLogSource(dir, undefined), null, "no compose file, no relay");
    await Deno.writeTextFile(join(dir, "docker-compose.yml"), "services: {}\n");
    const compose = await pickLogSource(dir, undefined);
    assertStringIncludes(compose?.label ?? "", "docker compose logs (");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("projectOf: a container name is checked before it reaches a path, and needs a compose label", async () => {
  const paths: string[] = [];
  const get: EngineGet = (path) => {
    paths.push(path);
    if (path === "/containers/plain/json") return Promise.resolve(Response.json({ Config: {} }));
    if (path === "/containers/gone/json") {
      return Promise.resolve(new Response("no such container", { status: 404 }));
    }
    return Promise.resolve(Response.json({
      Config: { Labels: { "com.docker.compose.project": "shop" } },
    }));
  };
  await assertRejects(() => projectOf(get, "../etc"), Error, "bad container name");
  assertEquals(paths, [], "a bad name never reaches the Engine");
  assertEquals(await projectOf(get, "self-1"), "shop");
  await assertRejects(() => projectOf(get, "plain"), Error, "not started by Docker Compose");
  await assertRejects(
    () => projectOf(get, "gone"),
    Error,
    "the Docker Engine answered 404 for /containers/gone/json",
  );
});

Deno.test("containerLogs: the tail is clamped, the window passed in whole seconds, and a non-200 is an error", async () => {
  const paths: string[] = [];
  const ok: EngineGet = (path) => {
    paths.push(path);
    return Promise.resolve(new Response("2026-10-14T09:00:00Z hi\n\n"));
  };
  const lines = await containerLogs(ok, "web", "abc", { tail: 99_999, since: 1700000000.9 });
  assertEquals(lines, [{ service: "web", time: "2026-10-14T09:00:00Z", text: "hi" }]);
  assertEquals(
    paths[0],
    "/containers/abc/logs?stdout=1&stderr=1&timestamps=1&tail=5000&since=1700000000",
  );
  const failing: EngineGet = () => Promise.resolve(new Response("x", { status: 500 }));
  await assertRejects(
    () => containerLogs(failing, "web", "abc", { tail: 0 }),
    Error,
    "the Docker Engine answered 500 for the web logs",
  );
});

Deno.test({
  name: "socketGet: plain HTTP to the daemon over its Unix socket, one client reused",
  ignore: !POSIX,
  async fn() {
    // In a child process: the reader's HTTP client lives as long as the relay that made it (it
    // is never closed), which the resource sanitizer would read as a leak here.
    const { value } = await inChild<{ projects: string[]; seen: string[] }>({
      imports: `import { join } from "@std/path";
import { projectOf, socketGet } from "@repo/src/ui/logs/engine.ts";`,
      body: `
// Under /tmp: a socket path must fit sun_path (104 bytes on macOS), which a test run's own
// TMPDIR may not leave room for.
const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "dnx-engine-" });
const socket = join(dir, "docker.sock");
const seen = [];
const { promise, resolve } = Promise.withResolvers();
const server = Deno.serve({ path: socket, onListen: () => resolve() }, (req) => {
  const url = new URL(req.url);
  seen.push(\`\${req.method} \${url.pathname}\${url.search}\`);
  return Response.json({ Config: { Labels: { "com.docker.compose.project": "shop" } } });
});
await promise;
const get = socketGet(socket);
const projects = [await projectOf(get, "c1"), await projectOf(get, "c2")];
await server.shutdown();
await Deno.remove(dir, { recursive: true });
return { projects, seen };`,
    });
    assertEquals(value.projects, ["shop", "shop"]);
    assertEquals(value.seen, ["GET /containers/c1/json", "GET /containers/c2/json"]);
  },
});
