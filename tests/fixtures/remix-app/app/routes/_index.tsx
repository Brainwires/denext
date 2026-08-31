import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";

export function loader() {
  return json({ message: "Welcome to Remix" });
}

export default function Index() {
  const data = useLoaderData<typeof loader>();
  return (
    <main>
      <h1>{data.message}</h1>
      <Link to="/about">About</Link>
    </main>
  );
}
