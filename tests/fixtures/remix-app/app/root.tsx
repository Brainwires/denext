import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "@remix-run/react";

export const meta = () => [{ title: "Remix Fixture" }];

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
