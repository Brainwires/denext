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
  installedSupabaseKeys,
  installSupabaseKeys,
  resolveSupabaseKeys,
  signSupabaseJwt,
  SUPABASE_KEY_ENV,
  supabaseJwks,
  type SupabaseKeys,
  type SupabaseKeysConfig,
} from "@denext/denext/server";
import type { GoTrueOptions } from "@denext/auth";
import type { PluginContext } from "@denext/denext/server";
import { join } from "@std/path";

/** `backend({ supabase })`: the Supabase-compatible endpoints and their keys. */
export interface SupabaseOptions extends SupabaseKeysConfig {
  /**
   * `/auth/v1` (GoTrue) options: the site URL and redirect allow-list, sign-up and
   * confirmation policy, anonymous users, SMS delivery, captcha, hooks, MFA and SAML. The users
   * themselves, the providers and the email delivery come from `denextAuth()`.
   */
  auth?: GoTrueOptions;
}

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

/** The roles `denext backend token` mints for. */
const TOKEN_ROLES = ["authenticated", "anon", "service_role"];

/**
 * The claims of a test token (`denext backend token`), in the shape `/auth/v1` issues.
 *
 * @param flags The command's flags.
 * @param now The clock, in seconds.
 * @returns The claims.
 * @throws {TypeError} For an unknown role, a bad `--exp` or `--claims`.
 */
export function tokenClaims(
  flags: Readonly<Record<string, string | number | boolean>>,
  now = Math.floor(Date.now() / 1000),
): Record<string, unknown> {
  const role = typeof flags.role === "string" ? flags.role : "authenticated";
  if (!TOKEN_ROLES.includes(role)) {
    throw new TypeError(`--role is one of ${TOKEN_ROLES.join(", ")}`);
  }
  const exp = flags.exp === undefined ? 3600 : Number(flags.exp);
  if (!Number.isInteger(exp) || exp <= 0) throw new TypeError("--exp is a number of seconds");
  if (role === "authenticated" && typeof flags.sub !== "string") {
    throw new TypeError("an authenticated token needs --sub <user id>");
  }
  let extra: Record<string, unknown> = {};
  if (typeof flags.claims === "string") {
    const parsed = JSON.parse(flags.claims);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("--claims is a JSON object");
    }
    extra = parsed;
  }
  return {
    iss: "denext",
    aud: role === "authenticated" ? "authenticated" : role,
    role,
    iat: now,
    exp: now + exp,
    ...(typeof flags.sub === "string" ? { sub: flags.sub } : {}),
    ...(typeof flags.email === "string" ? { email: flags.email } : {}),
    ...(role === "authenticated"
      ? { aal: "aal1", amr: [{ method: "password", timestamp: now }], is_anonymous: false }
      : {}),
    app_metadata: {},
    user_metadata: {},
    ...extra,
  };
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
    summary: "Backend utilities: `keys` mints API and JWT keys, `token` a bearer JWT for testing",
    usage: [
      "Usage: denext backend keys [--legacy] [--json]",
      "       denext backend token [--role r] [--sub id] [--email e] [--exp s] [--claims json]",
      "",
      "  keys        Print a new publishable key, secret key and ES256 signing key as env vars",
      "  --legacy    Also mint a JWT secret and the legacy anon / service_role JWTs",
      "  --json      Print JSON instead of KEY=value lines",
      "  token       Sign an access token with the app's signing key (like `supabase gen",
      "              bearer-jwt`): --role authenticated (needs --sub) | anon | service_role,",
      "              --exp seconds (default 3600), --claims '{…}' merged in. Prints only the token.",
    ].join("\n"),
    positionals: [{ name: "action", help: "keys | token" }],
    flags: [
      { name: "legacy", type: "boolean", help: "keys: also mint the legacy HS256 keys" },
      { name: "json", type: "boolean", help: "Print JSON" },
      { name: "role", type: "string", help: "token: authenticated | anon | service_role" },
      { name: "sub", type: "string", help: "token: the user id" },
      { name: "email", type: "string", help: "token: the email claim" },
      { name: "exp", type: "number", help: "token: seconds until it expires (default 3600)" },
      { name: "claims", type: "string", help: "token: extra claims, a JSON object" },
    ],
    run: async (ctx) => {
      const action = ctx.positionals[0];
      if (action === "token") {
        const keys = installedSupabaseKeys();
        if (!keys) throw new Error("denext backend token: no Supabase keys are installed");
        io.log(await signSupabaseJwt(keys, tokenClaims(ctx.flags)));
        return;
      }
      if (action !== "keys") {
        throw new Error(
          `denext backend: unknown action ${JSON.stringify(action ?? "")} (try keys or token)`,
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
