// The Docker probe the Docker-backed tests skip on (tests/helpers/docker-probe.ts): a daemon that
// never answers `docker info` must read as "unavailable" within the deadline, not stall the suite.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DOCKER_PROBE_TIMEOUT_MS, dockerReady } from "./helpers/docker-probe.ts";

/** A fake `docker` whose `compose version` succeeds and whose `info` runs `info`. */
async function fakeDocker(dir: string, info: string): Promise<string> {
  const path = join(dir, "docker");
  await Deno.writeTextFile(
    path,
    `#!/bin/sh\ncase "$1" in\n  compose) echo "Docker Compose version v2" ;;\n  info) ${info} ;;\nesac\n`,
  );
  await Deno.chmod(path, 0o755);
  return path;
}

Deno.test({
  name: "dockerReady: a hung `docker info` is killed at the deadline and reads as unavailable",
  // The fake is a shell script.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    assert(DOCKER_PROBE_TIMEOUT_MS <= 10_000, "the default deadline is a few seconds");
    const dir = await Deno.makeTempDir({ prefix: "denext-docker-probe-" });
    try {
      // `sleep` runs as the script's own child: the whole tree goes at the deadline.
      const hung = await fakeDocker(dir, "sleep 600");
      const started = performance.now();
      assertEquals(await dockerReady({ docker: hung, timeoutMs: 500 }), false);
      assert(performance.now() - started < 15_000, "the probe waited past its deadline");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "dockerReady: a Linux engine is ready; a Windows engine, a failing step or no docker is not",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext-docker-probe-" });
    try {
      assertEquals(await dockerReady({ docker: await fakeDocker(dir, "echo linux") }), true);
      assertEquals(await dockerReady({ docker: await fakeDocker(dir, "echo windows") }), false);
      assertEquals(await dockerReady({ docker: await fakeDocker(dir, "exit 1") }), false);
      assertEquals(await dockerReady({ docker: join(dir, "missing") }), false);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
