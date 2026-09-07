import { defineApi } from "denext/server";
import { z } from "zod";
import { checkCredentials, issueToken } from "../../../lib/auth.ts";

// The public endpoint: exchange demo credentials (username "demo", password "denext") for a
// bearer token. Paste the token into Swagger UI's "Authorize" dialog and every protected request
// carries it as `Authorization: Bearer <token>`. `security: []` marks it explicitly public.
export const POST = defineApi({
  summary: "Log in — returns a bearer token",
  security: [],
  body: z.object({ username: z.string(), password: z.string() }),
  response: z.object({ token: z.string() }),
  errors: { invalid_credentials: 401 },
}, ({ body, fail }) => {
  if (!checkCredentials(body.username, body.password)) {
    fail("invalid_credentials", { message: 'Try username "demo", password "denext".' });
  }
  return { token: issueToken() };
});
