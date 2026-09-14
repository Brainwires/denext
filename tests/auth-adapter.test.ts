// The in-memory AuthAdapter (the shared contract suite + its own bounds and clock) and
// the account-linking rules `resolveSignInUser` applies between the provider round-trip
// and `callbacks.signIn`.

import { assert, assertEquals, assertRejects } from "@std/assert";
import type { AdapterAccount, AdapterUser, AuthAdapter } from "../src/server/auth/adapter.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import {
  accountNotLinkedCode,
  AccountNotLinkedError,
  resolveSignInUser,
} from "../src/server/auth/adapter-link.ts";
import { resolveAuthOptions } from "../src/server/auth/options.ts";
import type { AuthConfig, AuthUser, OAuthProvider } from "../src/server/auth/types.ts";
import { adapterContract } from "./helpers/auth-adapter-contract.ts";

const SECRET = "0123456789abcdef0123456789abcdef";
const now = (): number => Math.floor(Date.now() / 1000);

// ---- the shared contract ---------------------------------------------------

Deno.test("inMemoryAuthAdapter meets the adapter contract", async (t) => {
  await adapterContract(t, () => inMemoryAuthAdapter());
});

Deno.test("inMemoryAuthAdapter: every table is bounded, oldest first", async () => {
  const adapter = inMemoryAuthAdapter({ maxUsers: 2 });
  const first = await adapter.createUser({ email: "a@x.test" });
  const second = await adapter.createUser({ email: "b@x.test" });
  const third = await adapter.createUser({ email: "c@x.test" });
  assertEquals(await adapter.getUser(first.id), undefined, "past the cap the oldest is evicted");
  assertEquals((await adapter.getUser(second.id))?.email, "b@x.test");
  assertEquals((await adapter.getUser(third.id))?.email, "c@x.test");
  assertEquals(
    await adapter.getUserByEmail("a@x.test"),
    undefined,
    "the email index never outlives the user it points at",
  );
});

Deno.test("inMemoryAuthAdapter: rewriting a row makes it the youngest", async () => {
  const adapter = inMemoryAuthAdapter({ maxUsers: 2 });
  const a = await adapter.createUser({ id: "a", email: "a@x.test" });
  await adapter.createUser({ id: "b", email: "b@x.test" });
  await adapter.updateUser({ id: a.id, name: "Ada" });
  await adapter.createUser({ id: "c", email: "c@x.test" });
  assertEquals((await adapter.getUser("a"))?.name, "Ada", "the rewritten row survives");
  assertEquals(await adapter.getUser("b"), undefined);
});

Deno.test("inMemoryAuthAdapter: `now` drives every expiry check", async () => {
  let clock = now();
  const adapter = inMemoryAuthAdapter({ now: () => clock });
  const user = await adapter.createUser({ email: "ada@x.test" });
  const token = {
    identifier: "ada@x.test",
    tokenHash: "a".repeat(64),
    expires: clock + 60,
    purpose: "reset" as const,
  };
  await adapter.createVerificationToken?.(token);
  await adapter.createApiToken?.({
    id: "t1",
    userId: user.id,
    tokenHash: "hash-t1",
    createdAt: clock,
    expiresAt: clock + 60,
  });
  clock += 61; // the clock moves, nothing else does
  assertEquals(await adapter.useVerificationToken?.(token), undefined, "the token aged out");
  assertEquals(await adapter.getApiTokenByHash?.("hash-t1"), undefined, "so did the API token");
});

// ---- the linking matrix ----------------------------------------------------

/** A minimal OAuth provider — only `id` and the linking flag matter here. */
function provider(extra: { allowDangerousEmailAccountLinking?: boolean } = {}): OAuthProvider {
  return {
    id: "google",
    type: "oidc",
    authorizationUrl: "https://accounts.test/authorize",
    tokenUrl: "https://accounts.test/token",
    clientId: "client",
    clientSecret: "secret",
    scopes: ["openid", "email"],
    profile: (input) => ({ id: String(input.claims?.sub ?? "") }),
    ...extra,
  };
}

/** The account the callback would hand `resolveSignInUser`. */
const account = (providerAccountId = "sub-1"): Omit<AdapterAccount, "userId"> => ({
  provider: "google",
  providerAccountId,
  type: "oidc",
});

/** Recorded `createUser` / `linkAccount` events, in order. */
interface Recorder {
  /** The users the flow created. */
  created: AdapterUser[];
  /** The accounts the flow linked, with the user each landed on. */
  linked: { user: AdapterUser; account: AdapterAccount }[];
}

/** Resolve options over a fresh in-memory adapter, recording the two adapter events. */
function setup(config: Partial<AuthConfig> = {}) {
  const adapter = inMemoryAuthAdapter();
  const events: Recorder = { created: [], linked: [] };
  const options = resolveAuthOptions({
    secret: SECRET,
    providers: [],
    adapter,
    events: {
      createUser: ({ user }) => void events.created.push(user),
      linkAccount: ({ user, account }) => void events.linked.push({ user, account }),
    },
    ...config,
  });
  return { adapter, options, events };
}

/** A verified provider profile. */
const profileOf = (overrides: Partial<AuthUser> = {}): AuthUser => ({
  id: "sub-1",
  email: "ada@x.test",
  emailVerified: true,
  name: "Ada",
  image: "https://x.test/ada.png",
  ...overrides,
});

/** Give `adapter` a user whose email is (or isn't) verified. */
function seedUser(adapter: AuthAdapter, verified: boolean, extra: Partial<AdapterUser> = {}) {
  return adapter.createUser({
    email: "ada@x.test",
    emailVerified: verified ? now() - 60 : undefined,
    ...extra,
  });
}

Deno.test("resolveSignInUser: no adapter ⇒ the profile passes through unchanged", async () => {
  const options = resolveAuthOptions({ secret: SECRET, providers: [] });
  const profile = profileOf();
  const user = await resolveSignInUser(options, provider(), profile, account());
  assertEquals(user, profile, "byte-for-byte the pre-2.5 flow");
});

Deno.test("resolveSignInUser: a returning account is the fast path", async () => {
  const { adapter, options, events } = setup();
  const existing = await adapter.createUser({
    email: "ada@x.test",
    emailVerified: now() - 60,
    name: "Ada",
    roles: ["admin", "editor"],
  });
  await adapter.linkAccount({ ...account(), userId: existing.id });

  const user = await resolveSignInUser(options, provider(), profileOf(), account());
  assertEquals(user.id, existing.id, "session.user.id is the adapter id");
  assertEquals(user.roles, ["admin", "editor"], "roles come from the stored record");
  assertEquals(user.emailVerified, true, "the epoch-seconds field becomes a boolean claim");
  assertEquals(events.created, [], "nothing was created");
  assertEquals(events.linked, [], "nothing was linked again");
});

Deno.test("resolveSignInUser: verified profile + verified user ⇒ link + event", async () => {
  const { adapter, options, events } = setup();
  const existing = await seedUser(adapter, true, { roles: ["admin"] });

  const user = await resolveSignInUser(options, provider(), profileOf(), account("sub-9"));
  assertEquals(user.id, existing.id);
  assertEquals(user.roles, ["admin"]);
  assertEquals(events.created, [], "an existing identity is never re-created");
  assertEquals(events.linked.length, 1);
  assertEquals(events.linked[0].user.id, existing.id);
  assertEquals(events.linked[0].account.providerAccountId, "sub-9");
  assertEquals(events.linked[0].account.userId, existing.id, "the event carries the resolved id");
  assertEquals(
    (await adapter.getUserByAccount({ provider: "google", providerAccountId: "sub-9" }))?.id,
    existing.id,
    "the link is persisted, so the next login takes the fast path",
  );
});

Deno.test("resolveSignInUser: a verified link fills in what the record was missing", async () => {
  const { adapter, options } = setup();
  const existing = await adapter.createUser({ email: "ada@x.test", emailVerified: now() - 60 });

  const user = await resolveSignInUser(
    options,
    provider(),
    profileOf({ name: "Ada L" }),
    account(),
  );
  assertEquals(user.name, "Ada L", "the profile filled a blank");
  assertEquals((await adapter.getUser(existing.id))?.name, "Ada L", "and it was persisted");
});

Deno.test("resolveSignInUser: the adapter wins for a field it already has", async () => {
  const { adapter, options } = setup();
  const existing = await seedUser(adapter, true, { name: "Local Name" });

  const user = await resolveSignInUser(options, provider(), profileOf(), account());
  assertEquals(user.name, "Local Name", "a local rename is not undone by every login");
  assertEquals((await adapter.getUser(existing.id))?.name, "Local Name");
});

Deno.test("resolveSignInUser: verified profile + UNVERIFIED user ⇒ refused", async () => {
  const { adapter, options, events } = setup();
  await seedUser(adapter, false);

  const error = await assertRejects(
    () => resolveSignInUser(options, provider(), profileOf(), account()),
    AccountNotLinkedError,
  );
  assertEquals(error.code, "account_not_linked", "the stable ?error= code");
  assertEquals(accountNotLinkedCode(error), "account_not_linked", "what the callback reads");
  assertEquals(accountNotLinkedCode(new Error("other")), undefined, "other failures keep theirs");
  assert(
    error.message.includes("never been verified"),
    "the message says which side is unverified",
  );
  assertEquals(events.linked, [], "nothing was linked");
  assertEquals(
    await adapter.getUserByAccount({ provider: "google", providerAccountId: "sub-1" }),
    undefined,
  );
});

Deno.test("resolveSignInUser: UNVERIFIED profile + verified user ⇒ refused", async () => {
  const { adapter, options, events } = setup();
  await seedUser(adapter, true);

  const error = await assertRejects(
    () => resolveSignInUser(options, provider(), profileOf({ emailVerified: false }), account()),
    AccountNotLinkedError,
  );
  assertEquals(error.code, "account_not_linked");
  assert(error.message.includes("did not assert"), "the provider's claim is what failed");
  assertEquals(events.linked, []);
});

Deno.test("resolveSignInUser: a provider that says nothing about the email is refused", async () => {
  const { adapter, options } = setup();
  await seedUser(adapter, true);

  await assertRejects(
    () =>
      resolveSignInUser(options, provider(), profileOf({ emailVerified: undefined }), account()),
    AccountNotLinkedError,
  );
});

Deno.test("resolveSignInUser: allowDangerousEmailAccountLinking links anyway", async () => {
  const { adapter, options, events } = setup();
  const existing = await seedUser(adapter, false);
  const dangerous = provider({ allowDangerousEmailAccountLinking: true });

  const user = await resolveSignInUser(options, dangerous, profileOf(), account());
  assertEquals(user.id, existing.id);
  assertEquals(events.linked.length, 1, "the opt-in links what the default refuses");
  assertEquals(user.emailVerified, true, "the provider's verified claim was recorded");
  assert(
    typeof (await adapter.getUser(existing.id))?.emailVerified === "number",
    "stored as epoch seconds",
  );
});

Deno.test("resolveSignInUser: a total miss creates the user and links the account", async () => {
  const { adapter, options, events } = setup();

  const user = await resolveSignInUser(
    options,
    provider(),
    profileOf({ roles: ["member"] }),
    account(),
  );
  assert(user.id, "the new adapter id");
  assertEquals(user.id !== "sub-1", true, "not the provider's own subject id");
  assertEquals(user.email, "ada@x.test");
  assertEquals(user.name, "Ada");
  assertEquals(user.image, "https://x.test/ada.png");
  assertEquals(user.roles, ["member"]);
  assertEquals(user.emailVerified, true);

  assertEquals(events.created.length, 1, "createUser fired once");
  assertEquals(events.created[0].id, user.id);
  assertEquals(typeof events.created[0].emailVerified, "number", "stored as epoch seconds");
  assertEquals(events.linked.length, 1, "then linkAccount");
  assertEquals(events.linked[0].account.userId, user.id);
  assertEquals((await adapter.getUserByEmail("ada@x.test"))?.id, user.id);
});

Deno.test("resolveSignInUser: a profile with no email always starts a new user", async () => {
  const { adapter, options, events } = setup();
  await seedUser(adapter, true);

  const user = await resolveSignInUser(
    options,
    provider(),
    { id: "sub-2", name: "Anonymous" },
    account("sub-2"),
  );
  assertEquals(events.created.length, 1, "no email means no match to refuse or link");
  assertEquals(user.email, undefined);
  assertEquals(user.emailVerified, false, "and nothing was verified");
});

Deno.test("resolveSignInUser: an unverified profile with no local match still creates", async () => {
  const { adapter, options, events } = setup();

  const user = await resolveSignInUser(
    options,
    provider(),
    profileOf({ emailVerified: false }),
    account(),
  );
  assertEquals(events.created.length, 1);
  assertEquals(user.emailVerified, false);
  assertEquals(
    (await adapter.getUser(user.id))?.emailVerified,
    undefined,
    "an unverified claim writes no timestamp",
  );
});

Deno.test("resolveSignInUser: an event handler that throws never fails the sign-in", async () => {
  const adapter = inMemoryAuthAdapter();
  const errors: string[] = [];
  const options = resolveAuthOptions({
    secret: SECRET,
    providers: [],
    adapter,
    events: {
      createUser: () => {
        throw new Error("audit row failed");
      },
    },
    logger: { error: (message) => void errors.push(message) },
  });

  const user = await resolveSignInUser(options, provider(), profileOf(), account());
  assert(user.id);
  assertEquals(errors.length, 1, "the throw went to the logger, not the user");
  assert(errors[0].includes("createUser"));
});
