"use client";

// The cheapest per-row interactivity through an island: ONE island for the whole list. The
// rows' buttons are plain server HTML (StaticLike); this island renders nothing and, once
// hydrated, handles every click with one delegated listener, keeping each row's state in its
// own `aria-pressed`. No per-row component, props or hydration.

import { useEffect } from "denext";
import { toggleLike } from "../public/like-toggle.js";
import { markHydrated } from "./hydrated.ts";

export function LikeDelegate() {
  useEffect(() => {
    document.addEventListener("click", toggleLike);
    markHydrated();
    return () => document.removeEventListener("click", toggleLike);
  }, []);
  return null;
}
