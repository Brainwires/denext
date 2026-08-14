// Form — mirrors denext-app's react-hook-form + lucide page.
"use client";

import { useForm } from "react-hook-form";
import { AtSign, Send, User } from "lucide-react";

interface Fields {
  name: string;
  email: string;
}

const fieldRow = {
  display: "flex",
  alignItems: "center",
  gap: ".5rem",
  margin: ".75rem 0",
} as const;
const input = {
  flex: 1,
  padding: ".4rem .6rem",
  border: "1px solid #d1d5db",
  borderRadius: ".375rem",
} as const;

export default function FormPage() {
  const { register, handleSubmit, formState: { errors } } = useForm<Fields>();
  const onSubmit = (data: Fields) => console.log(data);

  return (
    <section>
      <h1>Contact form</h1>
      <p>A real react-hook-form form with lucide-react icons.</p>
      <form onSubmit={handleSubmit(onSubmit)} style={{ maxWidth: "28rem" }}>
        <label style={fieldRow}>
          <User size={18} />
          <input
            style={input}
            placeholder="Name"
            {...register("name", { required: true })}
          />
        </label>
        {errors.name
          ? <small style={{ color: "#dc2626" }}>Name is required</small>
          : null}
        <label style={fieldRow}>
          <AtSign size={18} />
          <input
            style={input}
            placeholder="Email"
            type="email"
            {...register("email", { required: true })}
          />
        </label>
        {errors.email
          ? <small style={{ color: "#dc2626" }}>Email is required</small>
          : null}
        <button
          type="submit"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: ".4rem",
            marginTop: ".75rem",
            padding: ".5rem .9rem",
            background: "#6d28d9",
            color: "#fff",
            border: 0,
            borderRadius: ".375rem",
          }}
        >
          <Send size={16} />
          Send
        </button>
      </form>
    </section>
  );
}
