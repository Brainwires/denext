import type { VNodeChildren } from "denext";

export const metadata = {
  title: "denext × Postgres under load",
  description: "A networked Postgres pool driven under concurrent load.",
};

export default function RootLayout({ children }: { children: VNodeChildren }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
