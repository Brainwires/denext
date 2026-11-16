// The Database section's child runner and field readers (src/ui/features/database-kit.ts).
//
// The panel suites script the runner (`setDbChildRunner`); this drives the real one against a
// stand-in `deno` (`DENO_BIN`): the envelope goes in on stdin, a JSON reply comes back, and every
// other outcome — no answer, a crash naming a connection string, a child that cannot start — is a
// `query_failed` with a masked reason, never a throw. Then the readers that pull a form's, a JSON
// body's or a query string's fields.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { SseClients } from "../src/build/sse.ts";
import { ask, carried, prefixed } from "../src/ui/features/database-kit.ts";
import type { UiContext } from "../src/ui/html.ts";

/** A context as the kernel builds one. */
function context(
  dir: string,
  init: { form?: FormData; body?: unknown; search?: string; signal?: AbortSignal } = {},
): UiContext {
  return {
    dir,
    url: new URL(`http://127.0.0.1:5177/database${init.search ?? ""}`),
    method: init.form || init.body ? "POST" : "GET",
    readOnly: true,
    csrf: "csrf-token",
    json: true,
    fragment: false,
    form: init.form,
    body: init.body,
    events: new Set() as SseClients,
    signal: init.signal,
  };
}

/** Run `fn` with `DENO_BIN` set, restoring it after. */
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

/** A stand-in `deno` that runs `body` (a POSIX shell script body). */
async function fakeDeno(dir: string, body: string): Promise<string> {
  const bin = join(dir, "fake-deno.sh");
  await Deno.writeTextFile(bin, `#!/bin/sh\n${body}\n`);
  await Deno.chmod(bin, 0o755);
  return bin;
}

const POSIX = Deno.build.os !== "windows";

Deno.test({
  name: "database child: the envelope goes in on stdin and the JSON reply is the answer",
  ignore: !POSIX,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "dnx-db-kit-" });
    try {
      // Echo the envelope back inside a pretty-printed reply (as the CLI writes it), after a line
      // project code printed, so the document span is really looked for.
      const bin = await fakeDeno(
        dir,
        `env=$(cat)\necho "Check file:///app/denext.config.ts" >&2\n` +
          `printf 'migrating\\n{\\n  "ok": true,\\n  "data": %s\\n}\\n' "$env"`,
      );
      await withDenoBin(bin, async () => {
        const reply = await ask(context(dir, { signal: new AbortController().signal }), {
          op: "overview",
        });
        assertEquals(reply, {
          ok: true,
          data: { readOnly: true, request: { op: "overview" } },
        } as never);
      });
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "database child: no answer is query_failed with stderr's last line, its password masked",
  ignore: !POSIX,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "dnx-db-kit-" });
    try {
      const bin = await fakeDeno(
        dir,
        `cat >/dev/null\necho "connecting" >&2\n` +
          `echo "error: could not reach postgres://app:hunter2@db:5432/app" >&2\n\necho >&2\nexit 1`,
      );
      await withDenoBin(bin, async () => {
        const reply = await ask(context(dir), { op: "overview" });
        assertEquals(reply, {
          ok: false,
          code: "query_failed",
          reason: "error: could not reach postgres://app:•••@db:5432/app",
        } as never);
      });
      // A child that prints nothing at all.
      const silent = await fakeDeno(dir, "cat >/dev/null\nexit 0");
      await withDenoBin(silent, async () => {
        const reply = await ask(context(dir), { op: "overview" });
        assertEquals(reply, {
          ok: false,
          code: "query_failed",
          reason: "the database child printed no answer",
        } as never);
      });
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("database child: one that cannot start is query_failed, not a throw", async () => {
  const dir = await Deno.makeTempDir({ prefix: "dnx-db-kit-" });
  try {
    await withDenoBin(join(dir, "no-such-deno"), async () => {
      const reply = await ask(context(dir), { op: "overview" });
      assertEquals(reply.ok, false);
      assertEquals((reply as { code: string }).code, "query_failed");
      assertStringIncludes((reply as { reason: string }).reason, "no-such-deno");
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("prefixed: a form, a JSON body or the query string, each read for one prefix", () => {
  const form = new FormData();
  form.set("col.name", "Ada");
  form.set("col.file", new File(["x"], "x.txt")); // not a string: never a field value
  form.set("other", "no");
  assertEquals(prefixed(context("/p", { form }), "col."), { name: "Ada" });
  assertEquals(
    prefixed(context("/p", { body: { "col.age": "36", "col.n": 5, op: "insert" } }), "col."),
    { age: "36" },
  );
  assertEquals(prefixed(context("/p", { search: "?col.id=7&page=2" }), "col."), { id: "7" });
});

Deno.test("carried: everything but op and the CSRF field, from a form or a JSON body", () => {
  const form = new FormData();
  form.set("op", "apply");
  form.set("_csrf", "token");
  form.set("sql", "select 1");
  const fromForm = carried(context("/p", { form }));
  assertEquals(fromForm.sql, "select 1");
  assertEquals(fromForm.op, undefined);
  assertEquals(
    carried(context("/p", { body: { op: "apply", sql: "select 2", limit: 5 } })),
    { sql: "select 2" },
  );
  assertEquals(carried(context("/p", { search: "?sql=x" })), {}, "a GET carries nothing");
});
