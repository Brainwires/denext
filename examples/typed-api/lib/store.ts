// The demo's data: an in-memory list (a stand-in for a database). Server-only — imported by
// route handlers and "use server" modules, never by a client component.

export interface Todo {
  id: string;
  title: string;
  done: boolean;
}

const todos: Todo[] = [
  { id: "1", title: "Read the typed-api README", done: true },
  { id: "2", title: "Open this page in a second tab", done: false },
];

export function listTodos(done?: boolean): Todo[] {
  return done === undefined ? [...todos] : todos.filter((t) => t.done === done);
}

export function hasTitle(title: string): boolean {
  return todos.some((t) => t.title.toLowerCase() === title.toLowerCase());
}

export function addTodo(title: string): Todo {
  const todo = {
    id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
    title,
    done: false,
  };
  todos.push(todo);
  return todo;
}

export function setDone(id: string, done: boolean): Todo | undefined {
  const t = todos.find((t) => t.id === id);
  if (t) t.done = done;
  return t;
}

export function removeTodo(id: string): boolean {
  const i = todos.findIndex((t) => t.id === id);
  if (i === -1) return false;
  todos.splice(i, 1);
  return true;
}

export function stats(filter: "all" | "open"): { total: number; done: number } {
  const list = filter === "open" ? todos.filter((t) => !t.done) : todos;
  return { total: list.length, done: list.filter((t) => t.done).length };
}
