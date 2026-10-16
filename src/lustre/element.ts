// `lustreElement`: a Lustre component (`lustre.component`, registered with `lustre.register`) as a
// custom element in denext JSX. Export the component it returns from a `"use client"` module.
//
// On the server it renders the element with its shadow root prerendered by Lustre's
// `component.prerender` as Declarative Shadow DOM (`<template shadowrootmode>`): the browser's
// parser attaches that shadow root before any script runs, so the first paint is the component's
// view. In the browser the island registers the element (once per tag, and only on pages that
// render it: the registration lives in the island's chunk, so a `client:visible` element registers
// when it scrolls into view); Lustre then adopts the declarative shadow root instead of rendering a
// new one. The element's attributes are its inputs (the component's `on_attribute_change`
// decoders), so props become attributes and a changed prop updates the running component.
//
// The tag also works on its own in JSX once some island has registered it; type it by declaring it
// in `JSX.IntrinsicElements` with {@link LustreElementAttributes}.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";
import { useEffect } from "../runtime/hooks.ts";
import type { LustreApp, LustreKit } from "./kit.ts";

/**
 * The props of a Lustre custom element in JSX: its attributes (each a string, the component's
 * `on_attribute_change` decoders parse them), the usual global ones, and light-DOM children for the
 * component's slots.
 *
 * @example
 * ```ts
 * declare module "denext/jsx-runtime" {
 *   namespace JSX {
 *     interface IntrinsicElements {
 *       "lustre-counter": LustreElementAttributes<{ start: string }>;
 *     }
 *   }
 * }
 * ```
 */
export type LustreElementAttributes<Attrs extends Record<string, string> = Record<string, string>> =
  & Partial<Attrs>
  & {
    /** The element's `id`. */
    id?: string;
    /** The element's `class`. */
    class?: string;
    /** The element's `slot`, inside another component. */
    slot?: string;
    /** Light-DOM children, for the component's `<slot>`s. */
    children?: VNodeChildren;
  };

/** Props that are not the element's attributes. */
const NOT_ATTRIBUTES = new Set(["children", "key", "ref"]);

/** The props that become attributes, as strings (`null` / `undefined` / `false` dropped). */
function attributesOf(props: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(props)) {
    if (NOT_ATTRIBUTES.has(name) || value == null || value === false) continue;
    out[name] = value === true ? "" : String(value);
  }
  return out;
}

/**
 * Turn a Lustre component into a denext component that renders it as the custom element `tag`.
 * Export the result from a `"use client"` module.
 *
 * @param kit The app's Lustre build (`import { lustre } from "../.denext/lustre.ts"`).
 * @param tag The custom element's name (it must contain a `-`).
 * @param app The Lustre component (`lustre.component(…)`, flags `Nil`).
 * @returns The component; its props are the element's attributes.
 * @example
 * ```ts
 * "use client";
 * import { lustreElement } from "denext/gleam";
 * import { lustre } from "../.denext/lustre.ts";
 * import * as counter from "@gleam/app/counter.mjs";
 *
 * export const CounterElement = lustreElement<{ start: string }>(
 *   lustre,
 *   "lustre-counter",
 *   counter.component(),
 * );
 * // In a Server Component: <CounterElement start="3" />
 * ```
 */
export function lustreElement<Attrs extends Record<string, string> = Record<string, string>>(
  kit: LustreKit,
  tag: string,
  app: LustreApp<undefined>,
): (props: LustreElementAttributes<Attrs>) => VNode {
  if (!/^[a-z][a-z0-9._]*-[a-z0-9._-]*$/.test(tag)) {
    throw new TypeError(`lustreElement: "${tag}" is not a valid custom element name`);
  }
  return function LustreElement(props: LustreElementAttributes<Attrs>): VNode {
    useEffect(() => {
      kit.register(app, tag);
    }, []);
    const attributes = attributesOf(props as Record<string, unknown>);
    const children = props.children as VNodeChildren | undefined;
    // In the browser the parser already turned the template into the shadow root: render the host
    // without it, so hydration matches the document and never touches the shadow root.
    if (kit.isBrowser()) return h(tag, attributes, children);
    const shadow = kit.prerender(app, tag, attributes);
    if (!shadow) return h(tag, attributes, children);
    const template = h("template", {
      shadowrootmode: shadow.mode,
      ...(shadow.delegatesFocus ? { shadowrootdelegatesfocus: "" } : {}),
      dangerouslySetInnerHTML: { __html: shadow.html },
    });
    return h(tag, attributes, template, children);
  };
}
