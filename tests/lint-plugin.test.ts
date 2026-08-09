import { assertEquals } from "@std/assert";
import plugin from "../src/lint/denext-plugin.ts";

// The `Deno.lint` testing API is runtime-available under `deno test` but not in
// the default ambient types; access it dynamically.
// deno-lint-ignore no-explicit-any
const denoLint = (Deno as any).lint;

function lint(source: string): string[] {
  return denoLint.runPlugin(plugin, "input.tsx", source).map(
    (d: { message: string }) => d.message,
  );
}

function count(source: string, needle: string): number {
  return lint(source).filter((m) => m.includes(needle)).length;
}

Deno.test("accepts hooks at the top level of a component", () => {
  const diags = lint(`
    import { useState } from "denext";
    function Counter() {
      const [n, setN] = useState(0);
      return null;
    }
  `);
  assertEquals(diags.length, 0);
});

Deno.test("accepts hooks in a custom useX hook", () => {
  const diags = lint(`
    function useThing() {
      const [n, setN] = useState(0);
      return n;
    }
  `);
  assertEquals(diags.length, 0);
});

Deno.test("flags a hook called conditionally", () => {
  const src = `
    function Comp() {
      if (cond) {
        const [n] = useState(0);
      }
      return null;
    }
  `;
  assertEquals(count(src, "rules-of-hooks"), 1);
});

Deno.test("flags a hook inside a loop", () => {
  const src = `
    function Comp() {
      for (let i = 0; i < 3; i++) {
        useEffect(() => {});
      }
      return null;
    }
  `;
  assertEquals(count(src, "rules-of-hooks"), 1);
});

Deno.test("flags a hook called after a conditional early return", () => {
  const src = `
    function Comp({ ready }) {
      const [a] = useState(0);
      if (!ready) return null;
      const [b] = useState(1);
      return b;
    }
  `;
  assertEquals(count(src, "rules-of-hooks"), 1);
});

Deno.test("accepts a conditional early return with no hooks after it", () => {
  const src = `
    function Comp({ items }) {
      const [a] = useState(0);
      if (!items) return null;
      return a;
    }
  `;
  assertEquals(lint(src).length, 0);
});

Deno.test("flags a hook called from a non-component function", () => {
  const src = `
    function notAComponent() {
      const [n] = useState(0);
      return n;
    }
  `;
  assertEquals(count(src, "hooks-in-component"), 1);
});

Deno.test("flags a hook called inside an event-handler callback", () => {
  const src = `
    function Comp() {
      const onClick = () => {
        const [n] = useState(0);
      };
      return null;
    }
  `;
  assertEquals(count(src, "hooks-in-component"), 1);
});

Deno.test("flags hooks in an async component", () => {
  const src = `
    async function Page() {
      const [n] = useState(0);
      return null;
    }
  `;
  assertEquals(count(src, "no-hooks-in-async"), 1);
});

Deno.test("clean async server component (no hooks) passes", () => {
  const src = `
    async function Page({ params }) {
      const data = await load(params.id);
      return data;
    }
  `;
  assertEquals(lint(src).length, 0);
});

// ---- directive-placement ---------------------------------------------------

Deno.test("accepts a leading use client / use server directive", () => {
  assertEquals(count(`"use client";\nexport default function C() {}`, "directive-placement"), 0);
  assertEquals(count(`"use server";\nexport const save = () => {};`, "directive-placement"), 0);
  // After another directive in the prologue is still leading.
  assertEquals(count(`"use strict";\n"use client";\nexport default C;`, "directive-placement"), 0);
});

Deno.test("flags a misplaced boundary directive", () => {
  const src = `
    import { x } from "./x.ts";
    "use client";
    export default function C() {}
  `;
  assertEquals(count(src, "directive-placement"), 1);
});

Deno.test("flags a module declaring both boundaries", () => {
  const src = `"use client";\n"use server";\nexport default function C() {}`;
  assertEquals(count(src, "directive-placement"), 1);
});
