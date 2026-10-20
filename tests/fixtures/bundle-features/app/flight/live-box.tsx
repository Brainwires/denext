"use client";

import { useState } from "denext";
import { usePresence } from "denext/live";
import { bump } from "./actions.ts";

export function LiveBox() {
  const [n, setN] = useState(0);
  const { others } = usePresence("lobby", { initialState: { name: "guest" } });
  return (
    <button type="button" onClick={async () => setN(await bump())}>
      {n} / {others.length}
    </button>
  );
}
