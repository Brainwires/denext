"use client";
import { createApiClient, isApiClientError, useState } from "denext";
import { useApiLive } from "denext/live";
// The generated schema registers itself: after the first `denext dev`/`build`, this
// type-only import makes `createApiClient()` and `useApi` typed against THIS app's routes —
// path, method, params, query, body, response, and error codes. (Type-only: nothing ships.)
import type {} from "../.denext/api.ts";

const api = createApiClient();

// `useApiLive` = `useApi` whose `tags` refetch when the server revalidates them (over the
// Live socket). The list is fetched once after mount and refetched on every change made by
// ANY tab; several `useApi` calls in one render ride ONE batched request.
export function Todos() {
  const list = useApiLive("/api/todos", "GET", undefined, { tags: ["todos"] });
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setError(null);
    try {
      await api("/api/todos", "POST", { body: { title } });
      setTitle("");
      // No manual refetch: the handler revalidated "todos" → the tag watch refetches.
    } catch (err) {
      // Typed: `code` narrows to "duplicate" | "validation" | … ; the message is the server's.
      if (isApiClientError(err)) {
        setError(`${err.code}: ${err.message.split(": ").pop()}`);
      } else throw err;
    }
  };

  const items = (list.data ?? []) as {
    id: string;
    title: string;
    done: boolean;
  }[];
  return (
    <div class="todos">
      <ul class="entries">
        {items.map((t) => (
          <li key={t.id} class={t.done ? "done" : ""}>
            <label>
              <input
                type="checkbox"
                checked={t.done}
                onChange={() =>
                  void api("/api/todos/[id]", "PATCH", {
                    params: { id: t.id },
                    body: { done: !t.done },
                  })}
              />
              {t.title}
            </label>
            <button
              type="button"
              class="remove"
              onClick={() => void api("/api/todos/[id]", "DELETE", { params: { id: t.id } })}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div class="add">
        <input
          value={title}
          onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
          placeholder="New todo"
        />
        <button type="button" onClick={() => void add()}>Add</button>
      </div>
      {error && <p class="error">{error}</p>}
      {list.pending && <p class="hint">loading…</p>}
    </div>
  );
}
