// `next/og`-style ImageResponse: render JSX to a PNG. Built on `@cf-wasm/og`
// (satori for flexbox layout → SVG, resvg for rasterization), which bundles a
// default font and inlines its wasm, so no setup is required.
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
// Only satori's layout subset is supported (flexbox + inline `style`; no
// `className`/CSS). Components must be synchronous. The returned Response flows
// through the `opengraph-image` convention unchanged.

// @cf-wasm/og is imported LAZILY (in the streamed body below), not at module top
// level: a static import pulls its .wasm (satori/resvg) into the esbuild browser
// prebuild of the next-compat runtime, which can't load .wasm and would break
// aliasing `next/og`/`next/headers` (both reach server/mod.ts, which re-exports
// this module).
import { FRAGMENT, type VNode, type VNodeChild } from "../jsx/types.ts";
import { invokeComponent, isComponentType, resolveComponentType } from "../runtime/react-brands.ts";
import { loadPeerCodec } from "./peer-codec.ts";

// The subset of `@cf-wasm/og` denext calls (an optional peer codec — see
// peer-codec.ts). Typed here so removing it from the import map doesn't break
// `deno check`.
interface OgModule {
  ImageResponse: new (
    element: unknown,
    options: Record<string, unknown>,
  ) => { arrayBuffer(): Promise<ArrayBuffer> };
}

/** Options for {@linkcode ImageResponse} (dimensions + `@cf-wasm/og` passthrough). */
export interface ImageResponseOptions {
  /** Output width in pixels (default 1200). */
  width?: number;
  /** Output height in pixels (default 630). */
  height?: number;
  /** Extra options forwarded to `@cf-wasm/og` (fonts, emoji, headers, …). */
  [key: string]: unknown;
}

// A satori element: a host tag with `props.style`/`props.children`, or text.
type SatoriNode = { type: string; props: Record<string, unknown> } | string | SatoriNode[] | null;

function isVNode(value: unknown): value is VNode {
  return typeof value === "object" && value !== null && "type" in value && "props" in value;
}

/** Convert a denext VNode tree into the plain element shape satori consumes. */
function toSatori(node: VNodeChild): SatoriNode {
  if (node == null || typeof node === "boolean") return null;
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(toSatori);
  if (!isVNode(node)) return null;

  const { type, props } = node;
  if (isComponentType(type)) {
    const rendered = invokeComponent(resolveComponentType(type), props);
    if (rendered instanceof Promise) {
      throw new Error(
        "ImageResponse: components must be synchronous (no async server components).",
      );
    }
    return toSatori(rendered as VNodeChild);
  }
  if (type === FRAGMENT) return toSatori(props.children as VNodeChild);
  const { children, key: _key, ...rest } = props as Record<string, unknown>;
  return { type: type as string, props: { ...rest, children: toSatori(children as VNodeChild) } };
}

/**
 * Render JSX (or a satori element object) to a PNG {@linkcode Response}.
 *
 * @param element The JSX to render (host elements + inline `style` only).
 * @param options Output dimensions and `@cf-wasm/og` options.
 */
export function ImageResponse(
  element: VNode | object,
  options: ImageResponseOptions = {},
): Response {
  const el = isVNode(element) ? toSatori(element) : element;
  const { width = 1200, height = 630, headers: extraHeaders, ...rest } = options as
    & ImageResponseOptions
    & { headers?: HeadersInit };
  // Defer the wasm PNG render to when the body is read: import @cf-wasm/og inside
  // the stream so the module never loads wasm at import time (see the note above).
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const { ImageResponse: OgImageResponse } = await loadPeerCodec<OgModule>(
          "@cf-wasm/og",
          "npm:@cf-wasm/og@^0.5.0",
          "next/og ImageResponse",
        );
        const res = new OgImageResponse(el, { width, height, ...rest });
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
