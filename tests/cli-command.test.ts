// Unit tests for the CLI command framework's parser — the pure core that replaced
// the hand-rolled `switch` + `Deno.args.includes(...)` scanning. These lock in flag
// coercion, positionals, global flags, `--`/passthrough, help/version routing, and
// "did you mean" suggestions.

import { assert, assertEquals } from "@std/assert";
import { CommandRegistry, type CommandSpec, suggest } from "../src/cli/command.ts";

/** A registry with a couple of representative commands for parser tests. */
function registry(): CommandRegistry {
  const noop = () => {};
  const dev: CommandSpec = {
    name: "dev",
    summary: "Start the dev server",
    aliases: ["serve"],
    flags: [
      { name: "port", alias: "p", type: "number", valueName: "<port>", help: "Port" },
      { name: "host", type: "string", help: "Hostname" },
      { name: "open", type: "boolean", default: false, help: "Open browser" },
    ],
    positionals: [{ name: "dir", help: "Project dir" }],
    run: noop,
  };
  const test: CommandSpec = {
    name: "test",
    summary: "Run tests",
    passthrough: true,
    run: noop,
  };
  const reg = new CommandRegistry();
  reg.register(dev);
  reg.register(test);
  return reg;
}

Deno.test("parses positionals, valued flags, and aliases", () => {
  const out = registry().parse(["dev", "./app", "--port", "4000", "--host=0.0.0.0"]);
  assert(out.kind === "run");
  assertEquals(out.command.name, "dev");
  assertEquals(out.ctx.positionals, ["./app"]);
  assertEquals(out.ctx.flags.port, 4000);
  assertEquals(out.ctx.flags.host, "0.0.0.0");
});

Deno.test("short alias and boolean presence", () => {
  const out = registry().parse(["dev", "-p", "3001", "--open"]);
  assert(out.kind === "run");
  assertEquals(out.ctx.flags.port, 3001);
  assertEquals(out.ctx.flags.open, true);
});

Deno.test("boolean default is applied when absent", () => {
  const out = registry().parse(["dev"]);
  assert(out.kind === "run");
  assertEquals(out.ctx.flags.open, false);
});

Deno.test("command alias resolves to the same command", () => {
  const out = registry().parse(["serve", "--port", "5000"]);
  assert(out.kind === "run");
  assertEquals(out.command.name, "dev");
  assertEquals(out.ctx.flags.port, 5000);
});

Deno.test("global flags are parsed off any command", () => {
  const out = registry().parse(["dev", "--cwd", "/tmp/app", "--json", "--verbose"]);
  assert(out.kind === "run");
  assertEquals(out.ctx.global.cwd, "/tmp/app");
  assertEquals(out.ctx.global.json, true);
  assertEquals(out.ctx.global.verbose, true);
});

Deno.test("-- terminates flag parsing into rest", () => {
  const out = registry().parse(["dev", "--", "--not-a-flag", "x"]);
  assert(out.kind === "run");
  assertEquals(out.ctx.rest, ["--not-a-flag", "x"]);
});

Deno.test("passthrough command forwards unknown flags to rest", () => {
  const out = registry().parse(["test", "--coverage", "some/path.ts"]);
  assert(out.kind === "run");
  assertEquals(out.ctx.rest, ["--coverage"]);
  assertEquals(out.ctx.positionals, ["some/path.ts"]);
});

Deno.test("unknown flag on a strict command errors with a suggestion", () => {
  const out = registry().parse(["dev", "--prot", "3000"]);
  assert(out.kind === "error");
  assertEquals(out.suggestion, "--port");
});

Deno.test("unknown command errors with a suggestion", () => {
  const out = registry().parse(["dve"]);
  assert(out.kind === "error");
  assertEquals(out.suggestion, "denext dev");
});

Deno.test("a valued flag with no value errors", () => {
  const out = registry().parse(["dev", "--port"]);
  assert(out.kind === "error");
});

Deno.test("a non-numeric number flag errors", () => {
  const out = registry().parse(["dev", "--port", "abc"]);
  assert(out.kind === "error");
});

Deno.test("help and version routing", () => {
  const reg = registry();
  assertEquals(reg.parse([]).kind, "help");
  assertEquals(reg.parse(["version"]).kind, "version");
  assertEquals(reg.parse(["--version"]).kind, "version");
  const cmdHelp = reg.parse(["dev", "--help"]);
  assert(cmdHelp.kind === "help" && cmdHelp.command?.name === "dev");
  const topicHelp = reg.parse(["help", "dev"]);
  assert(topicHelp.kind === "help" && topicHelp.command?.name === "dev");
});

Deno.test("duplicate command registration throws", () => {
  const reg = registry();
  let threw = false;
  try {
    reg.register({ name: "dev", summary: "dup", run: () => {} });
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("suggest returns undefined when nothing is close", () => {
  assertEquals(suggest("zzzzzzzz", ["dev", "build"]), undefined);
  assertEquals(suggest("buld", ["dev", "build"]), "build");
});
