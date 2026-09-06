import { defineApi, revalidateTag } from "denext/server";
import { boolean, object, string } from "../../../../lib/schema.ts";
import { removeTodo, setDone } from "../../../../lib/store.ts";
import { todoEvents } from "../../../channels.ts";

export const PATCH = defineApi({
  summary: "Toggle a todo",
  params: object({ id: string() }),
  body: object({ done: boolean() }),
  errors: { not_found: 404 },
}, async ({ params, body, fail }) => {
  const updated = setDone(params.id, body.done);
  if (!updated) fail("not_found");
  revalidateTag("todos");
  await todoEvents.publish("all", { kind: "toggled", title: updated!.title });
  return updated;
});

export const DELETE = defineApi({
  summary: "Delete a todo",
  params: object({ id: string() }),
  errors: { not_found: 404 },
}, async ({ params, fail }) => {
  if (!removeTodo(params.id)) fail("not_found");
  revalidateTag("todos");
  await todoEvents.publish("all", { kind: "removed", title: params.id });
  // Returning nothing is a 204.
});
