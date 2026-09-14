import { defineApi } from "denext/server";
import { z } from "zod";
import { checkCredentials, issueDemoToken } from "../../../lib/auth.ts";

// The public endpoint: exchange demo credentials (username "demo", password "denext") for a
// first-party bearer API token (`issueApiToken`, in lib/auth.ts). Paste the token into Swagger
// UI's "Authorize" dialog and every protected request carries it as `Authorization: Bearer
// <token>`. It's `defineApi` (no `authed`), so it's public.
export const POST = defineApi({
  summary: "Log in — returns a bearer token",
  body: z.object({ username: z.string(), password: z.string() }),
  response: z.object({ token: z.string() }),
  errors: { invalid_credentials: 401 },
}, async ({ body, fail }) => {
  if (!checkCredentials(body.username, body.password)) {
    fail("invalid_credentials", { message: 'Try username "demo", password "denext".' });
  }
  // The plaintext exists only here: only its SHA-256 is stored.
  return { token: await issueDemoToken() };
});
