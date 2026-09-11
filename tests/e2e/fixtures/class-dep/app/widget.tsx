"use client";
import { useState } from "denext";
// The e2e materializes this "dependency" into node_modules right before building (see
// class-runtime-lazy.e2e.test.ts), so the path is unresolvable to static analysis on purpose.
// fallow-ignore-next-line unresolved-import
import { Boundary, Counter } from "../node_modules/@acme/ui/mod.tsx";

// Throws during RENDER after a click, so the dependency's class boundary must catch it.
function Boom() {
  const [dead, setDead] = useState(false);
  if (dead) throw new Error("kaboom");
  return (
    <button type="button" data-testid="boom" onClick={() => setDead(true)}>
      Explode
    </button>
  );
}

export function Widget() {
  return (
    <Boundary>
      <Counter />
      <Boom />
    </Boundary>
  );
}
