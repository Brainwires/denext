// A background consumer of the dev server's live-reload SSE channel (`/_denext/reload`), for the
// in-process HMR tests: it collects each `data:` frame so a test can wait for the one an edit
// pushes (`update:[…]` / `refresh` / `css` / `reload`).

/** A background SSE consumer: pumps `data:` payloads into `events`. */
export class SseTap {
  events: string[] = [];
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #done = false;
  constructor(body: ReadableStream<Uint8Array>) {
    this.#reader = body.getReader();
    void this.#pump();
  }
  async #pump(): Promise<void> {
    const dec = new TextDecoder();
    try {
      while (!this.#done) {
        const { value, done } = await this.#reader.read();
        if (done) break;
        for (const line of dec.decode(value).split("\n")) {
          const t = line.trim();
          if (t.startsWith("data:")) this.events.push(t.slice(5).trim());
        }
      }
    } catch { /* cancelled on close */ }
  }
  /** Wait until an event matching `pred` arrives (returns it), or null on timeout. */
  async waitFor(pred: (e: string) => boolean, timeoutMs = 10_000): Promise<string | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 40));
    }
    return null;
  }
  async close(): Promise<void> {
    this.#done = true;
    await this.#reader.cancel().catch(() => {});
  }
}
