"use client";
import { bump } from "./actions.ts";

export function Bump() {
  return (
    <button type="button" data-testid="bump" onClick={() => void bump()}>
      bump
    </button>
  );
}
