// `@denext/backend` database webhooks on a scripted Postgres and a fake `fetch`: option
// validation, where an event may go (configured hooks and allowed URLs only), Standard Webhooks
// signing and verification, the delivery pass (lease, send, record success / retry / failure),
// the background deliverer (timer, NOTIFY, stop) and the event listing. The trigger and the
// leasing SQL run against a real Postgres in tests/backend-platform-integration.test.ts.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  backoffDelay,
  deliverWebhooks,
  installWebhooks,
  nextPollDelay,
  purgeWebhookEvents,
  resolveWebhooks,
  signWebhook,
  startWebhookDelivery,
  targetFor,
  verifyWebhook,
  WEBHOOK_CHANNEL,
  webhookCleanupJob,
  webhookEvents,
  webhooksMigrations,
} from "../packages/backend/src/webhooks.ts";
import { installPostgres } from "../packages/backend/src/postgres.ts";
import { type ScriptedSql, scriptedSql } from "./helpers/scripted-sql.ts";

const SECRET = "whsec_" + btoa("0123456789abcdef");

/** The deliverer's timer seam, driven by hand: the waits it asked for and the armed callback. */
function handTimers() {
  let pending: (() => void) | undefined;
  const waits: number[] = [];
  return {
    waits,
    armed: () => pending !== undefined,
    fire: () => {
      const fn = pending;
      pending = undefined;
      fn?.();
    },
    set(fn: () => void, ms: number) {
      pending = fn;
      waits.push(ms);
      return fn;
    },
    clear(id: unknown) {
      if (id === pending) pending = undefined;
    },
  };
}

Deno.test("resolveWebhooks: defaults and validation", () => {
  const r = resolveWebhooks(
    {},
    (name) => (name === "DENEXT_WEBHOOK_SECRET" ? "from-env" : undefined),
  );
  assertEquals(
    [r.secret, r.maxAttempts, r.backoffMs, r.maxBackoffMs, r.pollIntervalMs, r.delivery, r.migrate],
    ["from-env", 8, 10_000, 3_600_000, 5000, "auto", true],
  );
  assertEquals(r.maxPollIntervalMs, 60_000);
  assertEquals(
    resolveWebhooks({ pollIntervalMs: 90_000 }).maxPollIntervalMs,
    90_000,
    "never below pollIntervalMs",
  );
  assertThrows(() => resolveWebhooks({ maxPollIntervalMs: 0 }), TypeError, "maxPollIntervalMs");
  assertEquals(
    resolveWebhooks({ hooks: { a: { url: "https://h.test/x" } } }).hooks.a.url,
    "https://h.test/x",
  );
  assertThrows(
    () => resolveWebhooks({ hooks: { "bad name": { url: "https://h.test" } } }),
    TypeError,
  );
  assertThrows(
    () => resolveWebhooks({ hooks: { a: { url: "not a url" } } }),
    TypeError,
    "not a URL",
  );
  assertThrows(() => resolveWebhooks({ hooks: { a: { url: "ftp://h.test" } } }), TypeError, "http");
  assertThrows(() => resolveWebhooks({ allowUrls: ["file:///etc/"] }), TypeError);
  assertThrows(() => resolveWebhooks({ delivery: "sometimes" as "auto" }), TypeError);
  assertThrows(() => resolveWebhooks({ maxAttempts: 0 }), TypeError);
});

Deno.test("targetFor: a configured hook, or an allowed URL prefix; nothing else", () => {
  const config = resolveWebhooks({
    hooks: { orders: { url: "https://h.test/orders", secret: "own" } },
    allowUrls: ["https://ok.test/hooks/"],
    secret: "default",
  });
  assertEquals(targetFor(config, "orders"), { url: "https://h.test/orders", secret: "own" });
  assertEquals(targetFor(config, "https://ok.test/hooks/a?x=1"), {
    url: "https://ok.test/hooks/a?x=1",
    secret: "default",
  });
  assertEquals(targetFor(config, "https://ok.test/hooksX"), null);
  assertEquals(targetFor(config, "https://ok.test.evil.test/hooks/"), null);
  assertEquals(targetFor(config, "http://169.254.169.254/"), null);
  assertEquals(targetFor(config, "unknown-name"), null);
});

Deno.test("backoffDelay: doubles from backoffMs, capped", () => {
  const config = resolveWebhooks({ backoffMs: 100, maxBackoffMs: 500 });
  assertEquals([1, 2, 3, 4, 10].map((n) => backoffDelay(config, n)), [100, 200, 400, 500, 500]);
});

Deno.test("signWebhook / verifyWebhook: Standard Webhooks, tamper and replay refused", async () => {
  const body = JSON.stringify({ type: "INSERT" });
  const now = Math.floor(Date.now() / 1000);
  const headers = await signWebhook(SECRET, "evt_1", now, body);
  assert(headers["webhook-signature"].startsWith("v1,"));
  const request = (h: Record<string, string>, b = body) =>
    new Request("https://x.test/", { method: "POST", headers: h, body: b });
  assertEquals(await verifyWebhook(request(headers), SECRET), { type: "INSERT" });
  // Several signatures (a rotated secret): any one matching is enough.
  assertEquals(
    await verifyWebhook(
      request({ ...headers, "webhook-signature": `v1,AAAA ${headers["webhook-signature"]}` }),
      SECRET,
    ),
    { type: "INSERT" },
  );
  assertEquals(await verifyWebhook(request(headers, body + " "), SECRET), null);
  assertEquals(await verifyWebhook(request(headers), "whsec_" + btoa("other")), null);
  const old = await signWebhook(SECRET, "evt_1", now - 3600, body);
  assertEquals(await verifyWebhook(request(old), SECRET), null, "outside the tolerance");
  assertEquals(await verifyWebhook(request({}), SECRET), null);
  const notJson = await signWebhook("plain secret", "evt_2", now, "x");
  assertEquals(await verifyWebhook(request(notJson, "x"), "plain secret"), null);
  // A whsec_ value that is not base64 is used as text.
  const odd = await signWebhook("whsec_***", "evt_3", now, body);
  assertEquals(await verifyWebhook(request(odd), "whsec_***"), { type: "INSERT" });
});

interface Event {
  id: string;
  hook: string;
  method: string;
  headers: unknown;
  params: unknown;
  timeout_ms: number | null;
  payload: unknown;
  attempts: number;
}

function events(list: Event[]): { sql: ScriptedSql; updates: unknown[][] } {
  const updates: unknown[][] = [];
  let leased = false;
  const sql = scriptedSql((text, params) => {
    if (text.includes("WITH due AS")) {
      if (leased) return [];
      leased = true;
      return list;
    }
    if (text.startsWith("UPDATE supabase_functions.webhook_events")) {
      updates.push(params);
      return [];
    }
    return [];
  }, { withListen: true });
  return { sql, updates };
}

const PAYLOAD = {
  type: "INSERT",
  table: "orders",
  schema: "public",
  record: { id: 1 },
  old_record: null,
};

Deno.test("deliverWebhooks: sends signed requests, records each outcome", async () => {
  const sent: Request[] = [];
  const fetcher = ((input: URL, init: RequestInit) => {
    const request = new Request(input, init);
    sent.push(request);
    const path = new URL(request.url).pathname;
    if (path === "/down") return Promise.resolve(new Response("no", { status: 503 }));
    if (path === "/throw") return Promise.reject(new Error("connection refused"));
    return Promise.resolve(new Response("ok"));
  }) as typeof fetch;
  const { sql, updates } = events([
    {
      id: "1",
      hook: "orders",
      method: "POST",
      headers: '{"x-extra":"1"}',
      params: '{"a":"b"}',
      timeout_ms: 1000,
      payload: PAYLOAD,
      attempts: 1,
    },
    {
      id: "2",
      hook: "down",
      method: "POST",
      headers: {},
      params: {},
      timeout_ms: null,
      payload: JSON.stringify(PAYLOAD),
      attempts: 1,
    },
    {
      id: "3",
      hook: "down",
      method: "POST",
      headers: {},
      params: {},
      timeout_ms: null,
      payload: PAYLOAD,
      attempts: 3,
    },
    {
      id: "4",
      hook: "https://evil.test/",
      method: "POST",
      headers: {},
      params: {},
      timeout_ms: null,
      payload: PAYLOAD,
      attempts: 1,
    },
    {
      id: "5",
      hook: "throws",
      method: "GET",
      headers: null,
      params: [],
      timeout_ms: null,
      payload: PAYLOAD,
      attempts: 1,
    },
    {
      id: "6",
      hook: "unsigned",
      method: "POST",
      headers: {},
      params: {},
      timeout_ms: null,
      payload: PAYLOAD,
      attempts: 1,
    },
  ]);
  installPostgres({ sql, rls: { migrate: false } });
  installWebhooks(resolveWebhooks({
    hooks: {
      orders: { url: "https://h.test/orders", secret: SECRET, headers: { "x-app": "denext" } },
      down: { url: "https://h.test/down", secret: SECRET },
      throws: { url: "https://h.test/throw", secret: SECRET },
      unsigned: { url: "https://h.test/plain" },
    },
    maxAttempts: 3,
    migrate: false,
    fetch: fetcher,
  }));
  try {
    assertEquals(await deliverWebhooks(), { delivered: 2, retrying: 2, failed: 2 });
    const orders = sent.find((r) => r.url.startsWith("https://h.test/orders"))!;
    assertEquals(new URL(orders.url).searchParams.get("a"), "b");
    assertEquals(orders.headers.get("x-extra"), "1");
    assertEquals(orders.headers.get("x-app"), "denext");
    assertEquals(orders.headers.get("content-type"), "application/json");
    assertEquals(orders.headers.get("webhook-id"), "evt_1");
    assertEquals(await verifyWebhook(orders, SECRET), PAYLOAD);
    assert(!sent.some((r) => r.url.startsWith("https://evil.test")), "never fetched");
    const get = sent.find((r) => r.url.startsWith("https://h.test/throw"))!;
    assertEquals([get.method, get.headers.get("content-type")], ["GET", null]);
    const plain = sent.find((r) => r.url.startsWith("https://h.test/plain"))!;
    assertEquals([plain.headers.get("webhook-id"), plain.headers.get("webhook-signature")], [
      "evt_6",
      null,
    ]);
    const byId = new Map(updates.map((u) => [u[0], u]));
    assertEquals(byId.get("1")?.[1], 200, "delivered: last_status");
    assertEquals(byId.get("2")?.slice(1, 4), ["pending", 503, "HTTP 503"]);
    assertEquals(byId.get("3")?.[1], "failed", "maxAttempts reached");
    assertEquals(byId.get("4")?.[1], "failed");
    assertStringIncludes(String(byId.get("4")?.[3]), "not configured");
    assertEquals(byId.get("5")?.slice(1, 4), ["pending", null, "connection refused"]);
  } finally {
    installWebhooks(undefined);
    installPostgres(undefined);
  }
});

Deno.test("deliverWebhooks: not configured is a clear error; the migration runs first", async () => {
  installWebhooks(undefined);
  await assertRejects(() => deliverWebhooks(), Error, "not configured");
  const { sql } = events([]);
  installPostgres({ sql, rls: { migrate: false } });
  installWebhooks(resolveWebhooks({}));
  try {
    assertEquals(await deliverWebhooks(), { delivered: 0, retrying: 0, failed: 0 });
    assert(
      sql.calls.some((c) =>
        c.text.includes("CREATE OR REPLACE FUNCTION supabase_functions.http_request")
      ),
    );
  } finally {
    installWebhooks(undefined);
    installPostgres(undefined);
  }
});

Deno.test("startWebhookDelivery: a pass at start, on NOTIFY and on the timer; stop ends it", async () => {
  // Driven step by step, never by the wall clock: the pass's lease query waits on a gate the
  // test opens, the interval's callback is captured and ticked by hand, and each check waits
  // for the pass count it expects.
  let passes = 0;
  const waiting: { n: number; wake: () => void }[] = [];
  const reached = (n: number) =>
    new Promise<void>((wake) => passes >= n ? wake() : waiting.push({ n, wake }));
  let open!: () => void;
  const gate = new Promise<void>((resolve) => open = resolve);
  const sql = scriptedSql(async (text) => {
    if (text.includes("WITH due AS")) {
      passes++;
      for (const w of waiting.splice(0)) passes >= w.n ? w.wake() : waiting.push(w);
      await gate;
    }
    return [];
  }, { withListen: true });
  // A pass's remaining work is promise continuations only: one macrotask turn finishes it.
  const settled = () => new Promise((r) => setTimeout(r, 0));
  installPostgres({ sql, rls: { migrate: false } });
  const config = resolveWebhooks({ pollIntervalMs: 20, migrate: false });
  installWebhooks(config);
  const timers = handTimers();
  const stop = startWebhookDelivery(config, timers);
  try {
    await reached(1); // the pass at start, held at the gate
    assert(!timers.armed(), "no timer while a pass runs");
    assert(sql.listeners.has(WEBHOOK_CHANNEL));
    const notify = sql.listeners.get(WEBHOOK_CHANNEL)!;
    notify();
    notify(); // while one runs: coalesced into one more
    open();
    await reached(2);
    await settled();
    assertEquals(passes, 2, "two NOTIFYs during a pass: one more pass");
    assert(timers.armed(), "the poll timer is armed after the pass");
    timers.fire();
    await reached(3); // the timer
    await settled();
    assertEquals(passes, 3);
    await stop();
    assert(!sql.listeners.has(WEBHOOK_CHANNEL), "unlistened");
    assert(!timers.armed(), "stop clears the timer");
    notify();
    await settled();
    assertEquals(passes, 3, "no pass after stop");
  } finally {
    open();
    installWebhooks(undefined);
    installPostgres(undefined);
  }
});

Deno.test("startWebhookDelivery: a failing pass is logged, not thrown", async () => {
  const sql = scriptedSql(() => {
    throw new Error("database down");
  });
  installPostgres({ sql, rls: { migrate: false } });
  const config = resolveWebhooks({ pollIntervalMs: 1000, migrate: false });
  installWebhooks(config);
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (line: string) => warnings.push(line);
  try {
    const stop = startWebhookDelivery(config, handTimers());
    // stop() waits for the pass in flight (the one at start), so its warning is written.
    await stop();
    assertStringIncludes(warnings.join("\n"), "database down");
  } finally {
    console.warn = warn;
    installWebhooks(undefined);
    installPostgres(undefined);
  }
});

Deno.test("webhookEvents: newest first, mapped", async () => {
  const sql = scriptedSql(() => [{
    id: "9",
    hook: "orders",
    status: "delivered",
    attempts: 1,
    last_status: 200,
    last_error: null,
    payload: JSON.stringify(PAYLOAD),
    created_at: "2026-10-13T00:00:00Z",
    delivered_at: "2026-10-13T00:00:01Z",
  }, {
    id: "8",
    hook: "x",
    status: "pending",
    attempts: 0,
    last_status: null,
    last_error: null,
    payload: PAYLOAD,
    created_at: "2026-10-13T00:00:00Z",
    delivered_at: null,
  }]);
  installPostgres({ sql, rls: { migrate: false } });
  installWebhooks(resolveWebhooks({ migrate: false }));
  try {
    const [first, second] = await webhookEvents({ status: "delivered", limit: 2 });
    assertEquals([first.id, first.lastStatus, first.payload], [9, 200, PAYLOAD]);
    assert(first.deliveredAt instanceof Date);
    assertEquals([second.lastStatus, second.deliveredAt], [null, null]);
    assertEquals(sql.calls[0].params, ["delivered", 2]);
  } finally {
    installWebhooks(undefined);
    installPostgres(undefined);
  }
});

Deno.test("webhooks migration: the trigger function, the event table, nothing for clients", () => {
  const [migration] = webhooksMigrations();
  for (
    const part of [
      "CREATE TABLE IF NOT EXISTS supabase_functions.webhook_events",
      "CREATE OR REPLACE FUNCTION supabase_functions.http_request() RETURNS trigger",
      "SECURITY DEFINER",
      "'old_record'",
      `pg_notify('${WEBHOOK_CHANNEL}'`,
      "REVOKE ALL ON supabase_functions.webhook_events FROM PUBLIC",
    ]
  ) assertStringIncludes(migration.sql, part);
});

Deno.test("resolveWebhooks: retention defaults to 7 days delivered, 30 failed; false keeps all", () => {
  assertEquals(resolveWebhooks({}).retention, {
    deliveredMs: 7 * 86_400_000,
    failedMs: 30 * 86_400_000,
  });
  assertEquals(resolveWebhooks({ retention: { deliveredMs: 60_000 } }).retention, {
    deliveredMs: 60_000,
    failedMs: 30 * 86_400_000,
  });
  assertEquals(resolveWebhooks({ retention: false }).retention, null);
  assertThrows(() => resolveWebhooks({ retention: { failedMs: 0 } }), TypeError, "failedMs");
  assertThrows(() => resolveWebhooks({ retention: "1d" as unknown as false }), TypeError);
});

Deno.test("purgeWebhookEvents: deletes settled events past the retention, in batches", async () => {
  const deletes: unknown[][] = [];
  let left = 1500;
  const sql = scriptedSql((text, params) => {
    if (!text.includes("WITH doomed AS")) return [];
    deletes.push(params);
    const n = Math.min(left, 1000);
    left -= n;
    return Array.from({ length: n }, (_, i) => ({ id: String(i) }));
  });
  installPostgres({ sql, rls: { migrate: false } });
  try {
    installWebhooks(resolveWebhooks({ migrate: false, retention: { deliveredMs: 60_000 } }));
    assertEquals(await purgeWebhookEvents(), { deleted: 1500 });
    assertEquals(deletes, [[60, 30 * 86_400, 1000], [60, 30 * 86_400, 1000]]);
    installWebhooks(resolveWebhooks({ migrate: false, retention: false }));
    assertEquals(await purgeWebhookEvents(), { deleted: 0 });
    assertEquals(deletes.length, 2, "retention: false deletes nothing");
    // The job form, for `delivery: "manual"`.
    installWebhooks(resolveWebhooks({ migrate: false }));
    left = 3;
    const job = webhookCleanupJob({ schedule: "17 * * * *" });
    assertEquals(job.schedule, "17 * * * *");
  } finally {
    installWebhooks(undefined);
    installPostgres(undefined);
  }
});

Deno.test("startWebhookDelivery: the retention cleanup runs after a pass, at most once an hour", async () => {
  let purges = 0;
  let passes = 0;
  const sql = scriptedSql((text) => {
    if (text.includes("WITH due AS")) passes++;
    if (text.includes("WITH doomed AS")) purges++;
    return [];
  });
  installPostgres({ sql, rls: { migrate: false } });
  const config = resolveWebhooks({ migrate: false });
  installWebhooks(config);
  const timers = handTimers();
  const stop = startWebhookDelivery(config, timers);
  const settled = async (n: number) => {
    for (let i = 0; i < 50 && passes < n; i++) await new Promise((r) => setTimeout(r, 1));
    await new Promise((r) => setTimeout(r, 5));
  };
  try {
    await settled(1);
    assertEquals(purges, 1, "the first pass cleans up");
    timers.fire();
    await settled(2);
    assertEquals([passes, purges], [2, 1], "not again within the hour");
  } finally {
    await stop();
    installWebhooks(undefined);
    installPostgres(undefined);
  }
});

Deno.test("nextPollDelay: back off while a LISTENing deliverer finds nothing, reset on work", () => {
  const config = resolveWebhooks({ migrate: false });
  let wait = config.pollIntervalMs;
  const idle: number[] = [];
  for (let i = 0; i < 6; i++) idle.push(wait = nextPollDelay(config, wait, false, true, null));
  assertEquals(idle, [10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  assertEquals(nextPollDelay(config, wait, true, true, null), 5000, "work resets the wait");
  assertEquals(nextPollDelay(config, 60_000, false, false, null), 5000, "no LISTEN: no back-off");
  assertEquals(nextPollDelay(config, 40_000, false, true, 12_345.2), 12_346, "a retry due sooner");
  assertEquals(nextPollDelay(config, 40_000, false, true, 0), 1, "one already due");
  assertEquals(nextPollDelay(config, 5000, false, true, 3_600_000), 10_000);
});

Deno.test("startWebhookDelivery: an idle LISTENing deliverer waits longer each pass; work resets it", async () => {
  let leased = 0;
  let dueIn: number | null = null;
  const sql = scriptedSql((text) => {
    if (text.includes("WITH due AS")) {
      if (leased === 0) return [];
      leased--;
      return [{
        id: "1",
        hook: "nowhere",
        method: "POST",
        headers: {},
        params: {},
        timeout_ms: null,
        payload: {},
        attempts: 1,
      }];
    }
    if (text.includes("min(next_attempt_at)")) return [{ ms: dueIn }];
    return [];
  }, { withListen: true });
  installPostgres({ sql, rls: { migrate: false } });
  const config = resolveWebhooks({ migrate: false, retention: false });
  installWebhooks(config);
  const timers = handTimers();
  const armed = async () => {
    for (let i = 0; i < 100 && !timers.armed(); i++) await new Promise((r) => setTimeout(r, 1));
    assert(timers.armed());
  };
  const stop = startWebhookDelivery(config, timers);
  try {
    await armed(); // the pass at start: nothing, and the client LISTENs
    for (let i = 0; i < 5; i++) {
      timers.fire();
      await armed();
    }
    assertEquals(timers.waits, [10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    leased = 1; // a NOTIFY brings work (an event with no target: recorded as failed)
    sql.listeners.get(WEBHOOK_CHANNEL)!();
    await armed();
    assertEquals(timers.waits.at(-1), 5000, "work resets the wait");
    dueIn = 7_000; // a retry due in 7 s caps the next wait
    timers.fire();
    await armed();
    assertEquals(timers.waits.at(-1), 7_000);
  } finally {
    await stop();
    installWebhooks(undefined);
    installPostgres(undefined);
  }
});

Deno.test("startWebhookDelivery: the default timers run the next pass, and stop clears them", async () => {
  // The real (unref'd) timers, in this process: the pass at start arms one, it fires the next
  // pass, and stop() clears the one armed after it. (The subprocess test below only shows the
  // timer never holds the process open.)
  let passes = 0;
  const waiting: { n: number; wake: () => void }[] = [];
  const reached = (n: number) =>
    new Promise<void>((wake) => passes >= n ? wake() : waiting.push({ n, wake }));
  const sql = scriptedSql((text) => {
    if (text.includes("WITH due AS")) {
      passes++;
      for (const w of waiting.splice(0)) passes >= w.n ? w.wake() : waiting.push(w);
    }
    return [];
  });
  installPostgres({ sql, rls: { migrate: false } });
  const config = resolveWebhooks({ pollIntervalMs: 10, migrate: false, retention: false });
  installWebhooks(config);
  // The deliverer's timers are unref'd, so something must hold the event loop while it runs.
  const hold = setInterval(() => {}, 1000);
  try {
    const stop = startWebhookDelivery(config);
    await reached(2);
    await stop();
    const after = passes;
    // Longer than any wait the deliverer could have armed (it doubles from 10 ms only while
    // LISTENing, and this client has no listen): a timer stop() missed would have fired.
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(passes, after, "no pass after stop");
  } finally {
    clearInterval(hold);
    installWebhooks(undefined);
    installPostgres(undefined);
  }
});

Deno.test("startWebhookDelivery: its timer never keeps the process alive", async () => {
  // A program that starts the deliverer and never stops it must still exit on its own.
  const script = `
    import { installPostgres } from ${
    JSON.stringify(import.meta.resolve("../packages/backend/src/postgres.ts"))
  };
    import { installWebhooks, resolveWebhooks, startWebhookDelivery } from ${
    JSON.stringify(import.meta.resolve("../packages/backend/src/webhooks.ts"))
  };
    import { scriptedSql } from ${JSON.stringify(import.meta.resolve("./helpers/scripted-sql.ts"))};
    installPostgres({ sql: scriptedSql(() => []), rls: { migrate: false } });
    const config = resolveWebhooks({ migrate: false, retention: false });
    installWebhooks(config);
    startWebhookDelivery(config);
  `;
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      "--no-check",
      "--config",
      // A file path, not the URL's pathname (`/C:/...` on Windows, which Deno can't open).
      fromFileUrl(new URL("../deno.json", import.meta.url)),
      script,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    const { code, stderr } = await child.output();
    assertEquals(code, 0, new TextDecoder().decode(stderr));
  } finally {
    clearTimeout(timeout);
  }
});
