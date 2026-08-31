import { json } from "@remix-run/node";
import { useActionData } from "@remix-run/react";

export async function action({ request }: { request: Request }) {
  const form = await request.formData();
  return json({ ok: form.has("email") });
}

export default function Login() {
  const result = useActionData<typeof action>();
  return (
    <form method="post">
      <input name="email" type="email" />
      <button type="submit">Sign in</button>
      {result?.ok ? <p>Signed in</p> : null}
    </form>
  );
}
