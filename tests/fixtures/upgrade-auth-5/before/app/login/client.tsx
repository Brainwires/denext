"use client";
import { signIn } from "next-auth/react";

export const Login = () => <button type="button" onClick={() => signIn("github")}>Sign in</button>;
