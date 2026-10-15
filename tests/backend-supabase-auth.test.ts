// The stock `@supabase/supabase-js` client's `supabase.auth.*` against a denext app's `/auth/v1`
// (denextAuth + backend({ supabase })), on the in-memory adapter: sign-up with email
// confirmation, password sign-in, refresh-token rotation and reuse detection, sign-out scopes,
// user updates, magic-link / OTP, recovery, anonymous sign-in and its conversion, phone OTP,
// MFA (TOTP: enroll, challenge, verify → aal2, unenroll), PKCE through an email link, the admin
// API, the custom access token hook and captcha, and the client's own session machinery
// (getClaims, onAuthStateChange, refreshSession / setSession, PKCE exchanges, MFA
// challengeAndVerify and the assurance level, listUsers paging). The same flows on Postgres:
// tests/backend-supabase-auth-integration.test.ts.
//
// Opt-in (it downloads supabase-js from npm): DENEXT_TEST_SUPABASE_JS=1. The backend-integration
// CI job sets it.

import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { runFlows } from "./_supabase-auth-flows.ts";

const enabled = Deno.env.get("DENEXT_TEST_SUPABASE_JS") === "1";

Deno.test({
  name: `supabase-js auth against /auth/v1 (in-memory adapter)${
    enabled ? "" : " (skipped: set DENEXT_TEST_SUPABASE_JS=1)"
  }`,
  ignore: !enabled,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    await runFlows(t, () => inMemoryAuthAdapter());
  },
});
