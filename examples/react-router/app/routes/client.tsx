import { Form, useActionData } from "react-router";

// The server half: `loader` and `action` run on the server, as everywhere else.
export function loader() {
  return { source: "server loader" };
}

export async function action({ request }: { request: Request }) {
  const form = await request.formData();
  return { saved: String(form.get("note")) };
}

// The browser half (React Router v7's route-module client APIs). `clientLoader` runs in the
// browser; `serverLoader()` hands it the server loader's data. `hydrate = true` also runs it on
// the first load, with `HydrateFallback` rendered on the server until it settles.
export async function clientLoader(
  { serverLoader }: { serverLoader: () => Promise<{ source: string }> },
) {
  const server = await serverLoader();
  return { source: `${server.source} + clientLoader` };
}
clientLoader.hydrate = true as const;

export function HydrateFallback() {
  return <p id="client-fallback">Loading in the browser…</p>;
}

// `clientAction` runs for this route's <Form> in the browser; `serverAction()` runs `action`.
export async function clientAction(
  { serverAction }: { serverAction: () => Promise<{ saved: string }> },
) {
  const result = await serverAction();
  return { saved: `${result.saved} (via clientAction)` };
}

export default function Client(
  { loaderData }: { loaderData: { source: string } },
) {
  const actionData = useActionData<{ saved: string }>();
  return (
    <main>
      <h1 id="client">{loaderData.source}</h1>
      <Form method="post">
        <input name="note" defaultValue="hello" />
        <button id="save" type="submit">Save</button>
      </Form>
      {actionData ? <p id="saved">{actionData.saved}</p> : null}
    </main>
  );
}
