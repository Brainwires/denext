// The server half of the Lustre kit: what `defineLustreView` runs a Lustre server component with.
// The Gleam build writes `.denext/lustre-server.ts`, which imports these functions from the app's
// own Lustre build and passes them to {@link lustreServerKit}.
//
// It runs Lustre's JavaScript server-component `Runtime` directly. `lustre.start_server_component`
// can't be used: in Lustre 5.7.1 it calls `new Runtime(init, update, view, config, flags)` against a
// constructor declared `(_, init, update, view, config, flags)`, so every argument lands one slot
// off and the first update throws. The runtime is subclassed so that a message that arrives after
// the view stopped (a timer an effect armed, say) is dropped instead of throwing into the event
// loop, and an error inside Lustre's `update` / `view` reaches the caller instead of the process.

import type { GleamResult, LustreApp } from "./kit.ts";
import type { LustreViewIslandProps } from "./view-island.ts";
import type { VNode } from "../jsx/types.ts";

/** A Lustre server `Runtime` as its constructor builds it (only `send` is used). */
export interface LustreRuntimeInstance {
  /** Hand the runtime a message (`lustre.send`). */
  send(message: unknown): void;
}

/** The functions {@link lustreServerKit} takes, imported from the app's Lustre build. */
export interface LustreServerModules {
  /** The Lustre version they came from. */
  version: string;
  /** `lustre/runtime/server/runtime.ffi.mjs`'s `Runtime`. */
  // deno-lint-ignore no-explicit-any
  Runtime: new (...args: any[]) => LustreRuntimeInstance;
  /** `lustre/runtime/app.configure_server_component`. */
  configure_server_component(config: unknown): unknown;
  /** `lustre/server_component.register_callback`. */
  // deno-lint-ignore no-explicit-any
  register_callback(callback: (message: any) => undefined): unknown;
  /** `lustre/server_component.deregister_callback`. */
  // deno-lint-ignore no-explicit-any
  deregister_callback(callback: (message: any) => undefined): unknown;
  /** `lustre/server_component.client_message_to_json`. */
  client_message_to_json(message: unknown): unknown;
  /** `lustre/server_component.runtime_message_decoder`. */
  runtime_message_decoder(): unknown;
  /** `gleam/dynamic/decode.run`. */
  run(data: unknown, decoder: unknown): GleamResult;
  /** `lustre.shutdown`. */
  shutdown(): unknown;
  /** `lustre/element.to_string`. */
  // deno-lint-ignore no-explicit-any
  to_string(element: any): string;
  /** The browser island (`.denext/lustre-view.ts`'s `LustreView`), a client reference. */
  island: (props: LustreViewIslandProps) => VNode;
}

/** A running Lustre server component. */
export type LustreServerRuntime = { readonly __lustreServerRuntime: true };

/** What `defineLustreView` and the Live hub call: the app's Lustre server runtime, wrapped. */
export interface LustreServerKit {
  /** The Lustre version. */
  readonly version: string;
  /** The browser island the page renders for a view. */
  readonly island: (props: LustreViewIslandProps) => VNode;
  /** The HTML of `app`'s first view for `flags`. */
  render<F>(app: LustreApp<F>, flags: F): string;
  /**
   * Start `app` with `flags`. `init` runs now (a throw propagates); errors from later updates go
   * to `onError`.
   */
  start<F>(app: LustreApp<F>, flags: F, onError: (err: unknown) => void): LustreServerRuntime;
  /**
   * Receive the runtime's messages for a client (each one Lustre's `ClientMessage` as JSON): the
   * first is `mount`, with the whole current view. Returns the function that stops them.
   */
  connect(runtime: LustreServerRuntime, onMessage: (json: unknown) => void): () => void;
  /**
   * Hand the runtime a message from the client (Lustre's `ServerMessage` as JSON), decoded by
   * Lustre's own decoder. `false` when it does not decode (nothing is sent).
   */
  receive(runtime: LustreServerRuntime, json: unknown): boolean;
  /** Stop the runtime; anything sent to it afterwards is dropped. */
  stop(runtime: LustreServerRuntime): void;
}

/**
 * Wrap the app's Lustre server-component functions for `defineLustreView`. The generated
 * `.denext/lustre-server.ts` calls this.
 *
 * @param modules The functions, imported from the app's `@gleam/lustre/…` build.
 * @returns The kit `defineLustreView` takes.
 */
export function lustreServerKit(modules: LustreServerModules): LustreServerKit {
  const stopped = new WeakSet<object>();
  const onErrors = new WeakMap<object, (err: unknown) => void>();
  class GuardedRuntime extends modules.Runtime {
    override send(message: unknown): void {
      if (stopped.has(this)) return;
      try {
        super.send(message);
      } catch (err) {
        (onErrors.get(this) ?? console.error)(err);
      }
    }
  }
  const asRuntime = (r: LustreServerRuntime) => r as unknown as LustreRuntimeInstance;
  return {
    version: modules.version,
    island: modules.island,
    render: (app, flags) => modules.to_string(app.view(app.init(flags)[0])),
    start(app, flags, onError) {
      const config = modules.configure_server_component(app.config);
      const runtime = new GuardedRuntime(undefined, app.init, app.update, app.view, config, flags);
      onErrors.set(runtime, onError);
      return runtime as unknown as LustreServerRuntime;
    },
    connect(runtime, onMessage) {
      const callback = (message: unknown): undefined => {
        onMessage(modules.client_message_to_json(message));
      };
      asRuntime(runtime).send(modules.register_callback(callback));
      return () => asRuntime(runtime).send(modules.deregister_callback(callback));
    },
    receive(runtime, json) {
      const decoded = modules.run(json, modules.runtime_message_decoder());
      if (!decoded.isOk()) return false;
      asRuntime(runtime).send((decoded as unknown as [unknown])[0]);
      return true;
    },
    stop(runtime) {
      try {
        asRuntime(runtime).send(modules.shutdown());
      } finally {
        stopped.add(runtime);
      }
    },
  };
}
