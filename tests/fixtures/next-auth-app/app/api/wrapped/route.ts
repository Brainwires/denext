import { auth } from "@/auth";

export const GET = auth((req) => Response.json({ email: req.auth?.user?.email ?? null }));
