/**
 * `useLocalStorage` / `useSessionStorage` — persist state in Web Storage with a
 * `useState`-like API: JSON serialization, cross-tab sync (localStorage fires a
 * `storage` event in other documents), and SSR safety. On the server, or where
 * storage is disabled (some privacy modes throw on access), the hooks return
 * the initial value and writes are silent no-ops.
 *
 * @module
 */

import { useCallback, useEffect, useState } from "../runtime/hooks.ts";

/** A `useState`-style setter that also accepts an updater function. */
export type SetStoredValue<T> = (value: T | ((previous: T) => T)) => void;

/**
 * The tuple returned by {@linkcode useLocalStorage} / {@linkcode useSessionStorage}:
 * `[value, setValue, remove]`.
 */
export type UseStorageResult<T> = [
  value: T,
  setValue: SetStoredValue<T>,
  remove: () => void,
];

/** The storage backend a hook targets. */
type StorageKind = "local" | "session";

/** The requested `Storage` area, or `null` when unavailable (SSR / disabled). */
function storageArea(kind: StorageKind): Storage | null {
  try {
    const area = kind === "local" ? globalThis.localStorage : globalThis.sessionStorage;
    return area ?? null;
  } catch {
    return null; // access itself throws in some privacy configurations
  }
}

/** Parse a stored JSON string, falling back to `initial` on absence or error. */
function parseStored<T>(raw: string | null, initial: T): T {
  if (raw === null) return initial;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return initial;
  }
}

/** Shared implementation for both storage areas. */
function useStorage<T>(kind: StorageKind, key: string, initialValue: T): UseStorageResult<T> {
  const [value, setValue] = useState<T>(() =>
    parseStored(storageArea(kind)?.getItem(key) ?? null, initialValue)
  );

  const set = useCallback<SetStoredValue<T>>((next) => {
    setValue((previous) => {
      const resolved = typeof next === "function" ? (next as (p: T) => T)(previous) : next;
      try {
        storageArea(kind)?.setItem(key, JSON.stringify(resolved));
      } catch { /* quota exceeded or storage disabled */ }
      return resolved;
    });
  }, [kind, key]);

  const remove = useCallback(() => {
    try {
      storageArea(kind)?.removeItem(key);
    } catch { /* storage disabled */ }
    setValue(initialValue);
  }, [kind, key]);

  // Cross-document sync: the `storage` event fires only in OTHER tabs/windows,
  // and only for localStorage. Keep this document in step with them.
  useEffect(() => {
    if (kind !== "local" || typeof globalThis.addEventListener !== "function") return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key) return;
      setValue(parseStored(event.newValue, initialValue));
    };
    globalThis.addEventListener("storage", onStorage);
    return () => globalThis.removeEventListener("storage", onStorage);
  }, [kind, key]);

  return [value, set, remove];
}

/**
 * Persist state in `localStorage`, keyed by `key`, with a `useState`-style API.
 * Values are JSON-serialized; updates propagate across tabs. SSR-safe.
 *
 * @param key The storage key.
 * @param initialValue The value used when nothing is stored (and during SSR).
 * @returns `[value, setValue, remove]` — {@linkcode UseStorageResult}.
 * @example
 * ```tsx
 * "use client";
 * import { useLocalStorage } from "denext";
 *
 * export function ThemeToggle() {
 *   const [theme, setTheme, reset] = useLocalStorage("theme", "system");
 *   return <button onClick={() => setTheme((t) => t === "dark" ? "light" : "dark")}>{theme}</button>;
 * }
 * ```
 */
export function useLocalStorage<T>(key: string, initialValue: T): UseStorageResult<T> {
  return useStorage("local", key, initialValue);
}

/**
 * Persist state in `sessionStorage` (cleared when the tab closes), keyed by
 * `key`, with a `useState`-style API. Values are JSON-serialized. SSR-safe.
 *
 * @param key The storage key.
 * @param initialValue The value used when nothing is stored (and during SSR).
 * @returns `[value, setValue, remove]` — {@linkcode UseStorageResult}.
 */
export function useSessionStorage<T>(key: string, initialValue: T): UseStorageResult<T> {
  return useStorage("session", key, initialValue);
}
