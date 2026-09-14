// Which environment the app runs in — one definition for every "never in production" rule
// (the public fallback secret, the dev mailer and its /dev/outbox page).
//
// `denext dev` sets NODE_ENV=development; `denext start` sets DENEXT_ENV=production when the
// deploy set neither, so a production server can't fall through to the development branch.

/** Whether this process is a production server. */
export function isProduction(): boolean {
  return Deno.env.get("NODE_ENV") === "production" ||
    Deno.env.get("DENEXT_ENV") === "production";
}
