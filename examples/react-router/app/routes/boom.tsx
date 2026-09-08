import { isRouteErrorResponse, useRouteError } from "react-router";

export function loader() {
  throw new Response("teapot", { status: 418 });
}

export default function Boom() {
  return <p>never rendered — the loader throws</p>;
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <p id="boom">
      {isRouteErrorResponse(error) ? `caught ${error.status}` : "other error"}
    </p>
  );
}
