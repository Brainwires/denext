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
import {
  backoffDelay,
  deliverWebhooks,
  installWebhooks,
  resolveWebhooks,
  signWebhook,
  startWebhookDelivery,
  targetFor,
  verifyWebhook,
  WEBHOOK_CHANNEL,
  webhookEvents,
  webhooksMigrations,
} from "../packages/backend/src/webhooks.ts";
import { installPostgres } from "../packages/backend/src/postgres.ts";
import { type ScriptedSql, scriptedSql } from "./helpers/scripted-sql.ts";

const SECRET = "whsec_" + btoa("0123456789abcdef");

Deno.test("resolveWebhooks: defaults and validation", () => {
  const r = resolveWebhooks(
    {},
    (name) => (name === "DENEXT_WEBHOOK_SECRET" ? "from-env" : undefined),
  );
  assertEquals(
    [r.secret, r.maxAttempts, r.backoffMs, r.maxBackoffMs, r.pollIntervalMs, r.delivery, r.migrate],
    ["from-env", 8, 10_000, 3_600_000, 5000, "auto", true],
  );
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
  let passes = 0;
  const sql = scriptedSql((text) => {
    if (text.includes("WITH due AS")) passes++;
    return [];
  }, { withListen: true });
  installPostgres({ sql, rls: { migrate: false } });
  const config = resolveWebhooks({ pollIntervalMs: 20, migrate: false });
  installWebhooks(config);
  try {
    const stop = startWebhookDelivery(config);
    await new Promise((r) => setTimeout(r, 5));
    assert(sql.listeners.has(WEBHOOK_CHANNEL));
    sql.listeners.get(WEBHOOK_CHANNEL)!();
    sql.listeners.get(WEBHOOK_CHANNEL)!(); // while one runs: coalesced into one more
    await new Promise((r) => setTimeout(r, 70));
    const seen = passes;
    assert(seen >= 3, `passes: ${seen}`);
    await stop();
    assert(!sql.listeners.has(WEBHOOK_CHANNEL), "unlistened");
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(passes, seen, "no pass after stop");
  } finally {
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
    const stop = startWebhookDelivery(config);
    await new Promise((r) => setTimeout(r, 20));
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
