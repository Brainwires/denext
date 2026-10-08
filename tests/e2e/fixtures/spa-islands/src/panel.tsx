(globalThis as { __loaded?: Record<string, boolean> }).__loaded ??= {};
(globalThis as unknown as { __loaded: Record<string, boolean> }).__loaded.panel = true;

export function Panel(props: { label?: string; title?: string; count?: number }) {
  return (
    <section data-testid="panel">
      Panel {props.label ?? props.title ?? ""} {props.count ?? ""}
    </section>
  );
}
