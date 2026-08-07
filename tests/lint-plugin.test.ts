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
