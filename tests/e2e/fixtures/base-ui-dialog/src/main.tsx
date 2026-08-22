import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
const el = document.getElementById("root");
// T3 mounts under StrictMode (spike-main.tsx / main.tsx both do), which double-
// invokes effects on mount (setup -> cleanup -> setup) — a real difference from a
// plain mount, and one that interacts with Base UI's rAF-scheduled transition.
if (el) {
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
