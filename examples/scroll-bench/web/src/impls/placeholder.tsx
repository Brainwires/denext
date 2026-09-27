// `denext`: the slot for denext's own VirtualList (Phase 2 of the virtual-list plan). Until it
// lands, the cell is recorded as skipped ("not yet implemented", shared/scenarios.ts) and this
// component is never mounted by the runner; it exists so the route and its wiring are in place.
//
// PHASE 2: replace this with `import { VirtualList } from "denext"` driven by `list.count` +
// `list.getItem(pos)`, registering a ListHandle like the other impls.

import type { ImplProps } from "./types.ts";

export default function DenextVirtualListPlaceholder(_props: ImplProps) {
  return (
    <div className="sb-message">
      denext VirtualList: not yet implemented (Phase 2).
    </div>
  );
}
