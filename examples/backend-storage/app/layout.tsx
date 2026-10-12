import type { VNodeChildren } from "denext";

const STYLES = [
  "body{font-family:system-ui;max-width:46rem;margin:0 auto;padding:2rem 1rem;line-height:1.5}",
  ".grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:.75rem}",
  ".grid img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px;background:#eee}",
  "progress{width:100%}",
].join("\n");

export default function StorageLayout(
  { children }: { children: VNodeChildren },
) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Storage on denext</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>{STYLES}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
