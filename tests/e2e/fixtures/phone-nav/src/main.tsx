import { createRoot } from "denext/client";
import { App } from "./app.tsx";

const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);
