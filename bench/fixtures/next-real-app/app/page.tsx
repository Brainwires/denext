// Dashboard — mirrors denext-app's recharts page. recharts needs client APIs, so
// this is a Client Component ("use client"), the same interactivity boundary.
"use client";

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
  return (
    <section>
      <h1>Analytics dashboard</h1>
      <p>
        Two real <code>recharts</code>{" "}
        charts (a class-component library) on React + Next.
      </p>
      <h2 style={{ fontSize: "1rem", marginTop: "1.5rem" }}>Visits (line)</h2>
      <LineChart width={640} height={300} data={visits}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="name" />
        <YAxis />
        <Tooltip />
        <Legend />
        <Line
          type="monotone"
          dataKey="visits"
          stroke="#6d28d9"
          strokeWidth={2}
        />
      </LineChart>
      <h2 style={{ fontSize: "1rem", marginTop: "1.5rem" }}>Signups (bar)</h2>
      <BarChart width={640} height={300} data={visits}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="name" />
        <YAxis />
        <Tooltip />
        <Bar dataKey="signups" fill="#6d28d9" />
      </BarChart>
    </section>
  );
}
