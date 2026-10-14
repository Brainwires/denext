// The generated SSR Dockerfile must make `denext start` listen on the requested port. `deno task`
// appends the CMD's extra tokens verbatim (a literal `--` included) to the task's command, so
// this models what the CLI receives from the CMD plus the image's ENV.

import { assertEquals } from "@std/assert";
import { CommandRegistry } from "../src/cli/command.ts";
import { startCommand } from "../src/cli/commands/serve.ts";
import { renderDockerfile } from "../src/build/docker-template.ts";

/** The port `denext start` would bind for a Dockerfile: `--port` it parsed, else `$PORT`. */
function portFor(dockerfile: string): number | undefined {
  const cmd = dockerfile.match(/^CMD (\[.*\])$/m);
  if (!cmd) throw new Error("no CMD");
  const [deno, task, name, ...extra] = JSON.parse(cmd[1]) as string[];
  assertEquals([deno, task, name], ["deno", "task", "start"]);
  const registry = new CommandRegistry();
  registry.register(startCommand);
  const out = registry.parse(["start", ...extra]);
  if (out.kind !== "run") throw new Error(`start rejected the CMD args: ${out.kind}`);
  if (typeof out.ctx.flags.port === "number") return out.ctx.flags.port;
  const env = dockerfile.match(/^ENV PORT=(\d+)$/m);
  return env ? Number(env[1]) : undefined;
}

Deno.test("generated Dockerfile CMD makes `start` listen on the chosen port", () => {
  assertEquals(portFor(renderDockerfile({ mode: "server", port: 4000 })), 4000);
  assertEquals(portFor(renderDockerfile({ mode: "server", port: 8080 })), 8080);
  assertEquals(portFor(renderDockerfile({ mode: "server" })), undefined); // default 3000
});
