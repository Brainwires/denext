// A tiny fake DOM for the desktop sign-in cancel overlay (src/desktop/auth-cancel-overlay.ts): just
// the element calls it makes, a `document.body`, `getElementById`, and helpers to click and press
// keys. Install it as `globalThis.document` with `installFakeDocument()`.

/** A fake element. */
class FakeElement {
  id = "";
  textContent: string | null = null;
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  focused = false;
  private readonly listeners = new Map<string, Array<(e: unknown) => void>>();

  constructor(readonly tagName: string, private readonly doc: FakeDocument) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  remove(): void {
    if (!this.parent) return;
    const list = this.parent.children;
    list.splice(list.indexOf(this), 1);
    this.parent = null;
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  dispatch(type: string, event: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  focus(): void {
    this.focused = true;
  }
  /** Every descendant, depth first. */
  all(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  get connected(): boolean {
    return this.parent === null ? this === this.doc.body : this.parent.connected;
  }
}

/** A fake document with a body. */
class FakeDocument {
  readonly body: FakeElement = new FakeElement("body", this);
  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
  getElementById(id: string): FakeElement | null {
    return this.body.all().find((e) => e.id === id) ?? null;
  }
  /** The overlay's button, if it is shown. */
  button(): FakeElement | undefined {
    return this.body.all().find((e) => e.tagName === "button");
  }
}

/** Install a fresh fake `document`; returns it and a restore function. */
export function installFakeDocument(): { doc: FakeDocument; restore(): void } {
  const g = globalThis as { document?: unknown };
  const had = Object.prototype.hasOwnProperty.call(g, "document");
  const prev = g.document;
  const doc = new FakeDocument();
  g.document = doc;
  return {
    doc,
    restore: () => {
      if (had) g.document = prev;
      else delete g.document;
    },
  };
}
