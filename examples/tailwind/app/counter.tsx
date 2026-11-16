// The interactive part of the home page: a "use client" component, so the page itself stays a
// Server Component and only this button hydrates.
"use client";
import { useState } from "denext";

export function Counter() {
  const [count, setCount] = useState(0);

  return (
    <div class="flex items-center gap-4">
      <button
        type="button"
        onClick={() => setCount((c) => c + 1)}
        class="rounded-lg bg-sky-500 px-5 py-2.5 font-medium text-white shadow-lg shadow-sky-500/20 transition hover:bg-sky-400 active:scale-95"
      >
        Clicked {count} {count === 1 ? "time" : "times"}
      </button>
      <span class="text-sm text-slate-500">← hydrated &amp; interactive</span>
    </div>
  );
}
