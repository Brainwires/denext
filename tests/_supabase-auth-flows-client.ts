// The stock supabase-js client's own session machinery against `/auth/v1` — part of the shared
// flows in tests/_supabase-auth-flows.ts (in-memory and Postgres suites): `getClaims()` (verified
// locally against the JWKS), the `onAuthStateChange` events, `refreshSession()` / `setSession()`
// on the client's current session, PKCE code exchange (sign-up confirmation and password
// recovery, and a wrong verifier), MFA `challengeAndVerify` with the assurance level before and
// after, and the admin API's `listUsers` paging walked to its end.

import { assert, assertEquals, assertExists, assertNotEquals } from "@std/assert";
import type { GoTrueOptions } from "../src/server/auth/gotrue/options.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";
import {
  memoryStorage,
  ORIGIN,
  type SupabaseAuthApp,
  type SupabaseClient,
  totpCode,
} from "./_supabase-auth-app.ts";

type Step = (app: SupabaseAuthApp) => Promise<void>;

/** A flow: name, step, `/auth/v1` options, extra auth config. */
export type ClientFlow = [string, Step, GoTrueOptions?, Partial<AuthConfig>?];

/** A confirmed user, signed in on a fresh client (the session is the client's own). */
async function signedIn(app: SupabaseAuthApp, email: string, client = app.client()) {
  await app.admin().auth.admin.createUser({
    email,
    password: "pass phrase 1",
    email_confirm: true,
  });
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password: "pass phrase 1",
  });
  assertEquals(error, null);
  return { supabase: client as SupabaseClient, session: data.session };
}

/** The `?code=` an email link lands on, followed through `/auth/v1/verify`. */
async function linkCode(app: SupabaseAuthApp): Promise<string> {
  const res = await app.fetch(app.emails.at(-1)!.url, { redirect: "manual" });
  const code = new URL(res.headers.get("location")!).searchParams.get("code");
  assertExists(code, `the link landed with ?code=: ${res.headers.get("location")}`);
  return code;
}

export const CLIENT_FLOWS: ClientFlow[] = [
  ["getClaims: verified against the JWKS, refused when tampered or signed out", async (app) => {
    const { supabase, session } = await signedIn(app, "claims@example.com");
    const mine = await supabase.auth.getClaims();
    assertEquals(mine.error, null);
    assertEquals(mine.data.claims.sub, session.user.id);
    assertEquals(mine.data.claims.email, "claims@example.com");
    assertEquals(mine.data.claims.role, "authenticated");
    assertEquals(mine.data.header.alg, "ES256");
    assertExists(mine.data.header.kid);
    // An explicit token verifies the same way, on a client with no session of its own.
    const other = await app.client().auth.getClaims(session.access_token);
    assertEquals(other.error, null);
    assertEquals(other.data.claims.session_id, mine.data.claims.session_id);
    // A payload edited after signing fails the signature check.
    const [h, p, s] = session.access_token.split(".");
    const claims = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
    const forged = btoa(JSON.stringify({ ...claims, role: "service_role" }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const tampered = await app.client().auth.getClaims(`${h}.${forged}.${s}`);
    assertExists(tampered.error);
    // Signed out, there is no session to read claims from.
    await supabase.auth.signOut({ scope: "local" });
    const none = await supabase.auth.getClaims();
    assertEquals(none.data, null);
  }],

  [
    "onAuthStateChange: initial session, sign-in, token refresh, user update, sign-out",
    async (app) => {
      await app.admin().auth.admin.createUser({
        email: "events@example.com",
        password: "pass phrase 1",
        email_confirm: true,
      });
      const supabase = app.client({ storage: memoryStorage() });
      const events: Array<[string, string | null]> = [];
      const { data: { subscription } } = supabase.auth.onAuthStateChange(
        (event: string, session: { access_token: string } | null) =>
          void events.push([event, session?.access_token ?? null]),
      );
      try {
        // Subscribing reports the (absent) stored session.
        await supabase.auth.getSession();
        const signIn = await supabase.auth.signInWithPassword({
          email: "events@example.com",
          password: "pass phrase 1",
        });
        assertEquals(signIn.error, null);
        const refreshed = await supabase.auth.refreshSession();
        assertEquals(refreshed.error, null);
        const updated = await supabase.auth.updateUser({ data: { theme: "dark" } });
        assertEquals(updated.error, null);
        assertEquals(updated.data.user.user_metadata.theme, "dark");
        assertEquals((await supabase.auth.signOut()).error, null);
        assertEquals(events.map(([event]) => event), [
          "INITIAL_SESSION",
          "SIGNED_IN",
          "TOKEN_REFRESHED",
          "USER_UPDATED",
          "SIGNED_OUT",
        ]);
        assertEquals(events[0][1], null);
        assertEquals(events[1][1], signIn.data.session.access_token);
        assertEquals(events[2][1], refreshed.data.session.access_token);
        assertEquals(events[4][1], null);
      } finally {
        subscription.unsubscribe();
      }
    },
  ],

  ["refreshSession / setSession on the client's own session", async (app) => {
    const { supabase, session } = await signedIn(app, "refresh@example.com");
    // No argument: the client refreshes the session it holds, and keeps the new pair.
    const refreshed = await supabase.auth.refreshSession();
    assertEquals(refreshed.error, null);
    assertNotEquals(refreshed.data.session.refresh_token, session.refresh_token);
    assertEquals(refreshed.data.user.id, session.user.id);
    const held = (await supabase.auth.getSession()).data.session;
    assertEquals(held.refresh_token, refreshed.data.session.refresh_token);
    // setSession on another client adopts the pair and reads the user from the server.
    const other = app.client();
    const set = await other.auth.setSession({
      access_token: held.access_token,
      refresh_token: held.refresh_token,
    });
    assertEquals(set.error, null);
    assertEquals(set.data.user.email, "refresh@example.com");
    assertEquals((await other.auth.getUser()).data.user.id, session.user.id);
    // A refresh token that was never issued is refused, and the held session is untouched.
    const bogus = await app.client().auth.setSession({
      access_token: "not.a.jwt",
      refresh_token: "x.0.aaaaaaaaaaaaaaaaaaaaaa",
    });
    assertExists(bogus.error);
  }],

  ["PKCE: sign-up confirmation and password recovery exchange a code", async (app) => {
    const storage = memoryStorage();
    const supabase = app.client({ flowType: "pkce", storage });
    const signUp = await supabase.auth.signUp({
      email: "pkce-signup@example.com",
      password: "pkce password!",
      options: { emailRedirectTo: `${ORIGIN}/confirmed` },
    });
    assertEquals(signUp.error, null);
    assertEquals(signUp.data.session, null);
    const confirmed = await supabase.auth.exchangeCodeForSession(await linkCode(app));
    assertEquals(confirmed.error, null);
    assertEquals(confirmed.data.user.email, "pkce-signup@example.com");
    assertExists(confirmed.data.user.email_confirmed_at);
    assertEquals((await supabase.auth.getSession()).data.session.user.id, confirmed.data.user.id);
    // Password recovery: the PASSWORD_RECOVERY event, then a new password through the session.
    const events: string[] = [];
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event: string) => void events.push(event),
    );
    try {
      const reset = await supabase.auth.resetPasswordForEmail("pkce-signup@example.com", {
        redirectTo: `${ORIGIN}/reset`,
      });
      assertEquals(reset.error, null);
      const recovered = await supabase.auth.exchangeCodeForSession(await linkCode(app));
      assertEquals(recovered.error, null);
      assert(events.includes("PASSWORD_RECOVERY"), `events: ${events.join(", ")}`);
      assertEquals((await supabase.auth.updateUser({ password: "another password" })).error, null);
    } finally {
      subscription.unsubscribe();
    }
    const again = await app.client().auth.signInWithPassword({
      email: "pkce-signup@example.com",
      password: "another password",
    });
    assertEquals(again.error, null);
  }],

  ["PKCE: a code is refused with the wrong verifier", async (app) => {
    const storage = memoryStorage();
    const supabase = app.client({ flowType: "pkce", storage });
    await supabase.auth.signInWithOtp({
      email: "verifier@example.com",
      options: { emailRedirectTo: `${ORIGIN}/cb` },
    });
    const code = await linkCode(app);
    // Swap every stored verifier for another valid-looking one.
    const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i)!)
      .filter((k) => k.endsWith("-code-verifier"));
    assert(keys.length > 0, "the client stored a code verifier");
    for (const key of keys) storage.setItem(key, JSON.stringify("a".repeat(56)));
    const refused = await supabase.auth.exchangeCodeForSession(code);
    assertEquals(refused.error?.code, "bad_code_verifier");
    assertEquals(refused.data.session, null);
  }],

  ["MFA: challengeAndVerify raises aal1 to aal2", async (app) => {
    const { supabase } = await signedIn(app, "aal@example.com");
    const enrolled = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "app" });
    assertEquals(enrolled.error, null);
    // An unverified factor does not raise the next level.
    const before = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    assertEquals(before.error, null);
    assertEquals(before.data.currentLevel, "aal1");
    assertEquals(before.data.nextLevel, "aal1");
    const wrong = await supabase.auth.mfa.challengeAndVerify({
      factorId: enrolled.data.id,
      code: "000000",
    });
    assertEquals(wrong.error?.code, "mfa_verification_failed");
    const verified = await supabase.auth.mfa.challengeAndVerify({
      factorId: enrolled.data.id,
      code: await totpCode(enrolled.data.totp.secret),
    });
    assertEquals(verified.error, null);
    const after = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    assertEquals(after.data.currentLevel, "aal2");
    assertEquals(after.data.nextLevel, "aal2");
    const methods = after.data.currentAuthenticationMethods.map((m: { method: string }) =>
      m.method
    );
    assert(methods.includes("totp"), `amr: ${methods.join(", ")}`);
    // A fresh password sign-in is aal1 with aal2 available.
    const fresh = app.client();
    await fresh.auth.signInWithPassword({ email: "aal@example.com", password: "pass phrase 1" });
    const pending = await fresh.auth.mfa.getAuthenticatorAssuranceLevel();
    assertEquals(pending.data.currentLevel, "aal1");
    assertEquals(pending.data.nextLevel, "aal2");
  }],

  ["admin.listUsers pages to the end", async (app) => {
    const admin = app.admin().auth.admin;
    const made = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const { data, error } = await admin.createUser({
        email: `page${i}@example.com`,
        email_confirm: true,
      });
      assertEquals(error, null);
      made.add(data.user.id);
    }
    const seen: string[] = [];
    let page = 1;
    const pages: Array<{ nextPage: number | null; lastPage: number; total: number }> = [];
    for (;;) {
      const { data, error } = await admin.listUsers({ page, perPage: 2 });
      assertEquals(error, null);
      seen.push(...data.users.map((u: { id: string }) => u.id));
      pages.push({ nextPage: data.nextPage, lastPage: data.lastPage, total: data.total });
      if (!data.nextPage) break;
      assertEquals(data.nextPage, page + 1);
      page = data.nextPage;
      assert(page < 10, "paging terminates");
    }
    assertEquals(pages.length, 3);
    assertEquals(pages.map((p) => p.total), [5, 5, 5]);
    assertEquals(pages.map((p) => p.lastPage), [3, 3, 3]);
    assertEquals(seen.length, 5);
    assertEquals(new Set(seen), made, "every user once, none twice");
    // Past the end: an empty page.
    const beyond = await admin.listUsers({ page: 4, perPage: 2 });
    assertEquals(beyond.error, null);
    assertEquals(beyond.data.users, []);
    // No paging options: every user (GoTrue's default page size covers five).
    const all = await admin.listUsers();
    assertEquals(all.data.users.length, 5);
  }],
];
