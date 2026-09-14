// Coverage for `src/cli/commands/ui.ts`: drive the verb's `run` directly (the `makeCtx`
// precedent), assert the `--json` line, the banner, `--read-only`, and that the command never
// reaches `Deno.exit` — the server is stopped through its shutdown signal instead.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { activeUiServers, uiCommand } from "../src/cli/commands/ui.ts";
import { DEFAULT_UI_PORT } from "../src/ui/server.ts";
import { openCommand } from "../src/ui/open.ts";
import { capture, makeCtx, stubExit } from "./_cli-coverage-helpers.ts";
import type { GlobalFlags } from "../src/cli/command.ts";

async function project(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_cli_" });
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  return dir;
}

/**
 * Run `denext ui` with `--port 0 --no-open` until `probe` has inspected it, then shut its server
 * down (what SIGINT does in a terminal). Returns whatever the command logged.
 */
async function serve(
  opts: { flags?: Record<string, string | number | boolean>; global?: Partial<GlobalFlags> },
  probe: (logs: string[]) => Promise<void> | void,
): Promise<{ logs: string[]; exits: number[] }> {
  const dir = await project();
  const exit = stubExit();
  const cap = capture();
  const running = uiCommand.run(makeCtx({
    positionals: [dir],
    flags: { port: 0, "no-open": true, ...opts.flags },
    global: opts.global,
  })) as Promise<void>;
  try {
    while (activeUiServers.size === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    await probe(cap.logs);
  } finally {
    for (const server of activeUiServers) await server.shutdown();
    await running;
    cap.restore();
    exit.restore();
    await Deno.remove(dir, { recursive: true });
  }
  return { logs: cap.logs, exits: exit.calls };
}

Deno.test("ui --json prints { url, port, token } on one line and keeps serving", async () => {
  const { logs, exits } = await serve({ global: { json: true } }, async (logs) => {
    const payload = JSON.parse(logs[0]) as { url: string; port: number; token: string };
    assert(/^http:\/\/(localhost|127\.0\.0\.1):\d+\/\?t=/.test(payload.url), payload.url);
    assert(payload.port > 0);
    assert(payload.token.length >= 43);
    // Still serving: the handshake URL answers.
    const res = await fetch(payload.url, { redirect: "manual" });
    await res.body?.cancel();
    assertEquals(res.status, 302);
  });
  assertEquals(logs.length, 1, "--json prints exactly one line");
  assertEquals(exits, [], "the verb never calls Deno.exit");
});

Deno.test("ui prints a human banner with the URL and the Ctrl+C hint", async () => {
  const { logs, exits } = await serve({}, (logs) => {
    const banner = logs.join("\n");
    assertStringIncludes(banner, "denext ui");
    assertStringIncludes(banner, "?t=");
    assertStringIncludes(banner, "Ctrl+C");
  });
  assert(!logs.join("\n").includes("read-only"));
  assertEquals(exits, []);
});

Deno.test("ui --read-only says so and refuses mutations", async () => {
  const { logs, exits } = await serve({ flags: { "read-only": true } }, async (logs) => {
    const url = new URL(logs.join("\n").match(/http:\/\/\S+/)![0]);
    const handshake = await fetch(url, { redirect: "manual" });
    await handshake.body?.cancel();
    const cookie = handshake.headers.get("set-cookie")!.split(";")[0];
    const res = await fetch(new URL("/api/generate", url), {
      method: "POST",
      headers: { cookie, origin: url.origin },
      body: new FormData(),
    });
    assertEquals(res.status, 403);
    assertEquals((await res.json()).reason, "read-only");
  });
  assertStringIncludes(logs.join("\n"), "read-only");
  assertEquals(exits, []);
});

Deno.test("ui --quiet prints nothing", async () => {
  const { logs } = await serve({ global: { quiet: true } }, () => {});
  assertEquals(logs, []);
});

Deno.test("the verb is declared as a non-module-loading, loopback-only GUI", () => {
  assertEquals(uiCommand.name, "ui");
  assertEquals(uiCommand.loadsModules, false);
  const flags = (uiCommand.flags ?? []).map((f) => f.name).sort();
  assertEquals(flags, ["no-open", "port", "read-only", "token", "ui-dev"]);
  assertEquals((uiCommand.flags ?? []).find((f) => f.name === "port")?.default, DEFAULT_UI_PORT);
  assert(!uiCommand.usage?.includes("--host"), "the UI never offers a non-loopback bind");
});

Deno.test("openCommand shapes the browser launch per platform, array args only", () => {
  assertEquals(openCommand("http://localhost:5177/", "darwin"), ["open", "http://localhost:5177/"]);
  assertEquals(openCommand("http://localhost:5177/", "linux"), [
    "xdg-open",
    "http://localhost:5177/",
  ]);
  assertEquals(openCommand("http://localhost:5177/", "windows"), [
    "cmd",
    "/c",
    "start",
    "",
    "http://localhost:5177/",
  ]);
  assertEquals(openCommand("http://localhost:5177/", "android"), null);
  // The URL is always its own argv element — never spliced into a shell string.
  const argv = openCommand('http://localhost:5177/?t=a"&rm -rf /', "darwin")!;
  assertEquals(argv.length, 2);
  assertStringIncludes(argv[1], "rm -rf /");
});
