// The SPA entry.
import { createRoot } from "denext/client";
import { App } from "./app.tsx";
import "./styles.css";

const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);
