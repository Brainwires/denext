/**
 * The OAuth client admin API (`supabase.auth.admin.oauth.*`): list, create, read, update,
 * delete, regenerate a secret. Service role only (the handler's `admin` gate).
 *
 * A confidential client's secret is shown exactly twice — in the create and the
 * regenerate response — and stored only as a domain-separated SHA-256 (it is 256 random bits,
 * so a fast hash is the right one). Deleting a client revokes every session family it holds.
 *
 * @module
 */

import {
  type OAuthClientRecord,
  type OAuthServerStore,
  oauthServerStoreOf,
} from "../adapter-oauth-server.ts";
import { constantTimeEqualHex, sha256Hex } from "@denext/denext/auth-kit";
import { randomToken } from "../oauth.ts";
import { type GoTrueContext, nowSeconds, ok, pageParams, readJson } from "./context.ts";
import { fail, GoTrueError } from "./errors.ts";
import { familiesOf } from "./session.ts";
import { iso } from "./user.ts";

/** The scopes the authorization server knows. */
export const SUPPORTED_SCOPES = ["openid", "email", "profile", "phone"];
const AUTH_METHODS = ["none", "client_secret_basic", "client_secret_post"] as const;
const GRANT_TYPES = ["authorization_code", "refresh_token"];
const BLOCKED_SCHEMES = ["javascript:", "data:", "vbscript:", "file:", "blob:"];

/**
 * The OAuth-server store, or a refusal: the feature is off, or the adapter lacks the group.
 *
 * @param ctx The context.
 * @returns The store.
 */
export function oauthStore(ctx: GoTrueContext): OAuthServerStore {
  if (!ctx.options.oauthServer) {
    throw new GoTrueError(404, "not_found", "OAuth server is not enabled");
  }
  const store = oauthServerStoreOf(ctx.adapter);
  if (!store) {
    throw new GoTrueError(500, "unexpected_failure", "the auth adapter keeps no OAuth clients");
  }
  return store;
}

/**
 * The hash a client secret is stored as.
 *
 * @param secret The secret.
 * @returns SHA-256 hex.
 */
function clientSecretHash(secret: string): Promise<string> {
  return sha256Hex(`gotrue-oauth-client-secret:${secret}`);
}

/**
 * Whether `secret` is the client's.
 *
 * @param client The client.
 * @param secret The presented secret.
 * @returns `true` on a match.
 */
export async function clientSecretMatches(
  client: OAuthClientRecord,
  secret: string,
): Promise<boolean> {
  if (!client.secretHash || !secret || secret.length > 512) return false;
  return constantTimeEqualHex(await clientSecretHash(secret), client.secretHash);
}

/** Whether a URL is a loopback `http:` redirect (RFC 8252 §7.3). */
export function isLoopback(url: URL): boolean {
  return url.protocol === "http:" &&
    ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
}

/** A registrable redirect URI: absolute, no fragment, https / loopback http / an app scheme. */
function validRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password || BLOCKED_SCHEMES.includes(url.protocol)) {
    return false;
  }
  return url.protocol === "https:" || isLoopback(url) || !url.protocol.startsWith("http");
}

function stringList(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw fail.validation(`${key} must be an array of strings`);
  }
  return value as string[];
}

function optionalUrl(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 2048) throw fail.validation(`invalid ${key}`);
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
  } catch {
    throw fail.validation(`invalid ${key}`);
  }
  return value;
}

/** Apply the writable fields of a create / update body to a client. */
function applyFields(client: OAuthClientRecord, body: Record<string, unknown>): void {
  if (body.client_name !== undefined) {
    if (typeof body.client_name !== "string" || !body.client_name.trim()) {
      throw fail.validation("client_name is required");
    }
    client.name = body.client_name.trim().slice(0, 200);
  }
  for (const [key, field] of [["client_uri", "clientUri"], ["logo_uri", "logoUri"]] as const) {
    if (body[key] !== undefined) {
      const value = optionalUrl(body, key);
      if (value) client[field] = value;
      else delete client[field];
    }
  }
  const uris = stringList(body, "redirect_uris");
  if (uris) {
    if (!uris.length || uris.length > 20 || !uris.every(validRedirectUri)) {
      throw fail.validation("redirect_uris must be 1–20 absolute URIs without a fragment");
    }
    client.redirectUris = [...new Set(uris)];
  }
  applyTypes(client, body);
}

function applyTypes(client: OAuthClientRecord, body: Record<string, unknown>): void {
  const grants = stringList(body, "grant_types");
  if (grants) {
    if (!grants.includes("authorization_code") || grants.some((g) => !GRANT_TYPES.includes(g))) {
      throw fail.validation("grant_types must include authorization_code (and refresh_token)");
    }
    client.grantTypes = [...new Set(grants)];
  }
  const responses = stringList(body, "response_types");
  if (responses) {
    if (responses.length !== 1 || responses[0] !== "code") {
      throw fail.validation('response_types must be ["code"]');
    }
  }
  if (typeof body.scope === "string") {
    const scopes = body.scope.split(/\s+/).filter(Boolean);
    if (scopes.some((s) => !SUPPORTED_SCOPES.includes(s))) {
      throw new GoTrueError(400, "validation_failed", "scope names an unsupported scope");
    }
    if (scopes.length) client.scope = scopes.join(" ");
    else delete client.scope;
  }
}

/** The auth method a body asks for, validated. */
function authMethodOf(
  body: Record<string, unknown>,
): OAuthClientRecord["tokenEndpointAuthMethod"] | undefined {
  const method = body.token_endpoint_auth_method;
  if (method === undefined || method === null) return undefined;
  if (!AUTH_METHODS.includes(method as typeof AUTH_METHODS[number])) {
    throw fail.validation("unsupported token_endpoint_auth_method");
  }
  return method as OAuthClientRecord["tokenEndpointAuthMethod"];
}

/**
 * GoTrue's JSON for a client (the secret only when just minted).
 *
 * @param client The client.
 * @param secret The new secret, on create / regenerate.
 * @returns The JSON.
 */
function clientJson(client: OAuthClientRecord, secret?: string): Record<string, unknown> {
  return {
    client_id: client.id,
    client_name: client.name,
    ...(secret ? { client_secret: secret } : {}),
    client_type: client.clientType,
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    registration_type: client.registrationType,
    ...(client.clientUri ? { client_uri: client.clientUri } : {}),
    ...(client.logoUri ? { logo_uri: client.logoUri } : {}),
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    response_types: client.responseTypes,
    ...(client.scope ? { scope: client.scope } : {}),
    created_at: iso(client.createdAt),
    updated_at: iso(client.updatedAt),
  };
}

/** Switch a client's auth method; a newly confidential client gets a secret (returned). */
async function setAuthMethod(
  client: OAuthClientRecord,
  method: OAuthClientRecord["tokenEndpointAuthMethod"],
): Promise<string | undefined> {
  client.tokenEndpointAuthMethod = method;
  client.clientType = method === "none" ? "public" : "confidential";
  if (method === "none") {
    delete client.secretHash;
    return undefined;
  }
  if (client.secretHash) return undefined;
  const secret = randomToken(32);
  client.secretHash = await clientSecretHash(secret);
  return secret;
}

async function clientById(ctx: GoTrueContext, store: OAuthServerStore): Promise<OAuthClientRecord> {
  const id = ctx.params.id;
  const client = /^[\w-]{1,64}$/.test(id) ? await store.getOAuthClient(id) : undefined;
  if (!client) throw new GoTrueError(404, "oauth_client_not_found", "OAuth client not found");
  return client;
}

/** `GET /admin/oauth/clients?page=&per_page=`. */
export async function listClients(ctx: GoTrueContext): Promise<Response> {
  const store = oauthStore(ctx);
  const { page, perPage } = pageParams(ctx.url);
  const { clients, total } = await store.listOAuthClients({ page, perPage });
  const last = Math.max(1, Math.ceil(total / perPage));
  const link = (n: number, rel: string) =>
    `</auth/v1/admin/oauth/clients?page=${n}&per_page=${perPage}>; rel="${rel}"`;
  const links = [...(page < last ? [link(page + 1, "next")] : []), link(last, "last")];
  return ok(
    { clients: clients.map((client) => clientJson(client)), aud: "authenticated" },
    200,
    { "x-total-count": String(total), link: links.join(", ") },
  );
}

/** `POST /admin/oauth/clients`. */
export async function createClient(ctx: GoTrueContext): Promise<Response> {
  const store = oauthStore(ctx);
  const body = await readJson(ctx);
  if (typeof body.client_name !== "string") throw fail.validation("client_name is required");
  if (body.redirect_uris === undefined) throw fail.validation("redirect_uris is required");
  const at = nowSeconds();
  const client: OAuthClientRecord = {
    id: crypto.randomUUID(),
    name: "",
    clientType: "confidential",
    tokenEndpointAuthMethod: "client_secret_basic",
    registrationType: "manual",
    redirectUris: [],
    grantTypes: [...GRANT_TYPES],
    responseTypes: ["code"],
    createdAt: at,
    updatedAt: at,
  };
  applyFields(client, body);
  const secret = await setAuthMethod(client, authMethodOf(body) ?? "client_secret_basic");
  await store.createOAuthClient(client);
  return ok(clientJson(client, secret), 201);
}

/** `GET /admin/oauth/clients/:id`. */
export async function getClient(ctx: GoTrueContext): Promise<Response> {
  return ok(clientJson(await clientById(ctx, oauthStore(ctx))));
}

/** `PUT /admin/oauth/clients/:id`. */
export async function updateClient(ctx: GoTrueContext): Promise<Response> {
  const store = oauthStore(ctx);
  const client = await clientById(ctx, store);
  const body = await readJson(ctx);
  applyFields(client, body);
  const method = authMethodOf(body);
  const secret = method ? await setAuthMethod(client, method) : undefined;
  client.updatedAt = nowSeconds();
  await store.updateOAuthClient(client);
  return ok(clientJson(client, secret));
}

/**
 * Revoke every session family a client holds.
 *
 * @param ctx The context.
 * @param ids The family ids.
 */
export async function revokeFamilies(ctx: GoTrueContext, ids: string[]): Promise<void> {
  const families = familiesOf(ctx.config);
  for (const id of ids) await families.revokeNativeSession(id);
}

/** `DELETE /admin/oauth/clients/:id`: the client, its grants, and its tokens. */
export async function deleteClient(ctx: GoTrueContext): Promise<Response> {
  const store = oauthStore(ctx);
  const client = await clientById(ctx, store);
  await revokeFamilies(ctx, await store.listOAuthClientSessions(client.id));
  await store.deleteOAuthClient(client.id);
  return new Response(null, { status: 204 });
}

/** `POST /admin/oauth/clients/:id/regenerate_secret`. */
export async function regenerateSecret(ctx: GoTrueContext): Promise<Response> {
  const store = oauthStore(ctx);
  const client = await clientById(ctx, store);
  if (client.clientType !== "confidential") {
    throw fail.validation("a public client has no secret");
  }
  const secret = randomToken(32);
  client.secretHash = await clientSecretHash(secret);
  client.updatedAt = nowSeconds();
  await store.updateOAuthClient(client);
  return ok(clientJson(client, secret));
}
