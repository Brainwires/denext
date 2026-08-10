// A next-compat page whose subtree uses the REAL `recharts` npm package. Recharts
// is built on React **class components** internally, so this example only works
// with `classComponents: true` — it's the real-world exercise of denext's gated
// class runtime. The chart resolves to denext's single React at build time, SSRs
// to SVG on the server, and hydrates (with tooltips) on the client.
import { createElement as h } from "react";
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";

const data = [
  { name: "Mon", visits: 400 },
  { name: "Tue", visits: 300 },
  { name: "Wed", visits: 520 },
  { name: "Thu", visits: 280 },
  { name: "Fri", visits: 610 },
  { name: "Sat", visits: 750 },
  { name: "Sun", visits: 690 },
];

export default function Page() {
  return h(
    "main",
    {
      style: "font-family:system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem",
    },
    h("h1", null, "denext × real recharts"),
    h(
      "p",
      null,
      "The chart below is the actual ",
      h("code", null, "recharts"),
      " npm package — which is built on React ",
      h("strong", null, "class components"),
      " — running on denext's single React. Enabled by ",
      h("code", null, "classComponents: true"),
      ", server-rendered to SVG, then hydrated.",
    ),
    h(
      LineChart,
      { width: 640, height: 320, data },
      h(CartesianGrid, { strokeDasharray: "3 3" }),
      h(XAxis, { dataKey: "name" }),
      h(YAxis, null),
      h(Tooltip, null),
      h(Line, { type: "monotone", dataKey: "visits", stroke: "#6d28d9", strokeWidth: 2 }),
    ),
  );
}
