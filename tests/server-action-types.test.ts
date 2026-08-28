// Typed Server Actions (2.0 Pillar V): serverAction returns ServerActionRef<A, R>, so a
// call is type-checked against the handler's signature across the client/server boundary
// (Next types actions only within a module — denext types them wherever they're imported).
import { assertEquals } from "@std/assert";
import { serverAction } from "../src/runtime/server-action.ts";

Deno.test("serverAction: the ref runs the handler and carries a stable id (server side)", async () => {
  const add = serverAction("test/add", (a: number, b: number) => a + b);
  assertEquals(await add(2, 3), 5); // typed as (a: number, b: number) => Promise<number>
  assertEquals(add.denextActionId, "test/add");
});

Deno.test("serverAction: calls are type-checked (wrong args / return are compile errors)", async () => {
  const mod = new URL("../src/runtime/server-action.ts", import.meta.url).pathname;
  const dir = await Deno.makeTempDir({ prefix: "denext-action-types-" });
  try {
    // A passing `deno check` here proves BOTH that a correct call type-checks AND that a
    // wrong-typed call errors (the @ts-expect-error is only satisfied if the call errors).
    await Deno.writeTextFile(
      `${dir}/t.ts`,
      [
        `import { serverAction } from "${mod}";`,
        `const save = serverAction("x/save", (id: number, name: string): Promise<{ ok: boolean }> => Promise.resolve({ ok: true }));`,
        `const good: Promise<{ ok: boolean }> = save(1, "a");`,
        `// @ts-expect-error wrong argument types`,
        `save("nope");`,
        `export { good };`,
      ].join("\n"),
    );
    const { code } = await new Deno.Command(Deno.execPath(), {
      args: ["check", `${dir}/t.ts`],
      stderr: "null",
      stdout: "null",
    }).output();
    assertEquals(code, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
