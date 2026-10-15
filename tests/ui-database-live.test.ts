// `denext ui` → Database: Realtime, Edge Functions and Health, driven on loopback as a browser
// with JavaScript disabled drives them, with the `db-admin` child, the running app (its admin
// endpoint and `/_denext/health`) and `docker compose` all answered in-process. Covers: the secret
// key goes to the app (and only to the dev server `.denext/dev.json` names) as the `apikey`
// header, and is never rendered; presence shows KEYS, and a key's payload only when expanded; the
// publication opt-in previews and then runs like every other write, refused under `--read-only`
// and without the CSRF token; Edge Functions list from the app (or from the files without one),
// with recent invocations; Health reads every service, the app's checks and the supervision tree,
// redacts an error, and refreshes with scripting off (a `<noscript>` meta refresh) and on.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { fakeDevJson, type Harness, postTo, stopUi, uiOn } from "./helpers/ui-panel.ts";
import { type DbChildRunner, setDbChildRunner } from "../src/ui/features/database.ts";
import type { DbEnvelope, DbReply } from "../src/ui/database/protocol.ts";
import { setAppFetch } from "../src/ui/app-admin.ts";
import { setDockerRunner } from "../src/ui/logs/source.ts";

const KEY = "sb_secret_live_test_key";

const PROJECT = {
  ".env": `DATABASE_URL=postgres://app:pw@127.0.0.1:5432/app\nDENEXT_SECRET_KEY=${KEY}\n` +
    "SOME_TOKEN=leaked-token-value\n",
  "docker-compose.yml": "services:\n  web:\n    image: x\n",
  "functions/hello/index.ts": "export default () => new Response('hi');\n",
};

/** What the running app answers, and what it was asked. */
interface AppCalls {
  urls: string[];
  keys: (string | null)[];
}

/** The admin status the fake app reports. */
const STATUS = {
  ok: true,
  realtime: {
    connections: 3,
    channels: [{ topic: "lobby", private: false, subscribers: 2 }],
    bindings: [{
      topic: "db",
      tables: ["notes"],
      filter: "owner=eq.leaked-token-value",
      events: ["insert"],
    }],
  },
  functions: {
    functions: [{ name: "hello", verifyJwt: false, modified: 0 }],
    invocations: [
      { name: "hello", status: 200, ms: 4, at: 0 },
      { name: "hello", status: 500, ms: 9, at: 1000 },
    ],
  },
  services: [{
    name: "services",
    path: "services",
    kind: "supervisor",
    state: "running",
    restarts: 1,
    since: 0,
    strategy: "one_for_one",
    intensity: 3,
    period: 5000,
    children: [{
      name: "queue",
      path: "services/queue",
      kind: "service",
      state: "restarting",
      restarts: 1,
      since: 0,
      retryAt: 10,
      lastError: { message: "auth failed with leaked-token-value", at: 0 },
    }],
  }],
};

/** Run `fn` against a UI on the project with a running (fake) app, child and Docker. */
async function withLive(
  fn: (h: Harness, sent: DbEnvelope[], calls: AppCalls) => Promise<void>,
  opts: { readOnly?: boolean; offline?: boolean; app?: boolean } = {},
): Promise<void> {
  const sent: DbEnvelope[] = [];
  const calls: AppCalls = { urls: [], keys: [] };
  const runner: DbChildRunner = (envelope) => {
    sent.push(envelope);
    if (envelope.request.op === "realtimeTables") {
      return Promise.resolve({
        ok: true,
        configured: true,
        publication: "supabase_realtime",
        publicationExists: true,
        source: "notify",
        tables: [
          {
            schema: "public",
            name: "notes",
            configured: false,
            inPublication: false,
            triggerEvents: [],
            primaryKeyColumns: 1,
            rls: true,
          },
          {
            schema: "public",
            name: "pairs",
            configured: false,
            inPublication: false,
            triggerEvents: [],
            primaryKeyColumns: 2,
            rls: false,
          },
        ],
      } as DbReply);
    }
    const confirm = (envelope.request as { confirm?: boolean }).confirm === true;
    return Promise.resolve({
      ok: true,
      statements: [{
        text: 'ALTER PUBLICATION "supabase_realtime" ADD TABLE "public"."notes"',
        params: [],
      }],
      applied: confirm,
    } as DbReply);
  };
  const previousRunner = setDbChildRunner(runner);
  const previousFetch = setAppFetch((url, init) => {
    calls.urls.push(url);
    calls.keys.push(new Headers(init.headers).get("apikey"));
    const path = new URL(url).pathname;
    if (path === "/_denext/health") {
      return Promise.resolve(
        Response.json({ status: "ok", checks: { database: "ok", services: "down" } }, {
          status: 503,
        }),
      );
    }
    if (path.endsWith("/status")) return Promise.resolve(Response.json(STATUS));
    const key = new URL(url).searchParams.get("key");
    return Promise.resolve(Response.json(
      key === null
        ? { ok: true, keys: { "visitor-1": 2 } }
        : { ok: true, key, payloads: [{ cursor: { x: 1 } }] },
    ));
  });
  const previousDocker = setDockerRunner((args) =>
    Promise.resolve({
      code: 0,
      stdout: args.includes("ps")
        ? JSON.stringify([
          { Service: "web", State: "running", Health: "healthy" },
          { Service: "db", State: "running", Health: "unhealthy" },
          { Service: "migrate", State: "exited", ExitCode: 0 },
        ])
        : "",
      stderr: "",
    })
  );
  const h = await uiOn(PROJECT, opts, "denext_ui_live_");
  if (opts.app !== false) await fakeDevJson(h.dir);
  try {
    await fn(h, sent, calls);
  } finally {
    setDbChildRunner(previousRunner);
    setAppFetch(previousFetch);
    setDockerRunner(previousDocker);
    await stopUi(h);
  }
}

/** A page's markup. */
async function get(h: Harness, path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${h.base}${path}`, { headers: h.headers });
  return { status: res.status, body: await res.text() };
}

Deno.test("Realtime: tables with their opt-in, live channels and bindings; the key never shown", async () => {
  await withLive(async (h, _sent, calls) => {
    const { status, body } = await get(h, "/database/realtime");
    assertEquals(status, 200);
    assertStringIncludes(body, 'href="/database/realtime" aria-current="page"');
    assertStringIncludes(body, "Add to publication…");
    assertStringIncludes(body, "needs a one-column primary key", "pairs cannot opt in");
    assertStringIncludes(body, "<td>2</td>", "lobby's subscribers");
    assertStringIncludes(body, 'href="/database/realtime/presence?topic=lobby"');
    assertStringIncludes(body, "owner=eq.•••", "a filter is redacted");
    assert(!body.includes(KEY) && !body.includes("leaked-token-value"));
    const dev = JSON.parse(await Deno.readTextFile(join(h.dir, ".denext", "dev.json"))).origin;
    assertEquals(calls.urls, [`${dev}/_denext/backend/admin/status`]);
    assertEquals(calls.keys, [KEY], "the secret key, as apikey, to the dev server");
  });
});

Deno.test("Realtime: without a running app the database half still renders", async () => {
  await withLive(async (h, _sent, calls) => {
    const { body } = await get(h, "/database/realtime");
    assertStringIncludes(body, "No running app");
    assertStringIncludes(body, "public.notes");
    assertEquals(calls.urls, []);
  }, { app: false });
});

Deno.test("Presence: keys only; one key's payload when expanded", async () => {
  await withLive(async (h, _sent, calls) => {
    const keys = (await get(h, "/database/realtime/presence?topic=lobby")).body;
    assertStringIncludes(keys, "visitor-1");
    assertStringIncludes(keys, 'href="/database/realtime/presence?topic=lobby&amp;key=visitor-1"');
    assert(!keys.includes("cursor"), "no payload until a key is expanded");
    const one = (await get(h, "/database/realtime/presence?topic=lobby&key=visitor-1")).body;
    assertStringIncludes(one, "&quot;cursor&quot;");
    assertEquals(new URL(calls.urls[1]).searchParams.get("key"), "visitor-1");
    const bad = await get(h, `/database/realtime/presence?topic=${"x".repeat(300)}`);
    assertStringIncludes(bad.body, "at most 255");
  });
});

Deno.test("Realtime opt-in: a preview, then the run and a 303; CSRF and --read-only refuse", async () => {
  await withLive(async (h, sent) => {
    const preview = await postTo(h, {
      op: "preview",
      action: "add",
      schema: "public",
      table: "notes",
    }, "/database/realtime");
    const page = await preview.text();
    assertStringIncludes(page, "Add public.notes to realtime&#39;s publication?");
    assertStringIncludes(page, "ALTER PUBLICATION");
    assertStringIncludes(page, 'name="op" value="apply"');
    const run = await postTo(
      h,
      { op: "apply", action: "add", schema: "public", table: "notes" },
      "/database/realtime",
    );
    assertEquals([run.status, run.headers.get("location")], [303, "/database/realtime?done=added"]);
    assertEquals(sent.at(-1)?.request, {
      op: "realtimePublication",
      schema: "public",
      table: "notes",
      action: "add",
      confirm: true,
    });
    const count = sent.length;
    const form = new FormData();
    form.set("op", "apply");
    form.set("action", "drop");
    form.set("schema", "public");
    form.set("table", "notes");
    const forged = await fetch(`${h.base}/database/realtime`, {
      method: "POST",
      headers: { ...h.headers, origin: h.base },
      body: form,
    });
    assertEquals(forged.status, 403, "no CSRF token");
    await forged.body?.cancel();
    assertEquals(sent.length, count);
  });
  await withLive(async (h, sent) => {
    const res = await postTo(
      h,
      { op: "apply", action: "add", schema: "public", table: "notes" },
      "/database/realtime",
    );
    assertEquals(res.status, 403);
    await res.body?.cancel();
    assertEquals(sent, []);
  }, { readOnly: true });
});

Deno.test("Edge Functions: from the app with invocations; from the files without one", async () => {
  await withLive(async (h) => {
    const { body } = await get(h, "/database/functions");
    assertStringIncludes(body, ">public<", "verifyJwt: false");
    assertStringIncludes(body, "<td>4 ms</td>");
    assertStringIncludes(body, '<span class="badge fail">500</span>');
    assertStringIncludes(body, '<select name="fn" aria-label="Function">');
    const only =
      await (await fetch(`${h.base}/api/database/functions?fn=hello`, { headers: h.headers }))
        .json();
    assertEquals(only.invocations.length, 2);
    assert(!body.includes(KEY));
  });
  await withLive(async (h) => {
    const { body } = await get(h, "/database/functions");
    assertStringIncludes(body, "hello");
    assertStringIncludes(body, ">unknown<");
    assertStringIncludes(body, "No running app");
  }, { app: false });
});

Deno.test("Health: services, the app's checks, the supervision tree; refreshes with and without JS", async () => {
  await withLive(async (h) => {
    const { body } = await get(h, "/database/health?refresh=30");
    assertStringIncludes(body, '<noscript><meta http-equiv="refresh" content="30"></noscript>');
    assertStringIncludes(body, 'data-refresh="30"');
    assertStringIncludes(body, '<option value="30" selected="">');
    assertStringIncludes(body, '<span class="badge fail">unhealthy</span>', "db's check");
    assertStringIncludes(body, "completed", "a one-shot that exited 0");
    assertStringIncludes(body, "degraded (503)");
    assertStringIncludes(body, '<span class="badge fail">down</span>', "the services check");
    assertStringIncludes(body, "services/queue");
    assertStringIncludes(body, "auth failed with •••", "an error message is redacted");
    assert(!body.includes("leaked-token-value") && !body.includes(KEY));
    const off = (await get(h, "/database/health?refresh=0")).body;
    assert(!off.includes('http-equiv="refresh"') && !off.includes("data-refresh"));
    const fallback = (await get(h, "/database/health?refresh=7")).body;
    assertStringIncludes(fallback, 'content="15"', "an interval off the list is 15 s");
  });
});

Deno.test("Health and Functions stay available --offline; Realtime is refused", async () => {
  await withLive(async (h) => {
    assertEquals((await get(h, "/database/health")).status, 200);
    assertEquals((await get(h, "/database/functions")).status, 200);
    assertEquals((await get(h, "/database/realtime")).status, 503);
  }, { offline: true });
});
