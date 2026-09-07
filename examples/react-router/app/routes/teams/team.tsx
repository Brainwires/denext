import { Form } from "react-router";

export function loader({ params }: { params: { id: string } }) {
  return { id: params.id };
}

export async function action({ request }: { request: Request }) {
  const form = await request.formData();
  return { renamed: String(form.get("name")) };
}

export default function Team(
  { loaderData, params }: { loaderData: { id: string }; params: { id: string } },
) {
  return (
    <article id="team">
      <h2>Team {loaderData.id} (param: {params.id})</h2>
      <Form method="post">
        <input name="name" placeholder="rename" />
        <button type="submit">Rename</button>
      </Form>
    </article>
  );
}
