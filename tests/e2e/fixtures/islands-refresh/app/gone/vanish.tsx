"use client";
import { vanish } from "../actions.ts";

// Returns the action's promise: a rejected handler promise reaches the client's boundaries.
export function Vanish() {
  return (
    <button type="button" data-testid="vanish" onClick={() => vanish()}>
      vanish
    </button>
  );
}
