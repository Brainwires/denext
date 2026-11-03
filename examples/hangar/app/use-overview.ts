"use client";
// The overview (VMs, instances, RAM budget), polled while the page is visible.

import { useCallback, useEffect, useState } from "denext";
import type { Overview } from "../lib/types.ts";
import { errorText, hangar } from "./hangar-client.ts";

/** How often the overview refreshes. */
const POLL_MS = 3000;

export function useOverview(): {
  overview: Overview | null;
  error: string;
  refresh: () => Promise<void>;
} {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      setOverview(await hangar.overview());
      setError("");
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  return { overview, error, refresh };
}
