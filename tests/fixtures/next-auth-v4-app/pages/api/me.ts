import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "../../lib/auth";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions) as
    | { user?: { email?: string }; provider?: string }
    | null;
  if (!session) return res.status(401).json({ email: null });
  res.status(200).json({ email: session.user?.email ?? null, provider: session.provider });
}
