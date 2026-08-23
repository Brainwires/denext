// The entry denext bundles for SPA mode. It mounts the app itself — a plain
// `createRoot(...).render(...)`, just like a Vite `main.tsx`. denext stays out of
// the mount, so the app is free to bring its own router, store, and data layer.
import { createRoot } from "denext/client";
import { App } from "./app.tsx";

const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);
