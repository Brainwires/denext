// Reached as a member tag (`<Widgets.Gauge client:visible />` on a namespace import).
(globalThis as { __loaded?: Record<string, boolean> }).__loaded ??= {};
(globalThis as unknown as { __loaded: Record<string, boolean> }).__loaded.widgets = true;

export function Gauge(props: { value: number }) {
  return <section data-testid="gauge">Gauge {props.value}</section>;
}
