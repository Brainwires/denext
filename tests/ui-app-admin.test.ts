// How `denext ui` / `denext dashboard` reach the running app (src/ui/app-admin.ts): which app and
// key it uses, and how each kind of answer — none, a redirect, an error, a body that is not JSON —
// becomes a reason the page can show rather than a throw. The redirect refusal has its own suite
// (ui-app-admin-redirect.test.ts); the fetch is scripted through `setAppFetch` here.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  adminPresence,
  adminStatus,
  type AppFetch,
  appProbe,
  appTarget,
  secretKey,
  setAppFetch,
} from "../src/ui/app-admin.ts";

/** Run `fn` with the app fetch replaced. */
async function withFetch(fetcher: AppFetch, fn: () => Promise<void>): Promise<void> {
  const previous = setAppFetch(fetcher);
  try {
    await fn();
  } finally {
    setAppFetch(previous);
  }
}

/** Run `fn` with `DENEXT_SECRET_KEY` set to `value` (or unset), restoring it after. */
async function withKeyEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const before = Deno.env.get("DENEXT_SECRET_KEY");
  if (value === undefined) Deno.env.delete("DENEXT_SECRET_KEY");
  else Deno.env.set("DENEXT_SECRET_KEY", value);
  try {
    await fn();
  } finally {
    if (before === undefined) Deno.env.delete("DENEXT_SECRET_KEY");
    else Deno.env.set("DENEXT_SECRET_KEY", before);
  }
}

const TARGET = { url: "http://web:3000/", key: "sk_test" };

Deno.test("secretKey: the environment's first key wins, else the project's .env, else none", async () => {
  const dir = await Deno.makeTempDir({ prefix: "dnx-app-admin-" });
  try {
    await withKeyEnv(" , sk_env_1, sk_env_old", async () => {
      assertEquals(await secretKey(dir), "sk_env_1", "rotation lists the current key first");
    });
    await withKeyEnv(undefined, async () => {
      assertEquals(await secretKey(dir), null, "no .env");
      await Deno.writeTextFile(join(dir, ".env"), "DENEXT_SECRET_KEY=sk_file,sk_prev\n");
      assertEquals(await secretKey(dir), "sk_file");
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("appTarget: a configured app wins; else the dev server the project published; else none", async () => {
  const dir = await Deno.makeTempDir({ prefix: "dnx-app-admin-" });
  try {
    assertEquals(await appTarget({ dir, app: TARGET }), TARGET);
    assertEquals(await appTarget({ dir }), null, "no dev server published");
    await Deno.mkdir(join(dir, ".denext"));
    await Deno.writeTextFile(
      join(dir, ".denext", "dev.json"),
      JSON.stringify({ origin: "http://127.0.0.1:4100", pid: 2147483646 }),
    );
    await withKeyEnv("sk_dev", async () => {
      assertEquals(await appTarget({ dir }), { url: "http://127.0.0.1:4100", key: "sk_dev" });
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("admin calls: no key is refused before any request", async () => {
  const asked: string[] = [];
  await withFetch((url) => {
    asked.push(url);
    return Promise.resolve(Response.json({}));
  }, async () => {
    const status = await adminStatus({ url: "http://web:3000", key: null });
    assertStringIncludes((status as { reason: string }).reason, "needs the backend's secret key");
    const presence = await adminPresence({ url: "http://web:3000", key: null }, "t", false, null);
    assertEquals(presence.ok, false);
  });
  assertEquals(asked, []);
});

Deno.test("admin calls: the key rides as apikey; no answer, an error status and a non-JSON body are reasons", async () => {
  const seen: { url: string; apikey: string | null }[] = [];
  let answer: () => Promise<Response> = () => Promise.reject(new TypeError("connection refused"));
  await withFetch((url, init) => {
    seen.push({ url, apikey: new Headers(init.headers).get("apikey") });
    return answer();
  }, async () => {
    assertEquals(await adminStatus(TARGET), {
      ok: false,
      reason: "the app at http://web:3000/ did not answer",
    } as never);
    answer = () => Promise.resolve(Response.json({ reason: "bad key" }, { status: 401 }));
    assertEquals(await adminStatus(TARGET), {
      ok: false,
      reason: "the app answered 401: bad key",
    } as never);
    answer = () => Promise.resolve(new Response("<html>", { status: 200 }));
    assertEquals(await adminStatus(TARGET), {
      ok: false,
      reason: "the app answered 200: no reason",
    } as never);
    answer = () => Promise.resolve(Response.json({ ok: true, keys: { alice: 2 } }));
    assertEquals(await adminPresence(TARGET, "room:1", true, "alice"), {
      ok: true,
      keys: { alice: 2 },
    });
  });
  assertEquals(seen[0], { url: "http://web:3000/_denext/backend/admin/status", apikey: "sk_test" });
  const presence = new URL(seen[3].url);
  assertEquals(presence.pathname, "/_denext/backend/admin/presence");
  assertEquals(
    [...presence.searchParams],
    [["topic", "room:1"], ["private", "1"], ["key", "alice"]],
  );
});

Deno.test("appProbe: ok, degraded on an error or a redirect, unreachable when nothing answers", async () => {
  let answer: () => Promise<Response> = () =>
    Promise.resolve(Response.json({ checks: { db: "ok" } }));
  await withFetch((url) => {
    assertEquals(url, "http://web:3000/_denext/health", "the trailing slash is not doubled");
    return answer();
  }, async () => {
    assertEquals(await appProbe(TARGET), { status: "ok", httpStatus: 200, checks: { db: "ok" } });
    answer = () => Promise.resolve(Response.json({ checks: "nope" }, { status: 503 }));
    assertEquals(await appProbe(TARGET), { status: "degraded", httpStatus: 503, checks: {} });
    answer = () =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: "/login" } }));
    assertEquals(await appProbe(TARGET), { status: "degraded", httpStatus: 302, checks: {} });
    answer = () => Promise.reject(new TypeError("dns"));
    assertEquals(await appProbe(TARGET), { status: "unreachable", checks: {} });
  });
});
