(globalThis as { __loaded?: Record<string, boolean> }).__loaded ??= {};
(globalThis as unknown as { __loaded: Record<string, boolean> }).__loaded.chart = true;

export default function Chart(props: { label?: string; title?: string; count?: number }) {
  return (
    <section data-testid="chart">
      Chart {props.label ?? props.title ?? ""} {props.count ?? ""}
    </section>
  );
}
