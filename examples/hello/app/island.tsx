// A client-only island, loaded via `dynamic(..., { ssr: false })` from the home
// page. It is code-split into its own chunk: absent from the server-rendered
// HTML, fetched and mounted only in the browser after hydration. The E2E suite
// asserts exactly that round-trip.

import { useEffect, useState } from "denext";

export default function Island() {
  const [time, setTime] = useState("…");

  useEffect(() => {
    setTime(new Date().toLocaleTimeString());
  }, []);

  return (
    <p class="island" data-testid="island">
      Client-only island — mounted at {time}
    </p>
  );
}
