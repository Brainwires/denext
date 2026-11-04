/**
 * ONE spelling for an email address, wherever the auth layer keys on one.
 *
 * `a@bücher.de` and `a@xn--bcher-kva.de` are the same mailbox — the second is what SMTP
 * carries, the first is what a person types — and `A@X.test` is `a@x.test`. Every place
 * that stores, looks up or compares an address by value goes through {@linkcode emailKey},
 * so a user registered through one sign-in flow is found by every other: the alternative
 * (which shipped) was a credentials account at `a@bücher.de` that a magic link duplicated
 * and a password reset could not find.
 *
 * Kept dependency-free on purpose: the adapters import it, and they must stay as light
 * as the storage they wrap.
 *
 * @module
 */

/** Printable ASCII — anything else in a domain is an internationalised name. */
const PRINTABLE_ASCII = /^[ -~]*$/;
/** Characters the URL parser would read as more than a host name. */
const NOT_A_HOST = /[\s/?#:@\\%[\]]/;

/**
 * `address` with an internationalised domain in its ASCII (punycode) form — `a@bücher.de`
 * becomes `a@xn--bcher-kva.de` — so the identifier and the recipient are what SMTP carries.
 * The local part is left as is (an SMTPUTF8 one still fails the address check), and a domain
 * the URL parser would read as more than a host name is refused.
 *
 * @param address A trimmed, lower-cased address.
 * @returns The address with an ASCII domain, or `null` when the domain is not a host name.
 */
export function asciiDomain(address: string): string | null {
  const at = address.lastIndexOf("@");
  const domain = address.slice(at + 1);
  if (at < 0 || PRINTABLE_ASCII.test(domain)) return address;
  if (NOT_A_HOST.test(domain)) return null;
  try {
    return address.slice(0, at + 1) + new URL(`http://${domain}`).hostname;
  } catch {
    return null;
  }
}

/**
 * The key an address is stored and looked up under: trimmed, lower-cased, and with an
 * internationalised domain in its punycode form. Total — an address whose domain is not a
 * host name keeps its trimmed, lower-cased spelling, because a store still needs SOME key
 * for it; validation is {@link ./verification.ts | normalizeEmailIdentifier}'s job.
 *
 * @param email The address as submitted or stored.
 * @returns The one spelling every auth flow agrees on.
 */
export function emailKey(email: string): string {
  const folded = email.trim().toLowerCase();
  return asciiDomain(folded) ?? folded;
}
