// Small shared pieces: a section card, a result box, and a history router.
import { type ReactNode, useEffect, useState } from "denext";

/** One capability: a title, an optional note, its buttons, and what they printed. */
export function Section(
  { title, note, children }: {
    title: string;
    note?: string;
    children?: ReactNode;
  },
) {
  return (
    <section class="card">
      <h2>{title}</h2>
      {note && <p class="note">{note}</p>}
      {children}
    </section>
  );
}

/** An error as `Error [code]: message` (denext/mobile errors carry a `code`). */
function errorText(err: Error): string {
  const code = (err as { code?: unknown }).code;
  return code ? `Error [${code}]: ${err.message}` : `Error: ${err.message}`;
}

/** Pretty-print anything a capability returned (or threw) for the result box. */
export function show(value: unknown): string {
  if (value instanceof Error) return errorText(value);
  if (value === undefined) return "done";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/**
 * `[output, run]`: `run(fn)` awaits `fn()` and puts its result (or its error) in `output`,
 * so every button prints on screen what happened.
 */
export function useRun(): [string, (fn: () => unknown) => Promise<void>] {
  const [output, setOutput] = useState("");
  const run = async (fn: () => unknown) => {
    setOutput("…");
    try {
      setOutput(show(await fn()));
    } catch (err) {
      setOutput(show(err));
    }
  };
  return [output, run];
}

/** The result box under a section's buttons. */
export function Output({ value }: { value: string }) {
  return value ? <pre class="out">{value}</pre> : null;
}

/** A button that runs `onClick`. */
export function Button(
  { label, onClick }: { label: string; onClick: () => unknown },
) {
  return <button type="button" onClick={() => void onClick()}>{label}</button>;
}

/** Push `to` onto the history and tell the router, as denext/mobile's link routing does. */
export function navigate(to: string): void {
  history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}

/** The current pathname, following `popstate` (deep links and push taps navigate this way). */
export function usePathname(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  return path;
}
