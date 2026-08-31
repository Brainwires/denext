import { useParams } from "@remix-run/react";

export default function CatchAll() {
  const params = useParams();
  return <p>Not found: {params["*"]}</p>;
}
