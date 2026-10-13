/**
 * `buildAuthnRequest`: an unsigned SAML 2.0 AuthnRequest over the HTTP-Redirect binding.
 *
 * @module
 */

import type { SamlIdpConfig, SamlSpConfig } from "./config.ts";
import { DEFAULT_NAME_ID_FORMAT, escapeXml } from "./metadata.ts";

/** Options for {@link buildAuthnRequest}. */
export interface BuildAuthnRequestOptions {
  /** This SP. */
  sp: SamlSpConfig;
  /** The IdP the request goes to (its `ssoUrl`). */
  idp: SamlIdpConfig;
  /** Opaque state the IdP echoes back with the Response (SAML caps it at 80 bytes). */
  relayState?: string;
  /** The NameIDPolicy Format to ask for. Default email address. */
  nameIdFormat?: string;
  /** The IssueInstant, epoch milliseconds. Default `Date.now()`. */
  now?: number;
  /** Ask the IdP to re-authenticate the user even with a live IdP session. */
  forceAuthn?: boolean;
}

/** DEFLATE (raw, no zlib header) — an AuthnRequest compresses to well under 64 KiB. */
async function deflateRaw(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Build an AuthnRequest and the IdP URL that carries it (HTTP-Redirect binding: the XML is
 * DEFLATE-compressed, base64-encoded and URL-encoded into `SAMLRequest`). The request is
 * unsigned and names this SP's HTTP-POST ACS URL. Remember the returned `id` (with the
 * RelayState) and pass it as `expectedInResponseTo` when the Response arrives.
 *
 * @returns `id`, the request ID (`_` + 40 hex digits), and `url`, where to redirect the browser.
 */
export async function buildAuthnRequest(
  options: BuildAuthnRequestOptions,
): Promise<{ id: string; url: string }> {
  const { sp, idp } = options;
  const random = crypto.getRandomValues(new Uint8Array(20));
  const id = "_" + Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("");
  const instant = new Date(options.now ?? Date.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const format = options.nameIdFormat ?? DEFAULT_NAME_ID_FORMAT;
  const xml = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"` +
    ` xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0"` +
    ` IssueInstant="${instant}" Destination="${escapeXml(idp.ssoUrl)}"` +
    ` AssertionConsumerServiceURL="${escapeXml(sp.acsUrl)}"` +
    ` ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"` +
    (options.forceAuthn ? ` ForceAuthn="true"` : "") +
    `><saml:Issuer>${escapeXml(sp.entityId)}</saml:Issuer>` +
    `<samlp:NameIDPolicy Format="${escapeXml(format)}" AllowCreate="true"/>` +
    `</samlp:AuthnRequest>`;
  const url = new URL(idp.ssoUrl);
  url.searchParams.append("SAMLRequest", btoa(String.fromCharCode(...await deflateRaw(xml))));
  if (options.relayState !== undefined) url.searchParams.append("RelayState", options.relayState);
  return { id, url: url.toString() };
}
