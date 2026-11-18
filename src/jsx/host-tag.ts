// The host-element gate every server renderer passes a non-component element through.
//
// An element reaches a renderer as a child or a prop value, and either can be data: a JSON
// document from a database, a request body, a third-party API. `createElement` / `jsx` stamp
// every element with a `$$typeof` symbol, which JSON cannot express, so an object that claims
// to be a host element without it was not created by the app (React's rule since 0.14). Without
// this gate `<p>{post.title}</p>` rendered a stored `{ "type": "script", "props": { … } }` as
// markup. Component, fragment and boundary elements need no brand here: their `type` is a
// function or a symbol, which JSON cannot express either.

import type { VNode } from "./types.ts";
import { isElementBrand } from "../runtime/react-brands.ts";

/** React DOM server's `VALID_TAG_REGEX`: what a tag name may be when written into markup. */
const VALID_TAG = /^[a-zA-Z][a-zA-Z:_.\-\d]*$/;

/**
 * Whether `value` is an element a renderer may render: element-shaped, and branded when its
 * `type` is a string (a host element). A plain data object shaped like `{ type, props }` is not.
 *
 * @param value A child or a prop value.
 * @returns Whether it is an element.
 */
export function isRenderableElement(value: unknown): value is VNode {
  if (typeof value !== "object" || value === null) return false;
  if (!("type" in value) || !("props" in value)) return false;
  const type = (value as VNode).type as unknown;
  if (typeof type === "function" || typeof type === "symbol") return true;
  return isElementBrand((value as VNode).$$typeof);
}

/**
 * The tag of the host element `node`, checked: the element carries the element brand and its
 * tag is a valid tag name.
 *
 * @param node An element whose type is not a component, fragment or boundary.
 * @returns The tag name.
 * @throws Error for an object that is not an element, or a tag name that is not valid.
 */
export function hostTagOf(node: VNode): string {
  const tag = node.type as unknown;
  if (typeof tag !== "string" || !isElementBrand(node.$$typeof)) {
    throw new Error(
      "denext: objects are not valid as a child (found an object with keys {" +
        Object.keys(node).slice(0, 8).join(", ") +
        "}). An element is created with JSX or createElement; to render data, read its fields.",
    );
  }
  if (!VALID_TAG.test(tag)) throw new Error(`denext: invalid tag: ${JSON.stringify(tag)}`);
  return tag;
}
