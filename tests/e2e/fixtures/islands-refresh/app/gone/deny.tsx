"use client";
import { useActionState, useEffect, useState } from "denext";
import { deny } from "../actions.ts";

export function Deny() {
  const [state, submit] = useActionState(deny, "idle");
  // Marks the island live: a submit before hydration would be the no-JS form post.
  const [live, setLive] = useState(false);
  useEffect(() => setLive(true), []);
  return (
    <form action={submit} data-live={live ? "1" : undefined}>
      <output data-testid="deny-state">{state}</output>
      <button type="submit" data-testid="deny">deny</button>
    </form>
  );
}
