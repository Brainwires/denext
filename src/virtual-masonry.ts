/**
 * `denext/virtual-masonry` — a virtualized masonry (Pinterest-style) layout: variable-height
 * items in balanced columns, only the items near the viewport rendered. A separate entry point
 * so apps using `VirtualList` (from `denext`) bundle none of it.
 *
 * @example
 * ```tsx
 * "use client";
 * import { VirtualMasonry } from "denext/virtual-masonry";
 *
 * export function Pins({ pins }) {
 *   return (
 *     <VirtualMasonry
 *       style={{ height: "100dvh" }}
 *       data={pins}
 *       numColumns={3}
 *       gap={8}
 *       renderItem={(p) => <img src={p.src} style={{ width: "100%" }} />}
 *     />
 *   );
 * }
 * ```
 *
 * @module
 */

export {
  VirtualMasonry,
  type VirtualMasonryHandle,
  type VirtualMasonryProps,
} from "./client/virtual/virtual-masonry.ts";
export { MasonryLayout, type MasonryPlacement } from "./client/virtual/masonry.ts";
