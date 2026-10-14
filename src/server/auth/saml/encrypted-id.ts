/**
 * The NameID of an Assertion's Subject or of a LogoutRequest: a plaintext `saml:NameID`, or a
 * `saml:EncryptedID` decrypted with the SP key under the same rules as an EncryptedAssertion —
 * the algorithm allow-list and strict content model of `xmlenc.ts`, exactly one EncryptedKey,
 * and decrypted content that must be exactly one `saml:NameID`, parsed by the strict parser in
 * the namespace context of the EncryptedID.
 *
 * Callers read the NameID only after the signature covering it (the Assertion's, the
 * Response's or the LogoutRequest's — over the cipher text) has verified. Without one, every
 * failure from the key unwrap to the decrypted NameID is the one `decryption_failed`, so the
 * refusal is no decryption, padding or well-formedness oracle.
 *
 * @module
 */

import { malformed, refuse, SAML_NS, textOnly } from "./common.ts";
import type { SamlPrivateKey } from "./config.ts";
import { SamlError } from "./errors.ts";
import { childElements, inScopeNamespaces, parseXml, type XmlElement } from "./xml.ts";
import { decryptElement, readEncryptedElement } from "./xmlenc.ts";

/**
 * Decrypt an EncryptedID into its one NameID element.
 *
 * @param container The `saml:EncryptedID` element.
 * @param key The SP decryption key (none: `encrypted_assertion_unsupported`).
 * @param covered Whether a verified signature covers the EncryptedID.
 * @returns The decrypted `saml:NameID` element (non-empty, text only).
 * @throws {SamlError} `encrypted_assertion_unsupported`, `malformed_response`,
 *   `unsupported_algorithm`, `bad_key`, and — inside the decryption window — `decryption_failed`,
 *   `malformed_xml`, `unexpected_markup` (every one of them `decryption_failed` when not
 *   `covered`).
 */
export async function decryptNameId(
  container: XmlElement,
  key: SamlPrivateKey | undefined,
  covered: boolean,
): Promise<XmlElement> {
  if (!key) refuse("encrypted_assertion_unsupported", "an EncryptedID needs an SP decryption key");
  const parts = readEncryptedElement(container);
  const open = async () => {
    const bytes = await decryptElement(parts, key);
    const root = parseXml(bytes, { inScope: inScopeNamespaces(container) }).root;
    if (root.ns !== SAML_NS || root.local !== "NameID") {
      malformed("the EncryptedID does not hold a NameID");
    }
    if (!textOnly(root)) malformed("empty NameID");
    return root;
  };
  if (covered) return await open();
  try {
    return await open();
  } catch (error) {
    if (error instanceof SamlError && error.code === "bad_key") throw error;
    throw new SamlError("decryption_failed", "the EncryptedID could not be opened");
  }
}

/**
 * The one NameID of `parent` (a Subject or a LogoutRequest): exactly one `saml:NameID` or
 * `saml:EncryptedID` child, the latter decrypted.
 *
 * @param parent The element holding the identifier.
 * @param key The SP decryption key.
 * @param covered Whether a verified signature covers `parent`.
 * @returns The NameID element.
 * @throws {SamlError} As {@linkcode decryptNameId}, and `malformed_response` for none or two.
 */
export async function soleNameId(
  parent: XmlElement,
  key: SamlPrivateKey | undefined,
  covered: boolean,
): Promise<XmlElement> {
  const plain = childElements(parent, SAML_NS, "NameID");
  const encrypted = childElements(parent, SAML_NS, "EncryptedID");
  if (encrypted.length && !key) {
    refuse("encrypted_assertion_unsupported", "an EncryptedID needs an SP decryption key");
  }
  if (plain.length + encrypted.length !== 1) {
    malformed(`<${parent.local}> must hold one NameID or EncryptedID`);
  }
  return plain.length ? plain[0] : await decryptNameId(encrypted[0], key, covered);
}
