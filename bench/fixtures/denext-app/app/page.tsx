// Dashboard route — the REAL recharts npm package (built on React class
// components), the workload that exercises denext's `classComponents: true`
// opt-in. Server-rendered to SVG, hydrated on the client.
import { createElement as h } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const visits = [
  { name: "Mon", visits: 400, signups: 40 },
  { name: "Tue", visits: 300, signups: 28 },
  { name: "Wed", visits: 520, signups: 55 },
  { name: "Thu", visits: 280, signups: 31 },
  { name: "Fri", visits: 610, signups: 62 },
  { name: "Sat", visits: 750, signups: 70 },
  { name: "Sun", visits: 690, signups: 66 },
];

export default function Dashboard() {
  return h(
    "section",
    null,
    h("h1", null, "Analytics dashboard"),
    h(
      "p",
      null,
      "Two real ",
      h("code", null, "recharts"),
      " charts (a class-component library) running on denext's single React.",
    ),
    h(
      "h2",
      { style: "font-size:1rem;margin-top:1.5rem" },
      "Visits (line)",
    ),
    h(
      LineChart,
      { width: 640, height: 300, data: visits },
      h(CartesianGrid, { strokeDasharray: "3 3" }),
      h(XAxis, { dataKey: "name" }),
      h(YAxis, null),
      h(Tooltip, null),
      h(Legend, null),
      h(Line, {
        type: "monotone",
        dataKey: "visits",
        stroke: "#6d28d9",
        strokeWidth: 2,
      }),
    ),
    h(
      "h2",
      { style: "font-size:1rem;margin-top:1.5rem" },
      "Signups (bar)",
    ),
    h(
      BarChart,
      { width: 640, height: 300, data: visits },
      h(CartesianGrid, { strokeDasharray: "3 3" }),
      h(XAxis, { dataKey: "name" }),
      h(YAxis, null),
      h(Tooltip, null),
      h(Bar, { dataKey: "signups", fill: "#6d28d9" }),
    ),
  );
}
