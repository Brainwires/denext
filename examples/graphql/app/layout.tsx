import type { VNodeChildren } from "denext";

export default function Layout({ children }: { children: VNodeChildren }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>GraphQL on denext</title>
        <style>
          {`body{font:16px/1.5 system-ui;margin:2rem auto;max-width:44rem;padding:0 1rem}
code,pre{background:#f4f4f5;border-radius:4px;padding:.1em .3em}pre{padding:.75rem;overflow:auto}
.room{border:1px solid #ddd;border-radius:6px;padding:1rem}.room p{margin:.25rem 0}`}
        </style>
      </head>
      <body>{children}</body>
    </html>
  );
}
