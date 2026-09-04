// Server-Sent Events plumbing shared by the dev servers' live-reload channels (App Router
// + SPA): one subscriber set, `data:` frames fanned out to every open page.

const encoder = new TextEncoder();

/** A live-reload subscriber set (one controller per open page). */
export type SseClients = Set<ReadableStreamDefaultController<Uint8Array>>;

/** Send one SSE `data:` frame to every subscriber, dropping closed streams. */
export function sseSend(clients: SseClients, data: string): void {
  for (const controller of clients) {
    try {
      controller.enqueue(encoder.encode(`data: ${data}\n\n`));
    } catch {
      clients.delete(controller);
    }
  }
}

/** The SSE response for a new subscriber (registered until the client disconnects). */
export function sseStream(clients: SseClients): Response {
  let ref: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      ref = controller;
      clients.add(controller);
      controller.enqueue(encoder.encode("retry: 1000\n\n"));
    },
    cancel(): void {
      if (ref) clients.delete(ref);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
