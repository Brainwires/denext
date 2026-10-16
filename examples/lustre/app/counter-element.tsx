"use client";
// The Lustre counter as the custom element <lustre-counter>: the server prerenders its shadow
// root as Declarative Shadow DOM, the browser registers the element (once, from this island's
// chunk) and Lustre adopts that shadow root. Props are attributes.
import { lustreElement, type LustreElementAttributes } from "denext/gleam";
import { lustre } from "../.denext/lustre.ts";
import * as counter from "@gleam/app/counter.mjs";

declare module "denext/jsx-runtime" {
  namespace JSX {
    interface IntrinsicElements {
      // Type the bare tag too: <lustre-counter start="2" /> anywhere once it is registered.
      "lustre-counter": LustreElementAttributes<{ start: `${number}` }>;
    }
  }
}

export const CounterElement = lustreElement<{ start: `${number}` }>(
  lustre,
  "lustre-counter",
  counter.component(),
);
