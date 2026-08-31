import { json } from "@remix-run/node";
import { useLoaderData, useParams } from "@remix-run/react";

export function loader() {
  return json({ soldOut: false });
}

export default function City() {
  const { city } = useParams();
  const data = useLoaderData<typeof loader>();
  return (
    <h2>
      {city} — {data.soldOut ? "sold out" : "available"}
    </h2>
  );
}
