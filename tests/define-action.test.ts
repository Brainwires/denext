// Typed Server Actions (src/runtime/define-action.ts): defineAction validates FormData into a
// typed input, runs a typed handler, and returns a discriminated ActionResult<Out> — the Out
// type flows to the call site (asserted here by assigning into typed locals, checked by
// `deno check`). Covers a parser input, a Standard Schema input, validation + handler errors,
// the no-input default, the idle state, and the bare-FormData call shape.

import { assert, assertEquals } from "@std/assert";
import {
  ActionValidationError,
  defineAction,
  idleActionState,
  type StandardSchemaV1,
} from "../src/runtime/define-action.ts";

/** Build a FormData from a plain object. */
function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

const initial = idleActionState<{ id: string }>();

Deno.test("defineAction: valid input runs the handler and returns typed data", async () => {
  const createPost = defineAction({
    input: (f) => ({ title: String(f.title ?? "").trim() }),
    handler: ({ title }) => ({ id: `post:${title}` }),
  });
  const res = await createPost(initial, fd({ title: "hello" }));
  assert(res.ok);
  // Out flows to the call site: `res.data.id` is typed `string`.
  const id: string = res.data.id;
  assertEquals(id, "post:hello");
});

Deno.test("defineAction: a parser ActionValidationError becomes a typed field error", async () => {
  const createPost = defineAction({
    input: (f) => {
      const title = String(f.title ?? "").trim();
      if (!title) throw new ActionValidationError("bad", { title: "Title is required" });
      return { title };
    },
    handler: ({ title }) => ({ id: title }),
  });
  const res = await createPost(initial, fd({ title: "" }));
  assert(!res.ok);
  assertEquals(res.fieldErrors?.title, "Title is required");
});

Deno.test("defineAction: a handler throw is caught and returned as a failure", async () => {
  const action = defineAction({
    handler: () => {
      throw new Error("db down");
    },
  });
  const res = await action(idleActionState<never>(), fd({}));
  assert(!res.ok);
  assertEquals(res.error, "db down");
});

Deno.test("defineAction: with no input, the handler receives the raw form fields", async () => {
  const action = defineAction({
    handler: (fields) => ({ echo: String(fields.name) }),
  });
  const res = await action(idleActionState<{ echo: string }>(), fd({ name: "Ada" }));
  assert(res.ok);
  assertEquals(res.data.echo, "Ada");
});

Deno.test("defineAction: accepts a Standard Schema for input (Zod/Valibot-compatible)", async () => {
  // A minimal Standard Schema that coerces `n` to a number.
  const schema: StandardSchemaV1<{ n: number }> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => {
        const n = Number((value as Record<string, unknown>).n);
        return Number.isNaN(n)
          ? { issues: [{ message: "must be a number", path: ["n"] }] }
          : { value: { n } };
      },
    },
  };
  const doubler = defineAction({ input: schema, handler: ({ n }) => ({ doubled: n * 2 }) });

  const ok = await doubler(idleActionState<{ doubled: number }>(), fd({ n: "21" }));
  assert(ok.ok);
  assertEquals(ok.data.doubled, 42);

  const bad = await doubler(idleActionState<{ doubled: number }>(), fd({ n: "x" }));
  assert(!bad.ok);
  assertEquals(bad.fieldErrors?.n, "must be a number");
});

Deno.test("defineAction: tolerates a bare (formData) call (not just (prevState, formData))", async () => {
  const action = defineAction({ handler: (f) => ({ v: String(f.v) }) });
  // deno-lint-ignore no-explicit-any
  const res = await (action as any)(fd({ v: "1" }));
  assert(res.ok);
  assertEquals(res.data.v, "1");
});

Deno.test("idleActionState: is a not-yet-submitted failure state", () => {
  const s = idleActionState<{ id: string }>();
  assertEquals(s, { ok: false, error: "" });
});
