// The Clerk keys the examples/clerk e2e tests run against, from the environment (the CI secret
// names first, then the names the example itself reads) or the example's git-ignored `.env` /
// `.env.local`. Returns null when either key is missing. Never logs a value.

import { join } from "@std/path";
import { parseEnv } from "../../src/server/env.ts";

/** A Clerk development instance's keys. */
export interface ClerkTestKeys {
  readonly publishableKey: string;
  readonly secretKey: string;
}

/** `name` from the environment, trimmed, or undefined. */
function fromEnv(name: string): string | undefined {
  return Deno.env.get(name)?.trim() || undefined;
}

/** The example's `.env` then `.env.local` (later wins), or `{}`. */
async function envFiles(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const file of [".env", ".env.local"]) {
    try {
      Object.assign(out, parseEnv(await Deno.readTextFile(join(dir, file))));
    } catch { /* absent */ }
  }
  return out;
}

/**
 * The keys, or null. Only a DEVELOPMENT instance (`pk_test_` / `sk_test_`) is accepted: the tests
 * create and delete users and rely on test mode.
 *
 * @param exampleDir `examples/clerk`.
 */
export async function clerkTestKeys(exampleDir: string): Promise<ClerkTestKeys | null> {
  const files = await envFiles(exampleDir);
  const publishableKey = fromEnv("CLERK_TEST_PUBLISHABLE_KEY") ??
    fromEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY") ?? files.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim();
  const secretKey = fromEnv("CLERK_TEST_SECRET_KEY") ?? fromEnv("CLERK_SECRET_KEY") ??
    files.CLERK_SECRET_KEY?.trim();
  if (!publishableKey?.startsWith("pk_test_") || !secretKey?.startsWith("sk_test_")) return null;
  return { publishableKey, secretKey };
}
