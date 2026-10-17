import { auth } from "@/auth";

export async function GET() {
  const session = await auth() as { user?: { email?: string }; userId?: string } | null;
  return Response.json({ email: session?.user?.email ?? null, userId: session?.userId ?? null });
}
