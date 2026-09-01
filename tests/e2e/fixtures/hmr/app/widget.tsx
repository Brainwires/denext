import { useState } from "denext";

// A leaf component in its own module — editing THIS file should hot-swap only this
// module and preserve both its own local state and the parent page's counter.
export function Widget() {
  const [n] = useState(0);
  return <p data-testid="widget">WIDGET_V1 ({n})</p>;
}
