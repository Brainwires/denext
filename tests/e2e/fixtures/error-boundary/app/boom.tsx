"use client";
import { useState } from "denext";

// Throws during RENDER (not in the event handler — error boundaries don't catch those):
// the click flips state, the re-render throws, and app/error.tsx catches it.
export function Boom() {
  const [dead, setDead] = useState(false);
  if (dead) throw new Error("kaboom");
  return (
    <button type="button" data-testid="boom" onClick={() => setDead(true)}>
      Explode
    </button>
  );
}
