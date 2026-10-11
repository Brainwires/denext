"use client";
// Instrumented (it awaits), so the build copies it into `.denext/asyncctx/`: each of its
// relative imports below must still reach the module beside the ORIGINAL.
import { dynamic, useEffect, useState } from "denext";
import "./loader.css";
import data from "./data.json" with { type: "json" };
import { Tag } from "./tag.tsx";

// A literal `import()`: its own code-split chunk, loaded only in the browser.
const Lazy = dynamic(() => import("./lazy.tsx"), {
  ssr: false,
  loading: () => <p id="lazy-loading">loading…</p>,
});

export function Loader() {
  const [extra, setExtra] = useState("pending");
  useEffect(() => {
    void (async () => {
      // A template-literal `import()` with no substitutions is a literal specifier too.
      const mod = await import(`./extra.ts`);
      setExtra(mod.extra);
    })();
  }, []);
  return (
    <section class="ac-marker">
      <p id="json">{data.label}</p>
      <Tag />
      <p id="extra">{extra}</p>
      <Lazy />
    </section>
  );
}
