"use client";
import type { ErrorFallbackProps } from "denext";

export default function Error({ error, reset }: ErrorFallbackProps) {
  return (
    <div data-testid="error">
      <p data-testid="error-message">{error.message}</p>
      <button type="button" data-testid="reset" onClick={() => reset()}>Try again</button>
    </div>
  );
}
