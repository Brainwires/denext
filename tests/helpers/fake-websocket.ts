// fallow-ignore-file unused-class-member -- the client under test reaches these through the stubbed global WebSocket.
// A controllable stand-in for the browser WebSocket the Live transport opens (no real
// connection): the test opens, drops and feeds it, and reads what the client sent. Install it
// with `vi.stubGlobal("WebSocket", FakeWebSocket)` (Vitest files) and reset `FakeWebSocket.all`
// before each test.

/** A fake WebSocket recording every instance and every frame sent. */
export class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  /** Every socket the transport opened, oldest first. */
  static all: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  /** The connection opens. */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  /** The connection drops from the network side. */
  drop() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  /** The server sends `frame`. */
  server(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /** The frames this socket sent, parsed. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }
  /** The `type`s of the frames this socket sent. */
  types(): string[] {
    return this.sent.map((s) => (JSON.parse(s) as { type: string }).type);
  }
}
