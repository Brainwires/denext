import { defineApi, revalidateTag } from "denext/server";
import { boolean, object, oneOf, optional, string } from "../../../lib/schema.ts";
import { addTodo, hasTitle, listTodos } from "../../../lib/store.ts";
import { todoEvents } from "../../channels.ts";

// `defineApi`: the query / body / response are Standard Schemas; the handler receives PARSED,
// typed input. A schema mismatch is a structured 400 before this code runs; `fail("duplicate")`
// is a typed 409 the client narrows on (`error.code === "duplicate"`). The generated
// `.denext/api.ts` infers all of it — `createApiClient()` / `useApi` are typed against it.

const todo = object({ id: string(), title: string(), done: boolean() });

export const GET = defineApi(
  {
    summary: "List todos",
    query: object({ done: optional(oneOf("true", "false")) }),
  },
  ({ query }) => listTodos(query.done === undefined ? undefined : query.done === "true"),
);

export const POST = defineApi({
  summary: "Create a todo",
  body: object({ title: string() }),
  response: todo,
  errors: { duplicate: 409 },
}, async ({ body, fail }) => {
  if (hasTitle(body.title)) {
    fail("duplicate", { message: `"${body.title}" already exists` });
  }
  const created = addTodo(body.title);
  revalidateTag("todos"); // → useApi({ tags: ["todos"] }) refetches, useSubscription re-pushes
  await todoEvents.publish("all", { kind: "added", title: created.title }); // → useChannel
  return created;
});
