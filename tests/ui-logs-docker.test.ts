// The logs relay's Engine reader against a REAL Docker daemon, over its Unix socket: a container
// labelled as a compose service is found by its project, its stdout and stderr come back
// demultiplexed and timestamped, and the full relay answers for it from the container's own
// project label. Opt-in (it starts a throwaway container):
//
//   DENEXT_TEST_DOCKER=1 deno test -A tests/ui-logs-docker.test.ts
//
// The same paths run against a fake Engine in tests/ui-logs.test.ts.

import { assert, assertEquals } from "@std/assert";
import { containerLogs, projectServices, socketGet } from "../src/ui/logs/engine.ts";
import { relayHandler } from "../src/ui/logs/relay.ts";

const SOCKET = Deno.env.get("DENEXT_TEST_DOCKER_SOCKET") ?? "/var/run/docker.sock";
const IMAGE = Deno.env.get("DENEXT_TEST_DOCKER_IMAGE") ?? "postgres:17-alpine";
const enabled = Deno.env.get("DENEXT_TEST_DOCKER") === "1";

/** Run `docker` and return its trimmed stdout (throws on a non-zero exit). */
async function docker(...args: string[]): Promise<string> {
  const out = await new Deno.Command("docker", { args, stdout: "piped", stderr: "piped" }).output();
  if (out.code !== 0) throw new Error(new TextDecoder().decode(out.stderr));
  return new TextDecoder().decode(out.stdout).trim();
}

Deno.test({
  name: `the relay's Engine reader on a real Docker daemon${
    enabled ? "" : " (set DENEXT_TEST_DOCKER=1)"
  }`,
  ignore: !enabled,
  sanitizeResources: false,
  async fn() {
    const project = `dnxlogs${crypto.randomUUID().slice(0, 8)}`;
    const id = await docker(
      "run",
      "-d",
      "--label",
      `com.docker.compose.project=${project}`,
      "--label",
      "com.docker.compose.service=echo",
      "--entrypoint",
      "sh",
      IMAGE,
      "-c",
      "echo hello out; echo 'ERROR: oops' 1>&2; sleep 60",
    );
    try {
      const get = socketGet(SOCKET);
      const services = await projectServices(get, project);
      assertEquals([...services.keys()], ["echo"]);
      assertEquals(services.get("echo"), id);
      let lines: { text: string; time?: string }[] = [];
      for (let i = 0; i < 50 && lines.length < 2; i++) {
        lines = await containerLogs(get, "echo", id, { tail: 10 });
        if (lines.length < 2) await new Promise((r) => setTimeout(r, 200));
      }
      assertEquals(lines.map((l) => l.text).sort(), ["ERROR: oops", "hello out"]);
      assert(lines.every((l) => typeof l.time === "string"), "every line is timestamped");
      // The whole relay, as if it ran in this container (its own project label decides).
      const handle = relayHandler({ token: "t".repeat(43), engine: get, self: id.slice(0, 12) });
      const res = await handle(
        new Request("http://relay/v1/logs?service=echo&tail=5", {
          headers: { authorization: `Bearer ${"t".repeat(43)}` },
        }),
      );
      const body = await res.json();
      assertEquals(body.ok, true);
      assertEquals(body.lines.length, 2);
      const health = await (await handle(
        new Request("http://relay/v1/health", {
          headers: { authorization: `Bearer ${"t".repeat(43)}` },
        }),
      )).json();
      assertEquals(health.services, [{ name: "echo", state: "running", health: "none", ok: true }]);
    } finally {
      await docker("rm", "-f", id).catch(() => "");
    }
  },
});
