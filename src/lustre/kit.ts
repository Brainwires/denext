// The Lustre kit: the handful of Lustre functions denext/gleam calls, taken from the app's OWN
// Lustre build. denext never imports Lustre itself (it is a Hex package the app compiles; a
// framework module can't name the app's `@gleam/` import map entry, and a second copy of Lustre
// would not recognise the app's values). The Gleam build step writes `.denext/lustre.ts`, which
// imports these functions from `@gleam/lustre/…` and passes them to {@link lustreKit}; app code
// imports the kit from there. Everything here is structural: Gleam's `.d.mts` types flow in from
// the app's `App` value, never from denext.

/** A Gleam `Result` as Gleam's JavaScript output builds it (`Ok` / `Error`, the value at `[0]`). */
export interface GleamResult {
  /** `true` for `Ok`. */
  isOk(): boolean;
}

/**
 * A Lustre application (`lustre.App(flags, model, msg)`), as Gleam's `.d.mts` declares it.
 * `Flags` is inferred from it: `counter.app()` typed `App$<number, Model$, Msg$>` makes the flags
 * a `number`.
 */
export interface LustreApp<Flags = unknown> {
  /** Lustre's `init`, wrapped by `lustre.simple` / `application` / `component`. */
  // deno-lint-ignore no-explicit-any
  init: (flags: Flags) => [any, unknown];
  /** Lustre's `update`. */
  // deno-lint-ignore no-explicit-any
  update: (model: any, msg: any) => [any, unknown];
  /** Lustre's `view`. */
  // deno-lint-ignore no-explicit-any
  view: (model: any) => unknown;
  /** The app's configuration (Lustre-internal). */
  config: unknown;
}

/** The functions {@link lustreKit} takes, imported from the app's Lustre build. */
export interface LustreModules {
  /** The Lustre version they came from (`build/packages/lustre/gleam.toml`). */
  version: string;
  /** `lustre.start`: mount an app in the browser (the FFI also takes an element). */
  // deno-lint-ignore no-explicit-any
  start(app: any, selector: any, flags: any): GleamResult;
  /** `lustre.register`: define an app as a custom element. */
  // deno-lint-ignore no-explicit-any
  register(app: any, name: string): GleamResult;
  /** `lustre.send`. */
  // deno-lint-ignore no-explicit-any
  send(runtime: any, message: any): unknown;
  /** `lustre.shutdown`. */
  shutdown(): unknown;
  /** `lustre.is_browser`. */
  is_browser(): boolean;
  /** `lustre/element.to_string`. */
  // deno-lint-ignore no-explicit-any
  to_string(element: any): string;
  /** `lustre/component.prerender`. */
  // deno-lint-ignore no-explicit-any
  prerender(app: any, tag: string, attributes: any, children: any): unknown;
  /** `lustre/attribute.attribute`. */
  attribute(name: string, value: string): unknown;
  /** The Gleam prelude's `toList` (a JavaScript array to a Gleam `List`). */
  toList(items: unknown[]): unknown;
}

/** A running client-side Lustre app (Lustre's `Runtime`). */
export type LustreRuntime = { readonly __lustreRuntime: true };

/** What denext/gleam's Lustre helpers call: the app's Lustre build, wrapped. */
export interface LustreKit {
  /** The Lustre version. */
  readonly version: string;
  /** The HTML of `app`'s first view for `flags` (`element.to_string(view(init(flags)))`). */
  render<F>(app: LustreApp<F>, flags: F): string;
  /**
   * Start `app` on `root`, adopting the markup already in it (Lustre virtualises existing DOM).
   * `null` when Lustre refused (not a browser, …), with the reason logged.
   */
  start<F>(app: LustreApp<F>, root: Element, flags: F): LustreRuntime | null;
  /**
   * Ask a running app to stop. A no-op for client apps up to Lustre 5.7.1 (its SPA runtime leaves
   * `SystemRequestedShutdown` as a TODO): callers clear the root themselves.
   */
  stop(runtime: LustreRuntime): void;
  /** Is this a browser (Lustre's `is_browser`: a `document` exists)? */
  isBrowser(): boolean;
  /** Define `app` as the custom element `tag`, once (later calls are no-ops). */
  register(app: LustreApp<undefined>, tag: string): boolean;
  /**
   * The custom element `tag`'s shadow root, prerendered by `component.prerender` with the
   * attributes applied through the component's attribute decoders: the Declarative Shadow DOM
   * template's mode and contents. `null` when Lustre's output is not the shape this expects.
   */
  prerender(
    app: LustreApp<undefined>,
    tag: string,
    attributes: Record<string, string>,
  ): PrerenderedShadow | null;
}

/** A custom element's prerendered shadow root (a `<template shadowrootmode>`). */
export interface PrerenderedShadow {
  /** `open` or `closed` (the component's `open_shadow_root`). */
  mode: "open" | "closed";
  /** Whether the shadow root delegates focus. */
  delegatesFocus: boolean;
  /** The shadow root's HTML. */
  html: string;
}

/**
 * The shadow root inside `component.prerender`'s HTML for an element with no light children:
 * `<tag …><template shadowrootmode="…"[ shadowrootdelegatesfocus]>…</template></tag>`.
 *
 * @param html What `element.to_string` gave.
 * @param tag The element's tag.
 * @returns The template's mode and contents, or `null` when the HTML has another shape.
 */
export function shadowFromPrerender(html: string, tag: string): PrerenderedShadow | null {
  const open = /^<[^>]*><template shadowrootmode="(open|closed)"( shadowrootdelegatesfocus)?>/
    .exec(html);
  const close = `</template></${tag}>`;
  if (!open || !html.startsWith(`<${tag}`) || !html.endsWith(close)) return null;
  return {
    mode: open[1] as "open" | "closed",
    delegatesFocus: open[2] !== undefined,
    html: html.slice(open[0].length, html.length - close.length),
  };
}

/**
 * Wrap the app's Lustre functions for denext/gleam. The generated `.denext/lustre.ts` calls this;
 * app code imports the kit from there.
 *
 * @param modules The functions, imported from the app's `@gleam/lustre/…` build.
 * @returns The kit `lustreIsland` / `lustreElement` take.
 */
export function lustreKit(modules: LustreModules): LustreKit {
  const registered = new Set<string>();
  return {
    version: modules.version,
    render: (app, flags) => modules.to_string(app.view(app.init(flags)[0])),
    start(app, root, flags) {
      const result = modules.start(app, root, flags);
      if (result.isOk()) return (result as unknown as [LustreRuntime])[0];
      console.warn("denext lustre: the app did not start:", (result as unknown as [unknown])[0]);
      return null;
    },
    stop: (runtime) => void modules.send(runtime, modules.shutdown()),
    isBrowser: () => modules.is_browser(),
    register(app, tag) {
      if (registered.has(tag) || globalThis.customElements?.get(tag)) return true;
      const result = modules.register(app, tag);
      if (result.isOk()) registered.add(tag);
      else console.warn(`denext lustre: <${tag}> was not registered:`, (result as never)[0]);
      return result.isOk();
    },
    prerender(app, tag, attributes) {
      const attrs = Object.entries(attributes).map(([k, v]) => modules.attribute(k, v));
      const element = modules.prerender(app, tag, modules.toList(attrs), modules.toList([]));
      return shadowFromPrerender(modules.to_string(element), tag);
    },
  };
}
