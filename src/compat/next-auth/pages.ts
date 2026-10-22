/**
 * The built-in pages Auth.js serves when an app configures none: sign-in (a form per provider,
 * each carrying the CSRF token), sign-out confirmation, "check your email", and errors. Plain
 * HTML with every value escaped. The one script is the passkey button's (a WebAuthn provider
 * signs in from script, never from a form): a fixed body the sign-in page's own
 * Content-Security-Policy allows by its hash, so nothing else inline can run there.
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

/** A whole page, with any extra response headers. */
function page(
  title: string,
  body: string,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(title)}</title></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
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
  WebAuthnVerificationError: "Sign in with a passkey failed. Please try again.",
};

/** The message for an error code. */
function message(code: string | null): string {
  if (!code) return "";
  // Own keys only: `?error=constructor` must not reach `Object.prototype`.
  const text = Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : "Unable to sign in.";
  return `<p role="alert">${esc(text)}</p>`;
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
 * The passkey button's script: a fixed body (its hash is {@link PASSKEY_SCRIPT_HASH}). It shows
 * every `[data-denext-passkey]` button when the browser has WebAuthn, and on a click runs
 * denext's passkey sign-in ceremony against the button's `data-base` (the `/passkey/authenticate`
 * endpoints `next-auth/webauthn` uses), landing on the server's same-origin coercion of
 * `data-callback`. A cancel says nothing; a refusal shows in the error line beside the button.
 */
export const PASSKEY_SCRIPT = `(function () {
  var pk = window.PublicKeyCredential;
  if (typeof pk !== "function" || !navigator.credentials) return;
  function fromB64u(v) {
    var b = v.replace(/-/g, "+").replace(/_/g, "/");
    while (b.length % 4) b += "=";
    return Uint8Array.from(atob(b), function (c) { return c.charCodeAt(0); }).buffer;
  }
  function toB64u(buf) {
    var bytes = new Uint8Array(buf), s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  }
  function options(json) {
    if (pk.parseRequestOptionsFromJSON) return pk.parseRequestOptionsFromJSON(json);
    json.challenge = fromB64u(json.challenge);
    if (json.allowCredentials) {
      json.allowCredentials = json.allowCredentials.map(function (d) {
        return Object.assign({}, d, { id: fromB64u(d.id) });
      });
    }
    return json;
  }
  function credential(c) {
    if (typeof c.toJSON === "function") return c.toJSON();
    var r = c.response, out = {
      clientDataJSON: toB64u(r.clientDataJSON),
      authenticatorData: toB64u(r.authenticatorData),
      signature: toB64u(r.signature)
    };
    if (r.userHandle) out.userHandle = toB64u(r.userHandle);
    return {
      id: c.id, rawId: toB64u(c.rawId), type: c.type, response: out,
      clientExtensionResults: c.getClientExtensionResults ? c.getClientExtensionResults() : {}
    };
  }
  function post(url, body) {
    return fetch(url, {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json", "x-denext-auth": "1" },
      body: JSON.stringify(body)
    });
  }
  async function run(button) {
    var base = button.getAttribute("data-base"), error = button.nextElementSibling;
    error.hidden = true;
    try {
      var res = await post(base + "/passkey/authenticate/options", {});
      if (!res.ok) throw new Error("options");
      var json = await res.json(), ceremonyId = json.ceremonyId;
      delete json.ceremonyId;
      var asserted;
      try {
        asserted = await navigator.credentials.get({ publicKey: options(json) });
      } catch (e) {
        if (e && (e.name === "NotAllowedError" || e.name === "AbortError")) return;
        throw e;
      }
      if (!asserted) return;
      res = await post(base + "/passkey/authenticate", {
        credential: credential(asserted), ceremonyId: ceremonyId,
        callbackUrl: button.getAttribute("data-callback")
      });
      if (!res.ok) throw new Error("verify");
      var body = await res.json();
      location.assign(body.url || "/");
    } catch (e) {
      error.hidden = false;
    }
  }
  document.querySelectorAll("[data-denext-passkey]").forEach(function (button) {
    button.hidden = false;
    button.addEventListener("click", function () { run(button); });
  });
})();`;

/**
 * `'sha256-…'` of {@link PASSKEY_SCRIPT}, the source the sign-in page's CSP allows (a test
 * checks it against the body).
 */
export const PASSKEY_SCRIPT_HASH = "'sha256-T9XnsmUmC31gcc54L+zScEHO4VTs76pTZ0MpY+bYKaU='";

/** A WebAuthn provider's button (hidden until the script finds WebAuthn) and its error line. */
function passkeyButton(
  basePath: string,
  provider: ProviderDescriptor,
  callbackUrl: string,
): string {
  return `<div><button type="button" data-denext-passkey hidden data-base="${esc(basePath)}" ` +
    `data-callback="${esc(callbackUrl)}">Sign in with ${esc(provider.name)}</button>` +
    `<p data-denext-passkey-error hidden aria-live="polite">` +
    `${esc(MESSAGES.WebAuthnVerificationError)}</p></div>`;
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
  // A WebAuthn provider signs in from script (the passkey button), never from a plain form.
  const forms = providers.map((p) =>
    p.type === "webauthn"
      ? passkeyButton(basePath, p, fields.callbackUrl)
      : providerForm(basePath, p, fields)
  ).join("");
  const body = `<h1>Sign in</h1>${message(query.get("error"))}${forms}`;
  if (!providers.some((p) => p.type === "webauthn")) return page("Sign in", body);
  return page("Sign in", `${body}<script>${PASSKEY_SCRIPT}</script>`, 200, {
    "content-security-policy": `script-src ${PASSKEY_SCRIPT_HASH}; object-src 'none'; ` +
      "base-uri 'none'",
  });
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
