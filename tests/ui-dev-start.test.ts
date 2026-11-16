// `/dev`'s Start: the `denext dev` child it spawns, streamed to every open page.
//
// The panel suite (ui-dev-feature.test.ts) drives everything that needs no child. This one runs
// the start path end to end against a stand-in `deno` (`DENO_BIN`, the override the UI's spawner
// honours): a script that prints a line on each stream, publishes `.denext/dev.json` the way a
// real dev server does, and exits. What the page must do with that: stream each line to every
// open page and into the log a reload shows, announce the published address, report the exit,
// and refuse to race a second dev server onto the project while the first is coming up.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { SseClients } from "../src/build/sse.ts";
import { devPanel } from "../src/ui/features/dev.ts";
import type { UiContext } from "../src/ui/html.ts";
import { clearDevLog, devLogText } from "../src/ui/dev-log.ts";

/** A `/_ui/events` subscriber that keeps every broadcast event. */
function recorder(): { events: SseClients; seen: Record<string, unknown>[] } {
  const seen: Record<string, unknown>[] = [];
  const decoder = new TextDecoder();
  const controller = {
    enqueue(chunk: Uint8Array) {
      const text = decoder.decode(chunk);
      const m = /^data: (.*)\n\n$/s.exec(text);
      if (m) seen.push(JSON.parse(m[1]));
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  return { events: new Set([controller]), seen };
}

/** A hand-built request context, as the kernel would assemble it. */
function context(
  dir: string,
  events: SseClients,
  init: { method?: string; op?: string; json?: boolean; signal?: AbortSignal } = {},
): UiContext {
  const form = init.op === undefined ? undefined : new FormData();
  if (init.op !== undefined) form?.set("op", init.op);
  return {
    dir,
    url: new URL(`http://127.0.0.1:5177${init.json ? "/api/dev" : "/dev"}`),
    method: init.method ?? (form ? "POST" : "GET"),
    readOnly: false,
    csrf: "csrf-token",
    json: init.json === true,
    fragment: false,
    form,
    events,
    signal: init.signal,
  };
}

/** Wait until `done()` holds (at most `ms`). */
async function until(done: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Run `fn` with `DENO_BIN` pointed at `bin`, restoring it after. */
async function withDenoBin(bin: string, fn: () => Promise<void>): Promise<void> {
  const before = Deno.env.get("DENO_BIN");
  Deno.env.set("DENO_BIN", bin);
  try {
    await fn();
  } finally {
    if (before === undefined) Deno.env.delete("DENO_BIN");
    else Deno.env.set("DENO_BIN", before);
  }
}

const DEV_JSON = JSON.stringify({ origin: "http://127.0.0.1:9", pid: 2147483646 });

Deno.test({
  name:
    "starting dev streams the child's output, announces the address and the exit, and refuses a second start meanwhile",
  ignore: Deno.build.os === "windows", // the stand-in is a POSIX shell script
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "denext_ui_dev_start_" });
    const bin = join(dir, "fake-deno.sh");
    // Hold dev.json back long enough for the second POST to find the first still starting.
    await Deno.writeTextFile(
      bin,
      `#!/bin/sh\necho "fake dev: compiling"\necho "fake dev: a warning" >&2\nsleep 1\n` +
        `mkdir -p .denext\nprintf '%s' '${DEV_JSON}' > .denext/dev.json\nsleep 0.7\nexit 3\n`,
    );
    await Deno.chmod(bin, 0o755);
    const { events, seen } = recorder();
    try {
      await withDenoBin(bin, async () => {
        const first = await devPanel(
          new Request("http://x/dev"),
          context(dir, events, { op: "dev" }),
        );
        assertEquals(first.status, 200, "answered in place");
        assertStringIncludes(await first.text(), "Starting denext dev");
        const second = await devPanel(
          new Request("http://x/dev"),
          context(dir, events, { op: "dev", json: true }),
        );
        const twin = await second.json();
        assertEquals(twin.ok, true);
        assertStringIncludes(twin.outcome.message, "already starting");
        await until(() => seen.some((e) => e.type === "dev-exit"));
      });
      const lines = seen.filter((e) => e.type === "dev-output").map((e) => e.line);
      assert(lines.includes("fake dev: compiling"), `stdout streamed: ${lines}`);
      assert(lines.includes("fake dev: a warning"), `stderr streamed: ${lines}`);
      assertEquals(seen.find((e) => e.type === "dev-ready")?.url, "http://127.0.0.1:9");
      assertEquals(seen.find((e) => e.type === "dev-exit")?.code, 3);
      // A reload shows what streamed, closed by the exit line.
      const log = devLogText(dir);
      assertStringIncludes(log, "fake dev: compiling");
      assertStringIncludes(log, "— exited 3");
      // And the page now reports the server the child published.
      const page = await (await devPanel(new Request("http://x/dev"), context(dir, events))).text();
      assertStringIncludes(page, "Dev server running at");
      assertStringIncludes(page, "Stop denext dev");
    } finally {
      clearDevLog(dir);
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("a dev child that cannot be spawned is reported on the stream and in the log", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_dev_start_" });
  const { events, seen } = recorder();
  try {
    await withDenoBin(join(dir, "no-such-deno"), async () => {
      const res = await devPanel(new Request("http://x/dev"), context(dir, events, { op: "dev" }));
      assertEquals(res.status, 200);
      await res.body?.cancel();
      await until(() => seen.some((e) => e.type === "dev-output"));
    });
    const line = String(seen.find((e) => e.type === "dev-output")?.line);
    assert(line.startsWith("denext dev failed: "), line);
    assertStringIncludes(devLogText(dir), "denext dev failed: ");
    // The address poll is still waiting for a dev.json: give it one so it ends.
    await Deno.mkdir(join(dir, ".denext"));
    await Deno.writeTextFile(join(dir, ".denext", "dev.json"), DEV_JSON);
    await until(() => seen.some((e) => e.type === "dev-ready"));
  } finally {
    clearDevLog(dir);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an unknown dev operation is a 400 that names it, and never reaches a subprocess", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_dev_start_" });
  try {
    const res = await devPanel(
      new Request("http://x/dev"),
      context(dir, new Set(), { op: "rm -rf" }),
    );
    assertEquals(res.status, 400);
    assertEquals(await res.json(), { ok: false, reason: 'unknown dev operation "rm -rf"' });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stopping a server whose dev.json names a dead origin answers in JSON with the outcome", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_dev_start_" });
  const { events, seen } = recorder();
  try {
    await Deno.mkdir(join(dir, ".denext"));
    await Deno.writeTextFile(join(dir, ".denext", "dev.json"), DEV_JSON);
    const res = await devPanel(
      new Request("http://x/api/dev"),
      context(dir, events, { op: "stop", json: true }),
    );
    const body = await res.json();
    assertEquals(body.running, false, "the stale dev.json is gone");
    assertEquals(typeof body.outcome.message, "string");
    assertEquals(res.status, body.outcome.ok ? 200 : 400);
    assert(seen.some((e) => e.type === "dev-stopped"), "every other page hears about it");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
