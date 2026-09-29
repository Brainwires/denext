import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);
