/**
 * The built-in pages Auth.js serves when an app configures none: sign-in (a form per provider,
 * each carrying the CSRF token), sign-out confirmation, "check your email", and errors. Plain,
 * script-free HTML — they render under denext's strict CSP — with every value escaped.
 *
 * @module
 */

import type { ProviderDescriptor } from "./providers/shared.ts";
import type { CredentialInput } from "./providers/credentials.ts";

/** HTML-escape a text or attribute value. */
function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** A whole page. */
function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(title)}</title></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/** The hidden fields every form carries. */
function hidden(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`)
    .join("");
}

/** What each Auth.js error code tells the user. */
const MESSAGES: Record<string, string> = {
  CredentialsSignin: "Sign in failed. Check the details you provided are correct.",
  OAuthAccountNotLinked:
    "To confirm your identity, sign in with the same account you used originally.",
  AccessDenied: "You do not have permission to sign in.",
  Verification: "The sign in link is no longer valid. It may have been used already or expired.",
  Configuration: "There is a problem with the server configuration.",
  SessionRequired: "Please sign in to access this page.",
  MissingCSRF: "The form expired. Please try again.",
};

/** The message for an error code. */
function message(code: string | null): string {
  if (!code) return "";
  return `<p role="alert">${esc(MESSAGES[code] ?? "Unable to sign in.")}</p>`;
}

/** One provider's sign-in form. */
function providerForm(
  basePath: string,
  provider: ProviderDescriptor,
  fields: Record<string, string>,
): string {
  if (provider.type === "credentials") {
    const inputs = (provider.options as { credentials?: Record<string, CredentialInput> })
      .credentials ?? {};
    const rows = Object.entries(inputs).map(([name, input]) =>
      `<label>${esc(input.label ?? name)} <input name="${esc(name)}" type="${
        esc(input.type ?? "text")
      }"${input.placeholder ? ` placeholder="${esc(input.placeholder)}"` : ""}></label>`
    ).join("");
    return `<form method="post" action="${esc(`${basePath}/callback/${provider.id}`)}">` +
      `${hidden(fields)}${rows}<button type="submit">Sign in with ${esc(provider.name)}</button>` +
      `</form>`;
  }
  const email = provider.type === "email"
    ? `<label>Email <input name="email" type="email" required></label>`
    : "";
  return `<form method="post" action="${esc(`${basePath}/signin/${provider.id}`)}">` +
    `${hidden(fields)}${email}<button type="submit">Sign in with ${esc(provider.name)}</button>` +
    `</form>`;
}

/**
 * The sign-in page.
 *
 * @param basePath The endpoint prefix.
 * @param providers The configured providers.
 * @param csrfToken This browser's CSRF token.
 * @param query The page's query (`callbackUrl`, `error`).
 * @returns The page.
 */
export function signInPage(
  basePath: string,
  providers: ProviderDescriptor[],
  csrfToken: string,
  query: URLSearchParams,
): Response {
  const fields = { csrfToken, callbackUrl: query.get("callbackUrl") ?? "/" };
  const forms = providers.map((p) => providerForm(basePath, p, fields)).join("");
  return page("Sign in", `<h1>Sign in</h1>${message(query.get("error"))}${forms}`);
}

/**
 * The sign-out confirmation page.
 *
 * @param basePath The endpoint prefix.
 * @param csrfToken This browser's CSRF token.
 * @param query The page's query (`callbackUrl`).
 * @returns The page.
 */
export function signOutPage(basePath: string, csrfToken: string, query: URLSearchParams): Response {
  const fields = { csrfToken, callbackUrl: query.get("callbackUrl") ?? "/" };
  return page(
    "Sign out",
    `<h1>Sign out</h1><p>Are you sure you want to sign out?</p>` +
      `<form method="post" action="${esc(`${basePath}/signout`)}">${hidden(fields)}` +
      `<button type="submit">Sign out</button></form>`,
  );
}

/**
 * The "check your email" page.
 *
 * @returns The page.
 */
export function verifyRequestPage(): Response {
  return page("Check your email", "<h1>Check your email</h1><p>A sign in link has been sent.</p>");
}

/**
 * The error page.
 *
 * @param query The page's query (`error`).
 * @returns The page.
 */
export function errorPage(query: URLSearchParams): Response {
  const code = query.get("error") ?? "Default";
  return page(
    "Error",
    `<h1>Unable to sign in</h1>${message(code)}`,
    code === "Configuration" ? 500 : 400,
  );
}
