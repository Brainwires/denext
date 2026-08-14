// Shared layout for the denext next-compat benchmark app. A plain function
// component that wraps every route with nav chrome. Uses React's createElement
// directly (like the recharts example) so no JSX build config is needed; the
// next-compat build aliases `react` onto denext's single React.
import { createElement as h, type ReactNode } from "react";

const linkStyle =
  "margin-right:1rem;color:#6d28d9;text-decoration:none;font-weight:600";

export default function RootLayout({ children }: { children: ReactNode }) {
  return h(
    "div",
    {
      style:
        "font-family:system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem",
    },
    h(
      "nav",
      {
        style:
          "padding-bottom:1rem;border-bottom:1px solid #e5e7eb;margin-bottom:1.5rem",
      },
      h("a", { href: "/", style: linkStyle }, "Dashboard"),
      h("a", { href: "/form", style: linkStyle }, "Form"),
      h("a", { href: "/ui", style: linkStyle }, "UI"),
    ),
    h("main", null, children),
  );
}
