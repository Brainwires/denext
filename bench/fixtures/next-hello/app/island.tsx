// Client-only island — mirrors examples/hello/app/island.tsx. Loaded via
// next/dynamic({ ssr: false }) from the home page, code-split into its own chunk:
// absent from server HTML, fetched and mounted only in the browser.
"use client";

import { useEffect, useState } from "react";

export default function Island() {
  const [time, setTime] = useState("…");

  useEffect(() => {
    setTime(new Date().toLocaleTimeString());
  }, []);

  return (
    <p className="island" data-testid="island">
      Client-only island — mounted at {time}
    </p>
  );
}
