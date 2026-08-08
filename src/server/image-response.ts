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

import { ImageResponse as OgImageResponse } from "@cf-wasm/og";
import { FRAGMENT, type VNode, type VNodeChild } from "../jsx/types.ts";

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
  if (typeof type === "function") {
    const rendered = type(props);
    if (rendered instanceof Promise) {
      throw new Error(
        "ImageResponse: components must be synchronous (no async server components).",
      );
    }
    return toSatori(rendered);
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
  const { width = 1200, height = 630, ...rest } = options;
  // deno-lint-ignore no-explicit-any -- bridge to @cf-wasm/og's element typing.
  return new OgImageResponse(el as any, { width, height, ...rest });
}
