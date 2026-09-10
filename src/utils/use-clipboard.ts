/**
 * `useCopyToClipboard` — copy text to the clipboard via the async Clipboard
 * API, with a transient `copied` flag for "Copied!" feedback. Client-only; on
 * the server, or where the API is unavailable, `copy` resolves `false` and sets
 * `error` (`isSupported` reports availability).
 *
 * @module
 */

import { useCallback, useEffect, useRef, useState } from "../runtime/hooks.ts";

/** The result of {@linkcode useCopyToClipboard}. */
export interface UseClipboardResult {
  /** `true` for `resetAfterMs` following a successful copy, else `false`. */
  copied: boolean;
  /** The error from the last failed copy, or `null`. */
  error: Error | null;
  /** Whether the async Clipboard write API is available here. */
  isSupported: boolean;
  /** Copy `text`; resolves `true` on success, `false` on failure. */
  copy: (text: string) => Promise<boolean>;
}

/** `navigator.clipboard.writeText`, bound, if the API exists here. */
function writeTextApi(): ((text: string) => Promise<void>) | undefined {
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  return typeof clipboard?.writeText === "function"
    ? clipboard.writeText.bind(clipboard)
    : undefined;
}

/**
 * Copy text to the clipboard, exposing a transient `copied` flag for feedback.
 *
 * @param resetAfterMs How long `copied` stays `true` after a successful copy,
 * in milliseconds (default `2000`; `0` keeps it until the next copy).
 * @returns {@linkcode UseClipboardResult}.
 * @example
 * ```tsx
 * "use client";
 * import { useCopyToClipboard } from "denext";
 *
 * export function CopyButton({ text }: { text: string }) {
 *   const { copied, copy, isSupported } = useCopyToClipboard();
 *   return <button disabled={!isSupported} onClick={() => copy(text)}>{copied ? "Copied!" : "Copy"}</button>;
 * }
 * ```
 */
export function useCopyToClipboard(resetAfterMs = 2000): UseClipboardResult {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSupported = writeTextApi() !== undefined;

  // Clear a pending "reset copied" timer on unmount (don't setState on a gone component).
  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  const copy = useCallback(async (text: string): Promise<boolean> => {
    const writeText = writeTextApi();
    if (!writeText) {
      setError(new Error("Clipboard API is unavailable"));
      return false;
    }
    try {
      await writeText(text);
      setError(null);
      setCopied(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      if (resetAfterMs > 0) {
        timerRef.current = setTimeout(() => setCopied(false), resetAfterMs);
      }
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
      setCopied(false);
      return false;
    }
  }, [resetAfterMs]);

  return { copied, error, isSupported, copy };
}
