// The backend's admin endpoint: what `denext ui`'s Database section and the stack's dashboard
// show of the RUNNING app — realtime's live channels and `postgres_changes` bindings, the
// presence keys of a topic (and, only when an operator expands one, that key's payloads), Edge
// Functions with their recent invocations, and the `services/` supervision tree. That state lives
// in the app's process, so no child process or database query can read it.
//
//   GET /_denext/backend/admin/status                              → { ok, realtime, functions, services }
//   GET /_denext/backend/admin/presence?topic=t&private=0          → { ok, keys: { key: count } }
//   GET /_denext/backend/admin/presence?topic=t&private=0&key=k    → { ok, key, payloads }
//
// It answers only a caller that presents the SECRET key (`apikey: sb_secret_…`, or as a bearer):
// the service role. No key installed (`backend({ supabase })` off), no key, another key: refused
// before anything is read. GET only, `no-store`.

import {
  apiKeyRole,
  bearerTokenOf,
  installedSupabaseKeys,
  supervisionStatus,
} from "@denext/denext/server";
import { functionsAdmin } from "./functions-admin.ts";
import { installedRealtimeHub } from "./realtime-socket.ts";

/** Where the endpoint lives. */
export const ADMIN_PREFIX = "/_denext/backend/admin";

/** The longest topic or presence key accepted. */
const MAX_NAME = 255;

/** A JSON answer that no cache keeps. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** The secret key a request presents (the `apikey` header, else the bearer), or `""`. */
function presented(request: Request): string {
  return request.headers.get("apikey")?.trim() ||
    bearerTokenOf(request.headers.get("authorization")) || "";
}

/**
 * Why a request may not read the endpoint — `null` when it presents the secret key.
 *
 * @param request The request.
 * @returns The refusal, or `null`.
 */
async function adminRefusal(request: Request): Promise<Response | null> {
  const keys = installedSupabaseKeys();
  if (!keys) {
    return json({
      ok: false,
      reason: "the admin endpoint needs the backend's keys: backend({ supabase }) and " +
        "DENEXT_SECRET_KEY (denext backend keys)",
    }, 403);
  }
  const key = presented(request);
  let role: string | undefined;
  try {
    role = key ? await apiKeyRole(keys, key) : undefined;
  } catch {
    role = undefined;
  }
  if (role !== "service_role") {
    return json({ ok: false, reason: "the secret key is required" }, 401);
  }
  if (request.method !== "GET") return json({ ok: false, reason: "method not allowed" }, 405);
  return null;
}

/** `/status`: realtime, functions and the supervision tree. */
async function status(): Promise<Response> {
  const hub = installedRealtimeHub();
  const functions = functionsAdmin();
  return json({
    ok: true,
    realtime: hub ? hub.adminState() : null,
    functions: functions
      ? { functions: await functions.functions(), invocations: functions.invocations() }
      : null,
    services: supervisionStatus(),
  });
}

/** `/presence`: a topic's keys, or (with `key`) that one key's payloads. */
async function presence(url: URL): Promise<Response> {
  const hub = installedRealtimeHub();
  if (!hub) return json({ ok: false, reason: "realtime's socket is not on" }, 404);
  const topic = url.searchParams.get("topic") ?? "";
  const key = url.searchParams.get("key");
  if (topic === "" || topic.length > MAX_NAME || (key !== null && key.length > MAX_NAME)) {
    return json(
      { ok: false, reason: "a topic (and optionally a key) of at most 255 characters" },
      400,
    );
  }
  const isPrivate = url.searchParams.get("private") === "1";
  if (key === null) return json({ ok: true, keys: await hub.presenceKeys(topic, isPrivate) });
  return json({ ok: true, key, payloads: await hub.presenceOf(topic, isPrivate, key) });
}

/**
 * The admin endpoint's handler (registered by the plugin): `null` for any other path.
 *
 * @param request The request (app-relative).
 * @returns The response, or `null`.
 */
export async function handleAdminRequest(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== ADMIN_PREFIX && !url.pathname.startsWith(ADMIN_PREFIX + "/")) return null;
  const refused = await adminRefusal(request);
  if (refused) return refused;
  try {
    if (url.pathname === `${ADMIN_PREFIX}/status`) return await status();
    if (url.pathname === `${ADMIN_PREFIX}/presence`) return await presence(url);
    return json({ ok: false, reason: "not found" }, 404);
  } catch (error) {
    console.error("[@denext/backend] admin endpoint failed", error);
    return json({ ok: false, reason: "the admin endpoint failed" }, 500);
  }
}
