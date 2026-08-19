import type { VNodeChildren } from "denext";

export const metadata = { title: "denext plugin: aliases" };

export default function RootLayout({ children }: { children: VNodeChildren }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body>{children}</body>
    </html>
  );
}
