// A next-compat page: a plain React component (default export) whose subtree uses
// the REAL @radix-ui/react-collapsible npm package. It resolves to denext's React
// at build time, SSRs on the server, and hydrates on the client — clicking the
// trigger toggles the content (real Radix interactivity, on denext).
import { createElement as h } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";

export default function Page(props: { params?: Record<string, string> }) {
  return h(
    "main",
    {
      style: "font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem",
    },
    h("h1", null, "denext × real npm Radix"),
    h(
      "p",
      null,
      "The collapsible below is the actual ",
      h("code", null, "@radix-ui/react-collapsible"),
      " npm package, running on denext's single React — server-rendered, then hydrated.",
    ),
    h(
      Collapsible.Root,
      { style: "border:1px solid #ccc;border-radius:8px;padding:1rem" },
      h(
        Collapsible.Trigger,
        {
          style:
            "font:inherit;cursor:pointer;background:#111;color:#fff;border:0;border-radius:6px;padding:.5rem 1rem",
        },
        "Toggle details",
      ),
      h(
        Collapsible.Content,
        null,
        h(
          "p",
          null,
          "Hidden content revealed by real Radix, hydrated by denext. Route: " +
            (props.params?.slug ?? "home"),
        ),
      ),
    ),
  );
}
