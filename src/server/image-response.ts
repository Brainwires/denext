// `next/og`-style ImageResponse: render JSX to a PNG. Built on `@denext/og`
// (satori for flexbox layout → SVG, resvg for rasterization), denext's own
// first-party JSR codec, which bundles a default font and inlines its wasm, so no
// setup is required.
//
//   export default function Image() {
//     return new ImageResponse(
//       <div style={{ display: "flex", width: "100%", height: "100%",
//                     alignItems: "center", justifyContent: "center",
//                     background: "#0b1020", color: "white", fontSize: 64 }}>
//         Hello denext
//       </div>,
//       { width: 1200, height: 630 },
//     );
//   }
//
// Layout is satori's subset (flexbox + inline `style`; Tailwind via the `tw` prop; no
// arbitrary `className`/CSS). Components may be async Server Components. Fonts default to
// bundled Latin, with non-Latin fetched at render time unless you pass `fonts` or set
// `offline: true`. The returned Response flows through the `opengraph-image` convention.

// @denext/og is imported LAZILY (in the streamed body below), not at module top
// level: a static import pulls its wasm (satori/resvg) into the esbuild browser
// prebuild of the next-compat runtime, which can't load it and would break aliasing
// `next/og`/`next/headers` (both reach server/mod.ts, which re-exports this module).
// The specifier is kept EXTERNAL in that prebuild (see src/build/next-compat.ts) and
// resolves at SSR runtime; on the client it is never reached.
import { FRAGMENT, type VNode, type VNodeChild } from "../jsx/types.ts";
import { invokeComponent, isComponentType, resolveComponentType } from "../runtime/react-brands.ts";

// The subset of `@denext/og` denext calls. Typed here so the lazy runtime import
// doesn't need the package on the static graph for `deno check`.
interface OgModule {
  ImageResponse: new (
    element: unknown,
    options: Record<string, unknown>,
  ) => { arrayBuffer(): Promise<ArrayBuffer> };
}

/** Options for {@linkcode ImageResponse} (dimensions + `@denext/og` passthrough). */
export interface ImageResponseOptions {
  /** Output width in pixels (default 1200). */
  width?: number;
  /** Output height in pixels (default 630). */
  height?: number;
  /**
   * No-egress mode: never fetch a missing font/emoji from the network. A glyph not
   * covered by a bundled or `fonts`-provided face raises a clear error instead of
   * fetching from Google Fonts / jsdelivr — so OG rendering stays fully offline and
   * leaks nothing. (Overridden if you pass your own `loadAdditionalAsset`.)
   */
  offline?: boolean;
  /** Extra options forwarded to `@denext/og` (`fonts`, `emoji`, `headers`, `tw`, …). */
  [key: string]: unknown;
}

// A satori element: a host tag with `props.style`/`props.children`, or text.
type SatoriNode = { type: string; props: Record<string, unknown> } | string | SatoriNode[] | null;

function isVNode(value: unknown): value is VNode {
  return typeof value === "object" && value !== null && "type" in value && "props" in value;
}

/**
 * Convert a denext VNode tree into the plain element shape satori consumes. Async:
 * components may be `async` Server Components (their result and children are awaited), so
 * an OG route can fetch its data inline. `style`, and satori's `tw`/`lang`, pass straight
 * through (`...rest`) — so Tailwind utility classes via `tw` work out of the box.
 */
async function toSatori(node: VNodeChild): Promise<SatoriNode> {
  if (node == null || typeof node === "boolean") return null;
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return Promise.all(node.map(toSatori));
  if (!isVNode(node)) return null;

  const { type, props } = node;
  if (isComponentType(type)) {
    const rendered = await invokeComponent(resolveComponentType(type), props);
    return toSatori(rendered as VNodeChild);
  }
  if (type === FRAGMENT) return toSatori(props.children as VNodeChild);
  const { children, key: _key, ...rest } = props as Record<string, unknown>;
  return {
    type: type as string,
    props: { ...rest, children: await toSatori(children as VNodeChild) },
  };
}

/**
 * Offline `loadAdditionalAsset`: satori calls this only for a glyph/emoji segment no
 * provided font covers. Throwing here blocks the vendored renderer's default network
 * fetch (Google Fonts / jsdelivr) and surfaces a clear, actionable error instead.
 */
function offlineAssetLoader(_languageCode: string, segment: string): never {
  throw new Error(
    `denext ImageResponse: offline mode is on, but no provided font covers ${
      JSON.stringify(segment)
    }. Pass the needed face via the \`fonts\` option (e.g. \`new CustomFont(...)\`) instead ` +
      `of fetching it from the network.`,
  );
}

/**
 * Render JSX (or a satori element object) to a PNG {@linkcode Response}.
 *
 * @param element The JSX to render (host elements + inline `style` only).
 * @param options Output dimensions and `@denext/og` options.
 */
export function ImageResponse(
  element: VNode | object,
  options: ImageResponseOptions = {},
): Response {
  const { width = 1200, height = 630, headers: extraHeaders, offline, ...rest } = options as
    & ImageResponseOptions
    & { headers?: HeadersInit; offline?: boolean };
  // Defer the wasm PNG render to when the body is read: import @denext/og inside
  // the stream so the module never loads wasm at import time (see the note above).
  // toSatori is awaited HERE (not eagerly) so async Server Components in the tree resolve.
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const el = isVNode(element) ? await toSatori(element) : element;
        const renderOpts: Record<string, unknown> = { width, height, ...rest };
        // Offline: block the vendored renderer's network font/emoji fallback (unless the
        // caller already supplied their own asset loader). satori only invokes this for a
        // segment no provided font covers, so a fully-covered tree renders unaffected.
        if (offline && typeof renderOpts.loadAdditionalAsset !== "function") {
          renderOpts.loadAdditionalAsset = offlineAssetLoader;
        }
        // @denext/og is denext's own first-party codec, so it is always resolvable —
        // no peer-codec guard needed (mirrors the @denext/photon/@denext/avif loads).
        const { ImageResponse: OgImageResponse } = await import(
          "@denext/og"
        ) as unknown as OgModule;
        const res = new OgImageResponse(el, renderOpts);
        controller.enqueue(new Uint8Array(await res.arrayBuffer()));
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
  const headers = new Headers(extraHeaders);
  if (!headers.has("content-type")) headers.set("content-type", "image/png");
  return new Response(body, { headers });
}
