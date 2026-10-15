import { auth } from "@/auth";

export async function GET() {
  const session = await auth() as { user?: { email?: string }; provider?: string } | null;
  return Response.json({
    email: session?.user?.email ?? null,
    provider: session?.provider ?? null,
  });
}
