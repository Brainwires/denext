(globalThis as { __loaded?: Record<string, boolean> }).__loaded ??= {};
(globalThis as unknown as { __loaded: Record<string, boolean> }).__loaded.wide = true;

export function Wide(props: { label?: string; title?: string; count?: number }) {
  return (
    <section data-testid="wide">
      Wide {props.label ?? props.title ?? ""} {props.count ?? ""}
    </section>
  );
}
