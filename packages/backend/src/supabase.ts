// `backend({ supabase })`: the Supabase wire surface's shared half — the API keys and JWT signing
// keys every endpoint authenticates with (installed process-wide for `resolveIdentity()` and
// `auth()`), the JWKS document, and `denext backend keys`, which mints a key set.
//
// Under `denext dev` with no keys configured, a key set is generated once and kept in
// `.denext/backend-keys.json` (git-ignored with the rest of `.denext/`), so a supabase-js client
// keeps working across restarts. Anywhere else, keys come from the configuration or the
// environment only: with none, every presented key is refused.

import type { CommandSpec } from "@denext/denext/cli/command";
import {
  generateSupabaseKeys,
  installSupabaseKeys,
  resolveSupabaseKeys,
  SUPABASE_KEY_ENV,
  supabaseJwks,
  type SupabaseKeys,
  type SupabaseKeysConfig,
} from "@denext/denext/server";
import type { PluginContext } from "@denext/denext/server";
import { join } from "@std/path";

/** `backend({ supabase })`: the Supabase-compatible endpoints and their keys. */
export interface SupabaseOptions extends SupabaseKeysConfig {}

/** Where `denext dev` keeps the key set it generated. */
export const DEV_KEYS_FILE = ".denext/backend-keys.json";

/** The JWKS path (`/auth/v1/.well-known/jwks.json`). */
const JWKS_PATH = "/auth/v1/.well-known/jwks.json";

/** Whether nothing at all is configured (neither in the options nor the environment). */
function unconfigured(options: SupabaseOptions, env: (name: string) => string | undefined) {
  return options.publishableKey === undefined && options.secretKey === undefined &&
    options.jwtSecret === undefined && options.signingKeys === undefined &&
    Object.values(SUPABASE_KEY_ENV).every((name) => !env(name));
}

/** The dev key set: read from `.denext/backend-keys.json`, or generated and written there. */
async function devKeys(projectRoot: string): Promise<SupabaseKeysConfig> {
  const path = join(projectRoot, DEV_KEYS_FILE);
  try {
    const stored = JSON.parse(await Deno.readTextFile(path));
    if (stored && typeof stored.publishableKey === "string") return stored;
  } catch {
    // Missing or unreadable: generate below.
  }
  const generated = await generateSupabaseKeys();
  const config: SupabaseKeysConfig = {
    publishableKey: generated.publishableKey,
    secretKey: generated.secretKey,
    signingKeys: [generated.signingKey],
  };
  await Deno.mkdir(join(projectRoot, ".denext"), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  console.log(
    `[@denext/backend] generated dev Supabase keys in ${DEV_KEYS_FILE} — publishable key: ${generated.publishableKey}`,
  );
  return config;
}

/**
 * Resolve and install the keys (plugin setup).
 *
 * @param ctx The plugin context.
 * @param options The `supabase` options.
 * @param env Reads an environment variable.
 * @returns The installed keys.
 */
export async function setupSupabaseKeys(
  ctx: Pick<PluginContext, "mode" | "projectRoot">,
  options: SupabaseOptions,
  env: (name: string) => string | undefined,
): Promise<SupabaseKeys> {
  let config: SupabaseKeysConfig = options;
  if (unconfigured(options, env)) {
    if (ctx.mode === "dev") {
      config = await devKeys(ctx.projectRoot);
    } else if (ctx.mode === "prod") {
      console.warn(
        "[@denext/backend] supabase: no keys configured — every API key is refused and no " +
          "access token can be signed. Run `denext backend keys` and set the variables it prints.",
      );
    }
  }
  const keys = await resolveSupabaseKeys(config, env);
  installSupabaseKeys(keys);
  return keys;
}

/**
 * Answer `GET /auth/v1/.well-known/jwks.json` with the public signing keys.
 *
 * @param request The request.
 * @param keys The installed keys.
 * @returns The response, or `null` for another path.
 */
export function jwksResponse(request: Request, keys: SupabaseKeys): Response | null {
  if (new URL(request.url).pathname !== JWKS_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  return Response.json(supabaseJwks(keys), {
    headers: { "cache-control": "public, max-age=600", "access-control-allow-origin": "*" },
  });
}

/** Where `denext backend keys` writes. */
export interface KeysCommandIo {
  /** Print a line. */
  log(line: string): void;
}

/**
 * `denext backend keys [--legacy] [--json]`: mint a key set and print it as environment
 * variables (or JSON).
 *
 * @param io Where to print.
 * @returns The command.
 */
export function createBackendCommand(io: KeysCommandIo = { log: console.log }): CommandSpec {
  return {
    name: "backend",
    summary: "Backend utilities: `keys` mints Supabase-compatible API and JWT keys",
    usage: [
      "Usage: denext backend keys [--legacy] [--json]",
      "",
      "  keys        Print a new publishable key, secret key and ES256 signing key as env vars",
      "  --legacy    Also mint a JWT secret and the legacy anon / service_role JWTs",
      "  --json      Print JSON instead of KEY=value lines",
    ].join("\n"),
    positionals: [{ name: "action", help: "keys" }],
    flags: [
      { name: "legacy", type: "boolean", help: "Also mint the legacy HS256 keys" },
      { name: "json", type: "boolean", help: "Print JSON" },
    ],
    run: async (ctx) => {
      const action = ctx.positionals[0];
      if (action !== "keys") {
        throw new Error(
          `denext backend: unknown action ${JSON.stringify(action ?? "")} (try keys)`,
        );
      }
      const keys = await generateSupabaseKeys({ legacy: ctx.flags.legacy === true });
      if (ctx.flags.json === true) {
        io.log(JSON.stringify(keys, null, 2));
        return;
      }
      io.log(`${SUPABASE_KEY_ENV.publishableKey}=${keys.publishableKey}`);
      io.log(`${SUPABASE_KEY_ENV.secretKey}=${keys.secretKey}`);
      io.log(`${SUPABASE_KEY_ENV.signingKeys}='${JSON.stringify([keys.signingKey])}'`);
      if (keys.jwtSecret) {
        io.log(`${SUPABASE_KEY_ENV.jwtSecret}=${keys.jwtSecret}`);
        io.log(`# legacy anon key: ${keys.anonKey}`);
        io.log(`# legacy service_role key: ${keys.serviceRoleKey}`);
      }
    },
  };
}
