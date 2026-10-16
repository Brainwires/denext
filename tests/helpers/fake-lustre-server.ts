// A stand-in for Lustre's JavaScript server-component runtime, shaped like the real one where
// denext touches it: the `Runtime` constructor's `(_, init, update, view, config, flags)`
// signature, a registered callback that gets `mount` at once and a `reconcile` after each update,
// an empty patch when nothing changed, `ClientMessage`s turned into JSON, client messages decoded
// (or refused) by a decoder, and a shutdown that nulls the state so a later message throws (as
// Lustre 5.7.1's does). The counter app's view is its count; an `EventFired` named `click` adds
// one, `boom` throws in `update`, `undecodable` fails the decoder.

import { h } from "../../src/jsx/jsx-runtime.ts";
import type { VNode } from "../../src/jsx/types.ts";
import type { LustreApp } from "../../src/lustre/kit.ts";
import type { LustreServerModules } from "../../src/lustre/server-kit.ts";
import type { LustreViewIslandProps } from "../../src/lustre/view-island.ts";

type Msg =
  | { t: "register" | "deregister"; cb: (m: unknown) => void }
  | { t: "client"; data: { name: string; event: unknown } }
  | { t: "dispatch"; msg: unknown }
  | { t: "shutdown" };

const ok = <T>(value: T) => Object.assign([value], { isOk: () => true });
const err = <T>(value: T) => Object.assign([value], { isOk: () => false });

/** Every runtime the fake built, and the ones still running. */
export const fakeRuntimes = {
  /** The arguments each `new Runtime(…)` got. */
  constructed: [] as unknown[][],
  /** Runtimes not shut down. */
  live: new Set<FakeRuntime>(),
  /** Called on every shutdown (tests await a park timeout through it). */
  onShutdown: null as (() => void) | null,
};

class FakeRuntime {
  #model: unknown;
  #update: LustreApp["update"] | null;
  #view: LustreApp["view"] | null;
  #callbacks = new Set<(m: unknown) => void>();

  constructor(
    _: undefined,
    init: LustreApp["init"],
    update: LustreApp["update"],
    view: LustreApp["view"],
    _config: unknown,
    flags: unknown,
  ) {
    fakeRuntimes.constructed.push([_, init, update, view, _config, flags]);
    const [model] = init(flags);
    this.#model = model;
    this.#update = update;
    this.#view = view;
    fakeRuntimes.live.add(this);
  }

  /** How many clients are attached. */
  get callbacks(): number {
    return this.#callbacks.size;
  }

  send(message: Msg): void {
    switch (message.t) {
      case "register":
        this.#callbacks.add(message.cb);
        message.cb({ t: "mount", vdom: this.#view!(this.#model) });
        return;
      case "deregister":
        this.#callbacks.delete(message.cb);
        return;
      case "client":
        return this.#apply(message.data);
      case "dispatch":
        return this.#apply(message.msg);
      case "shutdown":
        this.#update = null; // as Lustre: nulled, so a later message throws
        this.#view = null;
        this.#callbacks.clear();
        fakeRuntimes.live.delete(this);
        fakeRuntimes.onShutdown?.();
        return;
    }
  }

  #apply(msg: unknown): void {
    const before = this.#view!(this.#model);
    const [model] = this.#update!(this.#model, msg);
    this.#model = model;
    const after = this.#view!(this.#model);
    for (const cb of this.#callbacks) {
      cb({ t: "reconcile", patch: before === after ? {} : { text: after } });
    }
  }
}

/** The counter app: flags are the start, `click` adds one, `boom` throws. */
export const counterApp: LustreApp<number> = {
  init: (start: number) => [start, null],
  update: (model: number, msg: { name?: string }) => {
    if (msg?.name === "boom") throw new Error("update blew up");
    return [msg?.name === "click" ? model + 1 : model, null];
  },
  view: (model: number) => String(model),
  config: { attributes: [] },
};

/** The island the fake kit renders (a plain component; the real one is a client reference). */
function FakeIsland(props: LustreViewIslandProps): VNode {
  return h("lustre-view", { "data-view": props.view, "data-token": props.token }, props.html);
}

/** Fake Lustre server-component modules for `lustreServerKit`. */
export function fakeLustreServerModules(): LustreServerModules {
  return {
    version: "5.7.1",
    Runtime: FakeRuntime as unknown as LustreServerModules["Runtime"],
    configure_server_component: (config) => ({ configured: config }),
    register_callback: (cb) => ({ t: "register", cb }),
    deregister_callback: (cb) => ({ t: "deregister", cb }),
    client_message_to_json: (m) => {
      const msg = m as { t: string; vdom?: unknown; patch?: unknown };
      return msg.t === "mount" ? { kind: 0, vdom: msg.vdom } : { kind: 1, patch: msg.patch };
    },
    runtime_message_decoder: () => "decoder",
    run: (json) => {
      const m = json as { kind?: unknown; name?: unknown; event?: unknown } | null;
      return m?.kind === 1 && typeof m.name === "string" && m.name !== "undecodable"
        ? ok({ t: "client", data: { name: m.name, event: m.event } })
        : err([]);
    },
    shutdown: () => ({ t: "shutdown" }),
    to_string: (element) => `<p>${element}</p>`,
    island: FakeIsland,
  };
}
