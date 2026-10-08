(globalThis as { __loaded?: Record<string, boolean> }).__loaded ??= {};
(globalThis as unknown as { __loaded: Record<string, boolean> }).__loaded.later = true;

export function Later(props: { label?: string; title?: string; count?: number }) {
  return (
    <section data-testid="later">
      Later {props.label ?? props.title ?? ""} {props.count ?? ""}
    </section>
  );
}
