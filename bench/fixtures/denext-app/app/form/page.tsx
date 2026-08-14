// Form route — real `react-hook-form` (client state hooks) + `lucide-react`
// icons, function-component libraries running on denext's React.
import { createElement as h } from "react";
import { useForm } from "react-hook-form";
import { AtSign, Send, User } from "lucide-react";

interface Fields {
  name: string;
  email: string;
}

const fieldRow = "display:flex;align-items:center;gap:.5rem;margin:.75rem 0";
const input =
  "flex:1;padding:.4rem .6rem;border:1px solid #d1d5db;border-radius:.375rem";

export default function FormPage() {
  const { register, handleSubmit, formState: { errors } } = useForm<Fields>();
  const onSubmit = (data: Fields) => console.log(data);

  return h(
    "section",
    null,
    h("h1", null, "Contact form"),
    h("p", null, "A real react-hook-form form with lucide-react icons."),
    h(
      "form",
      { onSubmit: handleSubmit(onSubmit), style: "max-width:28rem" },
      h(
        "label",
        { style: fieldRow },
        h(User, { size: 18 }),
        h("input", {
          style: input,
          placeholder: "Name",
          ...register("name", { required: true }),
        }),
      ),
      errors.name
        ? h("small", { style: "color:#dc2626" }, "Name is required")
        : null,
      h(
        "label",
        { style: fieldRow },
        h(AtSign, { size: 18 }),
        h("input", {
          style: input,
          placeholder: "Email",
          type: "email",
          ...register("email", { required: true }),
        }),
      ),
      errors.email
        ? h("small", { style: "color:#dc2626" }, "Email is required")
        : null,
      h(
        "button",
        {
          type: "submit",
          style:
            "display:inline-flex;align-items:center;gap:.4rem;margin-top:.75rem;padding:.5rem .9rem;background:#6d28d9;color:#fff;border:0;border-radius:.375rem",
        },
        h(Send, { size: 16 }),
        "Send",
      ),
    ),
  );
}
