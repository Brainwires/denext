"use server";
import { idleActionState } from "denext";
import { ActionValidationError, defineAction, revalidateTag } from "denext/server";
import { addTodo, hasTitle } from "../lib/store.ts";
import { todoEvents } from "./channels.ts";

// The no-JS path: a typed Server Action behind a plain <form>. Same store, same
// invalidation, same channel publish as the typed route handler — one source of truth.
const addTodoAction = defineAction({
  input: (f) => ({ title: String(f.title ?? "").trim() }),
  handler: async ({ title }) => {
    if (!title) {
      throw new ActionValidationError("Title is required", {
        title: "Title is required",
      });
    }
    if (hasTitle(title)) {
      throw new ActionValidationError("Already exists", {
        title: `"${title}" already exists`,
      });
    }
    const todo = addTodo(title);
    revalidateTag("todos");
    await todoEvents.publish("all", { kind: "added", title: todo.title });
    return { id: todo.id };
  },
});

/** The same typed action in `<form action>` shape (one argument): a native, no-JS POST. */
export async function addTodoForm(formData: FormData): Promise<void> {
  await addTodoAction(idleActionState<{ id: string }>(), formData);
}
