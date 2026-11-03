// Loopy's voice backend for the browser (`denext task dev`): `POST /api/voice` with
// `{ "op": "status" | "session" | "tool" | "setKey" | "clearKey", ... }`, answered as JSON. The key
// is the dev server's `OPENAI_API_KEY` (voice/keys.ts); `setKey` / `clearKey` answer 409 there.
//
// Only the page itself may call it, so no other site can mint sessions on the key:
// - the Host must be loopback (a DNS-rebinding page's Host is its own domain);
// - an `Origin` must be the request's own origin, and `Sec-Fetch-Site`, when sent, `same-origin`;
// - the body must be `application/json` (a cross-site form can't send that without a preflight)
//   and at most 16 KiB.

import { boundedText } from "../inbox/handler.ts";
import { VoiceError } from "./realtime.ts";
import type { VoiceService } from "./service.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** A JSON answer that is never cached. */
function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** The refusal for a request from anywhere but the page, or `null`. */
function refuse(request: Request, url: URL): Response | null {
  if (request.method !== "POST") return json(405, { error: { code: "method" } });
  if (!LOOPBACK_HOSTS.has(url.hostname)) return json(403, { error: { code: "loopback_only" } });
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) {
    return json(403, { error: { code: "cross_origin" } });
  }
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") {
    return json(403, { error: { code: "cross_origin" } });
  }
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) return json(415, { error: { code: "json_only" } });
  return null;
}

/** Run the requested operation. */
function dispatch(service: VoiceService, body: Record<string, unknown>): Promise<unknown> {
  switch (body.op) {
    case "status":
      return service.status();
    case "session":
      return service.session();
    case "tool":
      return service.tool(body);
    case "setKey":
      return service.setKey(body);
    case "clearKey":
      return service.clearKey();
    default:
      return Promise.reject(new VoiceError("validation", "unknown op", 404));
  }
}

/**
 * The route handler over `service`.
 *
 * @returns `(request) => Response`: the operation's result as JSON, else
 *   `{ error: { code, message } }` at the refusal's status.
 */
export function createVoiceRoute(service: VoiceService): (request: Request) => Promise<Response> {
  return async (request) => {
    const refused = refuse(request, new URL(request.url));
    if (refused) {
      await request.body?.cancel();
      return refused;
    }
    const text = await boundedText(request);
    if (text === null) return json(413, { error: { code: "too_large" } });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { error: { code: "validation", message: "not JSON" } });
    }
    if (typeof body !== "object" || body === null) {
      return json(400, { error: { code: "validation", message: "expected an object" } });
    }
    try {
      return json(200, await dispatch(service, body as Record<string, unknown>));
    } catch (err) {
      if (err instanceof VoiceError) {
        return json(err.status, { error: { code: err.code, message: err.message } });
      }
      return json(500, { error: { code: "failed", message: "Loopy's voice backend failed." } });
    }
  };
}
