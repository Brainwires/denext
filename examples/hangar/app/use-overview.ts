"use client";
// The overview (VMs, instances, RAM budget), polled while the page is visible, and refreshed at
// once when the backend says the instances changed (the tray started or stopped a VM).

import { useCallback, useEffect, useState } from "denext";
import { onDesktopEvent } from "denext/desktop/client";
import { CHANGED_EVENT } from "../lib/changes.ts";
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
    const stop = onDesktopEvent("hangar", CHANGED_EVENT, () => void refresh());
    return () => {
      clearInterval(timer);
      stop();
    };
  }, [refresh]);
  return { overview, error, refresh };
}
