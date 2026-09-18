---
title: Route handler recipes
slug: route-handler-recipes
lead: A route.ts is a web-standard Request → Response function on the full Deno runtime, so the recipes below are mostly plain web platform code. What denext adds around them — the body cap, the request deadline, cookie and header queuing, the 405 — is spelled out where it changes what you should write.
---

Every recipe is `app/<path>/route.ts` exporting one function per HTTP method
(`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`). A method the
module does not export answers `405` with an `Allow` header listing the ones it
does; `HEAD` is derived from `GET` when you export only `GET`. The request body
is capped at 1 MiB unless the module says otherwise
(`export const maxBodyBytes = N | false`) — an over-cap `Content-Length` is a
`413` before the handler runs, and a chunked body past the cap errors the stream
as you read it. A typed, validated handler is [`defineApi`](/docs/typed-api);
the recipes here are the cases that are about the wire, not the schema.

## Webhook with signature verification

A provider signs the **raw** body. Read it with `request.text()` — not
`request.json()`, which would re-serialize and break the MAC — and verify with
`crypto.subtle.verify`, which is constant-time. The example is the common
HMAC-SHA256-over-body shape (Stripe's `t=…,v1=…` and GitHub's `sha256=…` headers
both reduce to it once you split the header).

```ts
// app/api/webhooks/billing/route.ts
export const maxBodyBytes = 4 * 1024 * 1024; // the provider's largest event; the default is 1 MiB

const encoder = new TextEncoder();
const secret = Deno.env.get("WEBHOOK_SECRET")!;

async function verify(body: string, header: string | null): Promise<boolean> {
  if (!header) return false;
  const hex = header.replace(/^sha256=/, "");
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  const sig = Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, sig, encoder.encode(body)); // constant-time
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.text(); // the raw bytes the provider signed
  if (!(await verify(body, request.headers.get("x-signature-256")))) {
    return new Response("bad signature", { status: 401 });
  }
  const event = JSON.parse(body);
  await handleEvent(event); // idempotent: providers retry
  return new Response(null, { status: 204 });
}
```

Two framework notes. The Server Action origin check does not apply to a
`route.ts`, so a cross-origin POST from the provider reaches the handler as-is —
the signature _is_ the authentication. And `hmacSign` / `hmacVerify` from
`denext/plugin-kit` are the framework's own session-token MAC (domain-separated,
URL-safe base64), not a general webhook verifier — use `crypto.subtle` directly
as above so the output matches the provider's format.

## Server-Sent Events

A `ReadableStream` with `Content-Type: text/event-stream`. Close the interval in
`cancel`: that callback fires when the client disconnects, and it is the only
thing that stops the producer.

```ts
// app/api/events/route.ts
export function GET(request: Request): Response {
  const encoder = new TextEncoder();
  let timer: number;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`retry: 3000\n\n`)); // reconnect hint
      timer = setInterval(() => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ at: Date.now() })}\n\n`),
        );
      }, 1000);
    },
    cancel() {
      clearInterval(timer); // the client went away
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no", // nginx: don't buffer the stream
    },
  });
}
```

**What the request deadline does to a stream.** `requestTimeout` (30 s by
default) races the _production_ of the `Response` against a timer. A streaming
response wins that race the moment its headers are ready, so the `503` never
fires for it — but the timer stays armed until the body is fully consumed or
cancelled, and when it expires denext aborts the request's cooperative
`AbortSignal`. That signal is what stops a still-rendering Suspense hole in a
streamed page; a hand-built stream in a route handler does not see it, so **the
stream keeps flowing past the deadline** — verified on the pipeline
`denext start` uses: an SSE handler emitting once a second was still delivering
at 35 s with the default deadline, and its `cancel` ran only when the client
disconnected. The consequences: don't set `requestTimeout: 0` for the sake of
SSE (there is no need), do close the producer in `cancel`, and remember the
in-process `maxConcurrency` slot is released when the `Response` is returned,
not when the stream ends — bound long-lived connections at the edge.

## Long-running streaming (an AI completion)

The same shape, piping an upstream stream through instead of a timer. Forward
the client's disconnect upstream with an `AbortController` so a closed tab stops
the paid tokens.

```ts
// app/api/chat/route.ts
export async function POST(request: Request): Promise<Response> {
  const { prompt } = await request.json();
  const upstream = new AbortController();
  const res = await fetch("https://api.example.com/v1/complete", {
    method: "POST",
    headers: {
      authorization: `Bearer ${Deno.env.get("MODEL_API_KEY")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ prompt, stream: true }),
    signal: upstream.signal,
  });
  if (!res.ok || !res.body) {
    return new Response("upstream error", { status: 502 });
  }

  const body = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk); // or re-frame the provider's SSE into your own events
      },
      cancel() {
        upstream.abort(); // the browser closed the connection: stop the upstream stream
      },
    }),
  );
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}
```

On the client, read it with `fetch` + `res.body.getReader()` (or `EventSource`
for a GET), appending as chunks land. Everything in the SSE section about the
deadline applies: the response is out once the upstream's headers arrive, and
only the client's disconnect (through `cancel`) ends it.

## WebSocket upgrade

`Deno.upgradeWebSocket` works inside a route handler, through the ordinary
pipeline (middleware, the request deadline, the security headers). Verified
against the same `createApp` pipeline `denext start` runs, under `Deno.serve`:
the `101` reaches the client with the upgrade intact, messages round-trip, and a
`cookies().set()` queued before the upgrade is applied to the `101` **without**
dropping the upgrade (the concern that rebuilding the response for a queued
header might break it does not materialize — the socket stays attached to the
request, not to the `Response` object).

```ts
// app/api/socket/route.ts
export function GET(request: Request): Response {
  if (request.headers.get("upgrade") !== "websocket") {
    return new Response("expected a WebSocket upgrade", { status: 426 });
  }
  const { socket, response } = Deno.upgradeWebSocket(request, {
    idleTimeout: 60,
  });
  socket.onmessage = (e) => socket.send(`echo: ${e.data}`);
  socket.onclose = () => {/* release per-connection state */};
  return response;
}
```

Authorize **before** upgrading — read the session with `auth()` / `getSession()`
and answer `401` on a plain `Response`; after the `101` there is no status to
send. What denext does not give you on a raw socket: authorization that
re-checks over time, per-connection limits, back-pressure, fan-out across
instances. Those are what Live channels are.

## CORS preflight by hand

`OPTIONS` is a routable method, so a preflight is a handler like any other.
There is no `cors()` helper yet (it is on the
[roadmap](https://github.com/Brainwires/denext/blob/main/ROADMAP.md)); this is
the whole thing for one allowed origin:

```ts
// app/api/public/route.ts
const ALLOWED = new Set(["https://app.example.com"]);

function corsHeaders(origin: string | null): HeadersInit {
  if (!origin || !ALLOWED.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "vary": "Origin",
  };
}

export function OPTIONS(request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(request.headers.get("origin")),
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-max-age": "86400",
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  return Response.json({ ok: true }, {
    headers: corsHeaders(request.headers.get("origin")),
  });
}
```

Never echo `*` with `allow-credentials`, and never reflect an unlisted origin.
Middleware can answer the preflight for a whole prefix instead — `middleware.ts`
runs before routing and may return a `Response` — but a per-route `OPTIONS`
keeps the policy next to the data it protects.

## When to use Live channels instead

Reach for a raw stream or socket when the _client_ is not a denext page: a CLI,
a mobile app, a third party, a browser `EventSource` you do not control. When
the consumer is your own `"use client"` component,
[`createChannel`](/docs/typed-api#server-push--createchannel)

- `useChannel` gives you what the recipes above leave to you — a required
  `authorize` that re-runs on a TTL, per-connection caps, latest-wins
  back-pressure, one socket per page shared by every subscription, and
  cross-instance fan-out through a `ChannelTransport` — and
  [`defineSubscription`](/docs/typed-api#typed-live-queries--usesubscription)
  re-pushes a validated query when its tags are invalidated. See
  [Live components](/docs/live).

See also: [Typed API](/docs/typed-api) for validated handlers and the typed
client, [File uploads](/docs/uploads) for multipart bodies and the caps, and the
[production checklist](/docs/production-checklist) for the deadline and body-cap
keys.
