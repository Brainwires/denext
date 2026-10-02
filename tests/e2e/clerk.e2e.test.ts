// Keyed e2e for examples/clerk: `@clerk/nextjs` on denext against a REAL Clerk development
// instance, in headless Chromium — the middleware, `<ClerkProvider>`, `auth()` in a Server
// Component and in a `defineApi` route.
//
// Needs the instance's keys: NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY (or
// CLERK_TEST_PUBLISHABLE_KEY + CLERK_TEST_SECRET_KEY, the CI secret names) in the environment,
// else `examples/clerk/.env` / `.env.local`. Without them the test is skipped with a message.
// Nothing here prints a key.
//
// It uses Clerk's test mode (every development instance has it): a `+clerk_test` address
// verifies with the fixed code 424242 and sends no email, and a testing token
// (`POST /v1/testing_tokens`, sent as `__clerk_testing_token`) bypasses bot protection. The
// user is created through the Backend API and deleted at the end, pass or fail.
//
// Opt-in + NETWORK-REQUIRED (npm install of the example, Clerk's API): `deno task test:e2e`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import type { Page } from "@astral/astral";
import { launchBrowser, pollFor, runDeno, startCliServer } from "./harness.ts";
import { clerkTestKeys } from "./clerk-keys.ts";

const EXAMPLE = fromFileUrl(new URL("../../examples/clerk", import.meta.url));
const CLI = fromFileUrl(new URL("../../cli.ts", import.meta.url));
const BAPI = "https://api.clerk.com/v1";
const TEST_CODE = "424242";

const keys = await clerkTestKeys(EXAMPLE);
if (!keys) {
  console.warn(
    "e2e: examples/clerk keyed test SKIPPED — set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY + " +
      "CLERK_SECRET_KEY (or CLERK_TEST_*), or put them in examples/clerk/.env.local.",
  );
}

/** A Backend API call with the secret key. */
async function bapi(method: string, path: string, body?: unknown): Promise<Response> {
  return await fetch(BAPI + path, {
    method,
    headers: {
      authorization: `Bearer ${keys!.secretKey}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** A JSON Backend API call that must succeed. */
async function bapiJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await bapi(method, path, body);
  const text = await res.text();
  if (!res.ok) throw new Error(`Clerk ${method} ${path}: ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

/** What a new user may need beyond email + password, per the instance's user requirements. */
function requiredField(param: string, tag: string): unknown {
  switch (param) {
    case "username":
      return `denext_e2e_${tag}`;
    case "first_name":
      return "Denext";
    case "last_name":
      return "E2E";
    case "phone_number":
      // A test number (555-0100…0199) verifies with 424242 and never sends an SMS.
      return [`+1201555${String(100 + (parseInt(tag.slice(0, 2), 16) % 100)).padStart(4, "0")}`];
    default:
      return undefined;
  }
}

/**
 * Create the test user: email (a `+clerk_test` address) and password, plus whatever else the
 * instance requires (a username, a name, a test phone number) when Clerk says it is missing.
 */
async function createTestUser(tag: string, email: string, password: string): Promise<string> {
  const body: Record<string, unknown> = {
    email_address: [email],
    password,
    skip_password_checks: true,
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await bapi("POST", "/users", body);
    const json = await res.json();
    if (res.ok) return json.id as string;
    const missing: string[] = (json.errors ?? []).flatMap((
      e: { meta?: { param_names?: string[] } },
    ) => e.meta?.param_names ?? []);
    const added = missing.filter((p) => requiredField(p, tag) !== undefined && !(p in body));
    if (added.length === 0) {
      throw new Error(`Clerk POST /users: ${res.status} ${JSON.stringify(json)}`);
    }
    for (const p of added) body[p] = requiredField(p, tag);
  }
  throw new Error("Clerk POST /users: the instance keeps asking for more fields");
}

/** Wait for clerk-js to load in `page` and add the testing token to every Frontend API call. */
async function readyClerk(page: Page, testingToken: string): Promise<void> {
  await pollFor(page, "window.Clerk && window.Clerk.loaded", 60_000);
  await page.evaluate(
    `window.Clerk.__internal_onBeforeRequest((req) => {
      req.url?.searchParams.set("__clerk_testing_token", ${JSON.stringify(testingToken)});
    })`,
  );
}

/** Sign in with an email code (the test code) through clerk-js's sign-in resource. */
function signInWithEmailCode(page: Page, email: string): Promise<unknown> {
  return page.evaluate(`(async () => {
    const c = window.Clerk;
    const si = await c.client.signIn.create({ identifier: ${JSON.stringify(email)} });
    const f = si.supportedFirstFactors.find((x) => x.strategy === "email_code");
    if (!f) throw new Error("email_code is not enabled on this instance");
    await si.prepareFirstFactor({ strategy: "email_code", emailAddressId: f.emailAddressId });
    const done = await si.attemptFirstFactor({ strategy: "email_code", code: "${TEST_CODE}" });
    if (done.status !== "complete") throw new Error("sign-in status " + done.status);
    await c.setActive({ session: done.createdSessionId });
    return c.user?.id;
  })()`);
}

/**
 * Sign in with a password. A new device may also need an email code (Clerk's client trust
 * answers `needs_second_factor` / `needs_client_trust`): the test code completes it.
 */
function signInWithPassword(page: Page, email: string, password: string): Promise<unknown> {
  return page.evaluate(`(async () => {
    const c = window.Clerk;
    let si = await c.client.signIn.create({
      identifier: ${JSON.stringify(email)}, password: ${JSON.stringify(password)},
    });
    if (si.status !== "complete") {
      const f = (si.supportedSecondFactors ?? []).find((x) => x.strategy === "email_code");
      if (!f) throw new Error("password sign-in status " + si.status);
      await si.prepareSecondFactor({ strategy: "email_code", emailAddressId: f.emailAddressId });
      si = await si.attemptSecondFactor({ strategy: "email_code", code: "${TEST_CODE}" });
    }
    if (si.status !== "complete") throw new Error("password sign-in status " + si.status);
    await c.setActive({ session: si.createdSessionId });
    return c.user?.id;
  })()`);
}

/** `GET /api/me` from the page, with the session token as a bearer (as the shells send it). */
function callApi(page: Page, withToken = true): Promise<{ status: number; body: string }> {
  return page.evaluate(`(async () => {
    const token = ${withToken} ? await window.Clerk.session?.getToken() : null;
    const res = await fetch("/api/me", { headers: token ? { authorization: "Bearer " + token } : {} });
    return { status: res.status, body: await res.text() };
  })()`) as Promise<{ status: number; body: string }>;
}

/** `denext dev` for the example on a free port, once it answers. */
async function startDev(): Promise<{ origin: string; close(): Promise<void> }> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--node-modules-dir=none",
      CLI,
      "dev",
      ".",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    cwd: EXAMPLE,
    stdout: "null",
    stderr: "null",
  }).spawn();
  const origin = `http://127.0.0.1:${port}`;
  const close = async () => {
    try {
      child.kill("SIGTERM");
    } catch { /* gone */ }
    await child.status;
  };
  for (let i = 0; i < 180; i++) {
    try {
      const res = await fetch(origin + "/api/me");
      await res.body?.cancel();
      return { origin, close };
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  await close();
  throw new Error("denext dev did not answer within 90 s");
}

Deno.test({
  name: "e2e: examples/clerk — @clerk/nextjs on denext against a Clerk development instance",
  ignore: !keys,
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const env = {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: keys!.publishableKey,
    CLERK_SECRET_KEY: keys!.secretKey,
  };
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v); // the CLI children inherit them
  // The example's npm packages (@clerk/nextjs and its peers) into its node_modules.
  const installed = await runDeno(["install"], EXAMPLE, 600_000);
  assert(installed.ok, "deno install failed:\n" + installed.out);
  const built = await runDeno(
    ["run", "-A", "--node-modules-dir=none", CLI, "build", "."],
    EXAMPLE,
    600_000,
  );
  assert(built.ok, "denext build failed:\n" + built.out.replaceAll(keys!.secretKey, "sk_***"));
  const server = await startCliServer(EXAMPLE, 90_000);
  const browser = await launchBrowser();
  const tag = crypto.randomUUID().slice(0, 8);
  const email = `denext-e2e-${tag}+clerk_test@example.com`;
  const password = `Dnx-${crypto.randomUUID()}`;
  let userId: string | undefined;
  let serverClosed = false;
  try {
    userId = await createTestUser(tag, email, password);
    const { token: testingToken } = await bapiJson<{ token: string }>("POST", "/testing_tokens");

    await t.step("signed out: the API answers 401, the protected page redirects", async () => {
      const api = await fetch(server.origin + "/api/me");
      assertEquals(api.status, 401);
      await api.body?.cancel();
      const page = await browser.newPage(server.origin + "/");
      await readyClerk(page, testingToken);
      assertEquals((await callApi(page, false)).status, 401);
      await page.close();
    });

    await t.step(
      "email code (424242): signs in, the API returns the verified user id",
      async () => {
        const page = await browser.newPage(server.origin + "/");
        await readyClerk(page, testingToken);
        assertEquals(await signInWithEmailCode(page, email), userId);
        const api = await callApi(page);
        assertEquals(api.status, 200, api.body);
        assertEquals(JSON.parse(api.body).userId, userId);
        // The cookie session reaches a Server Component through the middleware + auth().
        await page.goto(server.origin + "/protected", { waitUntil: "load" });
        await pollFor(
          page,
          `document.querySelector("#user-id")?.textContent === ${JSON.stringify(userId)}`,
        );
        assertStringIncludes(String(await page.evaluate("document.body.textContent")), email);
        // Sign out: the API refuses again.
        await page.goto(server.origin + "/", { waitUntil: "load" });
        await readyClerk(page, testingToken);
        await page.evaluate("window.Clerk.signOut()");
        await pollFor(page, "!window.Clerk.user");
        assertEquals((await callApi(page)).status, 401);
        await page.close();
      },
    );

    await t.step("email + password: signs in (a new device's email check included)", async () => {
      const page = await browser.newPage(server.origin + "/");
      await readyClerk(page, testingToken);
      assertEquals(await signInWithPassword(page, email, password), userId);
      const api = await callApi(page);
      assertEquals(api.status, 200, api.body);
      assertEquals(JSON.parse(api.body).userId, userId);
      await page.evaluate("window.Clerk.signOut()");
      await page.close();
    });

    await t.step("signed out: the protected page sends a browser to Clerk", async () => {
      const res = await fetch(server.origin + "/protected", {
        redirect: "manual",
        headers: { accept: "text/html", "sec-fetch-dest": "document" },
      });
      await res.body?.cancel();
      assertEquals(res.status, 307);
      // A development instance first syncs its dev browser (the handshake), then signs in.
      assert(/clerk\.accounts\.dev|\/sign-in/.test(res.headers.get("location") ?? ""));
    });

    await t.step("a forged bearer token is refused", async () => {
      const forged = await fetch(server.origin + "/api/me", {
        headers: { authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyX3gifQ.AAAA" },
      });
      assertEquals(forged.status, 401);
      await forged.body?.cancel();
    });
    // The dev server takes the example's .denext lock: the production server goes first.
    await server.close();
    serverClosed = true;
    await t.step("`denext dev` (the unbundled dev loop): the same sign-in and API", async () => {
      const dev = await startDev();
      try {
        const page = await browser.newPage(dev.origin + "/");
        await readyClerk(page, testingToken);
        assertEquals(await signInWithEmailCode(page, email), userId);
        const api = await callApi(page);
        assertEquals(api.status, 200, api.body);
        assertEquals(JSON.parse(api.body).userId, userId);
        await page.evaluate("window.Clerk.signOut()");
        await page.close();
      } finally {
        await dev.close();
      }
    });
  } finally {
    if (userId) await (await bapi("DELETE", `/users/${userId}`)).body?.cancel();
    await browser.close();
    if (!serverClosed) await server.close();
    for (const k of Object.keys(env)) Deno.env.delete(k);
  }
});
