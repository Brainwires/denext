import type { VNodeChildren } from "denext";

export default function Layout({ children }: { children: VNodeChildren }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>OpenAPI on denext</title>
        <style>
          {`body{font:16px/1.5 system-ui;margin:2rem auto;max-width:44rem;padding:0 1rem}
code,pre{background:#f4f4f5;border-radius:4px;padding:.1em .3em}pre{padding:.75rem;overflow:auto}
a{color:#2563eb}h1{margin-bottom:.25rem}`}
        </style>
      </head>
      <body>{children}</body>
    </html>
  );
}
