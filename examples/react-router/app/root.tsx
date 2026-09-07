import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
} from "react-router";

export const links = () => [{ rel: "stylesheet", href: "/app.css" }];

// The root `Layout` export is React Router's document shell — denext renders it as the HTML
// document, running <Meta>, <Links>, <Scripts>, and <ScrollRestoration> from `denext/remix`.
export function Layout({ children }: { children: unknown }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body data-app="rr7">
        {children as never}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <main id="root-error">
      {isRouteErrorResponse(error) ? String(error.status) : "root boom"}
    </main>
  );
}
