import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";

// Module-level counter: increments every time the loader runs, so a successful
// revalidation after the action visibly bumps the rendered value.
let visits = 0;

export function loader() {
  visits += 1;
  return json({ visits });
}

export async function action({ request }: { request: Request }) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  return json({ ok: email.length > 0, email });
}

export default function Login() {
  const { visits } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  return (
    <Form method="post">
      <input name="email" type="email" />
      <button type="submit">Sign in</button>
      <p data-testid="visits">visits: {visits}</p>
      <p data-testid="state">state: {navigation.state}</p>
      {result?.ok
        ? <p data-testid="result">Signed in as {result.email}</p>
        : result
        ? <p data-testid="result">Missing email</p>
        : null}
    </Form>
  );
}
