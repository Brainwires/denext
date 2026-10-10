// The deferred Flight boot (src/build/flight-boot.ts): run its generated source against a
// minimal fake document and check when it imports flight.js and what it hands the runtime.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { generateFlightBoot } from "../src/build/flight-boot.ts";

/** A fake element: attributes, a parent, and the `closest` / `getAttribute` the boot uses. */
class El {
  parent: El | null = null;
  children: El[] = [];
  constructor(public attrs: Record<string, string> = {}, public display = "block") {}
  add(child: El): El {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name] : null;
  }
  get firstElementChild(): El | null {
    return this.children[0] ?? null;
  }
  /** `[a]`, `[a="v"]` and `[a][b="v"]` selectors, comma-separated. */
  matches(selector: string): boolean {
    return selector.split(",").some((one) =>
      [...one.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].every(([, name, value]) =>
        value === undefined ? name in this.attrs : this.attrs[name] === value
      )
    );
  }
  closest(selector: string): El | null {
    return this.matches(selector) ? this : this.parent?.closest(selector) ?? null;
  }
  all(): El[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
}

interface Event {
  type: string;
  target: El;
}

/** Run the boot against `root`'s subtree; returns probes into what it did. */
function runBoot(root: El, opts: { mediaMatches?: boolean } = {}) {
  const listeners = new Map<string, (e: Event) => void>();
  const idle: Array<() => void> = [];
  const observers: Array<
    { target?: El; cb: (es: { isIntersecting: boolean }[]) => void; off: boolean }
  > = [];
  const mediaChange: Array<() => void> = [];
  const media = { matches: !!opts.mediaMatches };
  const loads: number[] = [];
  const resumed: Array<[El, string]> = [];
  let resolveLoad!: (resume: (target: El, type: string) => void) => void;
  const loaded = new Promise<(target: El, type: string) => void>((r) => (resolveLoad = r));
  const document = {
    querySelectorAll: (sel: string) => root.all().filter((el) => el.matches(sel)),
    addEventListener: (type: string, fn: (e: Event) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  class IntersectionObserver {
    rec: (typeof observers)[number];
    constructor(cb: (es: { isIntersecting: boolean }[]) => void) {
      this.rec = { cb, off: false };
      observers.push(this.rec);
    }
    observe(el: El) {
      this.rec.target = el;
    }
    disconnect() {
      this.rec.off = true;
    }
  }
  const matchMedia = () => ({
    get matches() {
      return media.matches;
    },
    addEventListener: (_: string, fn: () => void) => mediaChange.push(fn),
    removeEventListener: () => mediaChange.length = 0,
  });
  const self = {
    requestIdleCallback: (fn: () => void) => idle.push(fn),
    IntersectionObserver,
    matchMedia,
  };
  const source = generateFlightBoot().replace(`import("./flight.js")`, "__load()");
  const load = () => {
    loads.push(1);
    return { then: (f: (m: unknown) => unknown) => loaded.then(() => f({ ready: loaded })) };
  };
  new Function(
    "document",
    "self",
    "IntersectionObserver",
    "matchMedia",
    "getComputedStyle",
    "__load",
    source,
  )(document, self, IntersectionObserver, matchMedia, (el: El) => ({ display: el.display }), load);
  return {
    listeners,
    idle,
    observers,
    media,
    mediaChange,
    loads,
    resumed,
    /** Resolve the import with a runtime whose resumeEvent records what it was handed. */
    async finishLoad() {
      resolveLoad((target, type) => resumed.push([target, type]));
      await loaded;
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
    fire(type: string, target: El) {
      listeners.get(type)?.({ type, target });
    },
  };
}

/** A page body with one island of `strategy` holding a stamped button, plus static text. */
function page(strategy: string, extra?: (body: El) => void) {
  const body = new El();
  const text = body.add(new El());
  const wrapper = body.add(
    new El({ "data-dnx-island": "", "data-dnx-strategy": strategy }, "contents"),
  );
  const button = wrapper.add(new El({ "data-dnx-h": "click" }));
  extra?.(body);
  return { body, text, wrapper, button };
}

Deno.test("flight boot: the source has no static import and loads flight.js relative to itself", () => {
  const source = generateFlightBoot();
  assert(!/^\s*import\s/m.test(source), source);
  assertStringIncludes(source, `import("./flight.js")`);
  assert(!source.includes("//"), "comments are stripped");
  assert(source.length < 3_000, `${source.length} B`);
});

Deno.test("flight boot: an interaction island waits for the first interaction, then replays it", async () => {
  const { body, text, button } = page("interaction");
  const boot = runBoot(body);
  assertEquals(boot.loads.length, 0, "nothing loads up front");
  boot.fire("click", text); // outside every island: not a trigger
  assertEquals(boot.loads.length, 0);
  boot.fire("pointerdown", button);
  assertEquals(boot.loads.length, 1, "the first interaction inside the island loads it");
  boot.fire("focusin", button); // the rest of the gesture arrives while it loads
  boot.fire("click", button);
  await boot.finishLoad();
  assertEquals(boot.resumed, [[button, "pointerdown"], [button, "focusin"], [button, "click"]]);
  assertEquals(boot.listeners.size, 0, "the boot's listeners are removed once handed over");
});

Deno.test("flight boot: idle, visible and media islands load the runtime when they fire", async () => {
  const idle = runBoot(page("idle").body);
  assertEquals(idle.loads.length, 0);
  idle.idle.forEach((f) => f());
  assertEquals(idle.loads.length, 1);

  const { body, wrapper } = page("visible");
  const visible = runBoot(body);
  assertEquals(visible.observers.length, 1);
  // The display:contents wrapper has no box: the observer watches its first boxed child.
  assertEquals(visible.observers[0].target, wrapper.firstElementChild);
  assertEquals(visible.loads.length, 0);
  visible.observers[0].cb([{ isIntersecting: true }]);
  assertEquals(visible.loads.length, 1);
  await visible.finishLoad();
  assert(visible.observers[0].off, "the observer is disconnected once loaded");

  const waiting = runBoot(page("media").body);
  assertEquals(waiting.loads.length, 0);
  waiting.media.matches = true;
  waiting.mediaChange.forEach((f) => f());
  assertEquals(waiting.loads.length, 1);
  assertEquals(runBoot(page("media").body, { mediaMatches: true }).loads.length, 1);
});

Deno.test("flight boot: a page that needs the runtime now loads it at once", () => {
  // A handler host outside every island (a resumable <Link>'s soft navigation).
  const link = page("interaction", (body) => body.add(new El({ "data-dnx-h": "click" })));
  assertEquals(runBoot(link.body).loads.length, 1);
  // An island that does not wait.
  assertEquals(runBoot(page("load").body).loads.length, 1);
  assertEquals(runBoot(page("only").body).loads.length, 1);
});
