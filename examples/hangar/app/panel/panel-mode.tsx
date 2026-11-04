"use client";
// Marks the document as the panel (`:root[data-mode="panel"]` in public/styles.css).
import { useEffect } from "denext";

export function PanelMode() {
  useEffect(() => {
    document.documentElement.dataset.mode = "panel";
  }, []);
  return null;
}
