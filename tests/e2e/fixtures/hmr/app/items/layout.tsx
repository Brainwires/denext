// A NESTED layout module — editing THIS file must hot-swap only the layout and
// preserve the child route's state (the unbundled loop swaps the layout fiber in
// place, it does not remount the subtree).
export default function ItemsLayout({ children }: { children: unknown }) {
  return (
    <div data-testid="items-layout">
      <p data-testid="layout-tag">LAYOUT_V1</p>
      {children as never}
    </div>
  );
}
