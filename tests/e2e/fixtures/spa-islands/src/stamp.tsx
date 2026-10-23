// Deferred by its module-level default: the app writes `<Stamp />` with no directive.
(globalThis as { __loaded?: Record<string, boolean> }).__loaded ??= {};
(globalThis as unknown as { __loaded: Record<string, boolean> }).__loaded.stamp = true;

// Read by the build (the module-level default), not imported.
// fallow-ignore-next-line unused-export
export const hydrate = "visible";

export default function Stamp() {
  return <section data-testid="stamp">Stamp</section>;
}
