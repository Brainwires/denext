// Lifecycle events + the logger on the CREDENTIALS sign-in path: a completed sign-in
// fires `signIn`, every refusal fires `signInFailed` with a stable reason, and neither a
// throwing event handler nor a throwing provider can change the HTTP answer — the throw
// goes to `logger.error` instead.

import { assert, assertEquals } from "@std/assert";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import { credentials } from "../src/server/auth/providers.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { setRemoteAddr } from "../src/server/remote-addr.ts";
import type { AuthConfig, AuthEvents, AuthUser } from "../src/server/auth/types.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";

/** One recorded `signIn` / `signInFailed` payload (the shape the event contract promises). */
interface Recorded {
  /** Which event fired. */
  name: "signIn" | "signInFailed";
  /** The user, for a `signIn`. */
  user?: AuthUser;
  /** The provider id both events carry. */
  provider?: string;
  /** The stable refusal reason, for a `signInFailed`. */
  reason?: string;
  /** The client bucket the limiter keyed on, for a `signInFailed`. */
  ip?: string;
}

/** One recorded `logger.error(...)` call. */
interface LoggedError {
  /** The message the framework logged. */
  message: string;
  /** The value it swallowed. */
  error?: unknown;
}

/** A config plus the events + errors it recorded. */
interface Harness {
  /** The auth config to hand `handleAuthRequest`. */
  config: AuthConfig;
  /** Events in the order they fired. */
  events: Recorded[];
  /** Everything routed to `logger.error`. */
  errors: LoggedError[];
}

/**
 * A credentials app (`a@b.co` / `pw`) wired to recording `events` + `logger`.
 *
 * @param overrides Extra config (callbacks, rateLimit, a throwing `events`, …).
 * @param authorize An `authorize` to use instead of the default password check.
 * @returns The config and the recorders.
 */
function harness(
  overrides: Partial<AuthConfig> = {},
  authorize?: (creds: Record<string, string>) => AuthUser | null,
): Harness {
  const events: Recorded[] = [];
  const errors: LoggedError[] = [];
  const recording: AuthEvents = {
    signIn: ({ user, provider }) => void events.push({ name: "signIn", user, provider }),
    signInFailed: ({ provider, reason, ip }) =>
      void events.push({ name: "signInFailed", provider, reason, ip }),
  };
  const config: AuthConfig = {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    providers: [
      credentials({
        authorize: authorize ??
          (({ email, password }) =>
            email === "a@b.co" && password === "pw" ? { id: "1", email } : null),
      }),
    ],
    rateLimit: { max: 2, windowMs: 60_000 },
    events: recording,
    logger: { error: (message, error) => void errors.push({ message, error }) },
    ...overrides,
  };
  if (overrides.events) config.events = { ...recording, ...overrides.events };
  return { config, events, errors };
}

/** POST the credentials endpoint as a JSON client. */
function login(config: AuthConfig, body: Record<string, unknown>): Promise<Response> {
  const request = new Request(`${ORIGIN}/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin: ORIGIN,
    },
    body: JSON.stringify(body),
  });
  return runWithContext(
    createRequestContext(request),
    () => handleAuthRequest(request, config),
  ) as Promise<Response>;
}

Deno.test("events: a completed credentials sign-in fires `signIn` with the user + provider", async () => {
  const { config, events, errors } = harness();
  assertEquals((await login(config, { email: "a@b.co", password: "pw" })).status, 200);
  assertEquals(events.length, 1);
  assertEquals(events[0].name, "signIn");
  assertEquals(events[0].provider, "credentials");
  assertEquals(events[0].user?.id, "1");
  assertEquals(events[0].user?.email, "a@b.co");
  assertEquals(errors, [], "nothing was swallowed");
});

Deno.test('events: a bad password fires `signInFailed { reason: "invalid_credentials" }`', async () => {
  const { config, events } = harness();
  assertEquals((await login(config, { email: "a@b.co", password: "no" })).status, 401);
  assertEquals(events, [{
    name: "signInFailed",
    provider: "credentials",
    reason: "invalid_credentials",
    ip: "unknown", // no socket peer on a hand-built Request
  }]);
});

Deno.test('events: a rate-limited attempt fires `signInFailed { reason: "rate_limited" }`', async () => {
  const { config, events } = harness();
  await login(config, { email: "a@b.co", password: "no" });
  await login(config, { email: "a@b.co", password: "no" });
  assertEquals((await login(config, { email: "a@b.co", password: "pw" })).status, 429);
  assertEquals(events.map((e) => e.reason), [
    "invalid_credentials",
    "invalid_credentials",
    "rate_limited",
  ]);
});

Deno.test('events: a denying `callbacks.signIn` fires `signInFailed { reason: "access_denied" }`', async () => {
  const { config, events } = harness({ callbacks: { signIn: () => false } });
  assertEquals((await login(config, { email: "a@b.co", password: "pw" })).status, 403);
  assertEquals(events, [{
    name: "signInFailed",
    provider: "credentials",
    reason: "access_denied",
    ip: "unknown",
  }]);
});

Deno.test("events: a throwing handler never changes the HTTP result — it goes to the logger", async () => {
  const boom = new Error("audit row failed");
  const ok = harness({
    events: {
      signIn: () => {
        throw boom;
      },
    },
  });
  const res = await login(ok.config, { email: "a@b.co", password: "pw" });
  assertEquals(res.status, 200, "the sign-in still succeeded");
  assertEquals((await res.json()).ok, true);
  assertEquals(ok.errors.length, 1);
  assert(ok.errors[0].message.includes('"signIn" event handler threw'), ok.errors[0].message);
  assertEquals(ok.errors[0].error, boom);

  // The same for a rejecting async handler on the failure path.
  const bad = harness({ events: { signInFailed: () => Promise.reject(boom) } });
  assertEquals((await login(bad.config, { email: "a@b.co", password: "no" })).status, 401);
  assertEquals(bad.errors.length, 1);
  assert(bad.errors[0].message.includes('"signInFailed" event handler threw'));
});

Deno.test("logger: a provider `authorize()` that throws is a generic 401 AND a logged error", async () => {
  const boom = new Error("database is down");
  const { config, events, errors } = harness({}, () => {
    throw boom;
  });
  const res = await login(config, { email: "a@b.co", password: "pw" });
  assertEquals(res.status, 401, "still the generic refusal — never a 500, never an oracle");
  assertEquals((await res.json()).error, "invalid credentials");
  assertEquals(events.map((e) => e.reason), ["invalid_credentials"]);
  assertEquals(errors.length, 1, "the swallowed throw is visible to the app");
  assert(errors[0].message.includes("authorize() threw"), errors[0].message);
  assertEquals(errors[0].error, boom);
});

Deno.test("logger: an unparseable credentials body is logged, not thrown", async () => {
  const { config, errors } = harness();
  const request = new Request(`${ORIGIN}/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin: ORIGIN,
    },
    body: "{ not json",
  });
  const res = await runWithContext(
    createRequestContext(request),
    () => handleAuthRequest(request, config),
  ) as Response;
  assertEquals(res.status, 401);
  assertEquals(errors.length, 1);
  assert(errors[0].message.includes("could not parse the credentials body"), errors[0].message);
});

Deno.test("events: an app that configures none (the default) signs in exactly as before", async () => {
  const config: AuthConfig = {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    providers: [credentials({ authorize: ({ email }) => ({ id: "1", email }) })],
  };
  assertEquals((await login(config, { email: "a@b.co", password: "pw" })).status, 200);
});

Deno.test("credentials: an adapter that throws is a generic 401 + `adapter_error`, never a 500", async () => {
  // The concurrent first-sign-in UNIQUE race (two requests creating the same user at once)
  // and a database that went away both surface here. They used to escape `handleCredentials`
  // as a raw 500 with no `signInFailed` at all — and a 500 where a 401 belongs is itself a
  // user-enumeration signal.
  const adapter = inMemoryAuthAdapter();
  adapter.getUserByAccount = () => {
    throw new Error("db password = hunter2");
  };
  const { config, events, errors } = harness({ adapter });
  const res = await login(config, { email: "a@b.co", password: "pw" });
  assertEquals(res.status, 401, "the SAME answer a wrong password gets");
  assertEquals(await res.json(), { error: "invalid credentials" });
  assertEquals(events.map((e) => e.reason), ["adapter_error"]);
  assertEquals(errors.length, 1, "the exception reached the logger instead of the client");
  assert(
    !JSON.stringify(errors[0].message).includes("hunter2"),
    "and the message the client could ever see names no internals",
  );
  await adapter.close?.();
});

Deno.test("credentials: signInFailed carries the client bucket the limiter keyed on", async () => {
  const { config, events } = harness();
  const request = new Request(`${ORIGIN}/auth/callback/credentials`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", origin: ORIGIN },
    body: JSON.stringify({ email: "a@b.co", password: "no" }),
  });
  setRemoteAddr(request, { transport: "tcp", hostname: "203.0.113.7", port: 443 });
  await runWithContext(createRequestContext(request), () => handleAuthRequest(request, config));
  assertEquals(events.map((e) => e.reason), ["invalid_credentials"]);
  assertEquals(
    events.map((e) => e.ip),
    ["203.0.113.7"],
    "the `ip` field the event always declared is finally populated",
  );
});
