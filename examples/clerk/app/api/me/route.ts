// The protected API: a `defineApi` route whose user id comes from the verified Clerk session
// token (`auth()` reads what `clerkMiddleware` verified: the session cookie on the web, the
// `Authorization: Bearer` token the desktop and mobile shells send). Signed out → 401.
import { auth } from "@clerk/nextjs/server";
import { createApi, unauthorized } from "denext/server";

/** A `defineApi` middleware: the Clerk session, or a 401. */
async function clerkSession() {
  const { userId, sessionId } = await auth();
  if (!userId || !sessionId) unauthorized();
  return { clerk: { userId, sessionId } };
}

export const GET = createApi().use(clerkSession).define(
  {},
  ({ ctx }) => ({ userId: ctx.clerk.userId, sessionId: ctx.clerk.sessionId }),
);
