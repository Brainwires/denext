// A denext app with `denextAuth()` + `backend({ supabase })`, driven by the stock supabase-js
// client through a `fetch` that calls the app's request pipeline — the shared fixture of the
// `/auth/v1` suites (in-memory adapter in tests/backend-supabase-auth.test.ts, Postgres in
// tests/backend-supabase-auth-integration.test.ts).

import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import type { DenextPlugin } from "../src/plugin/mod.ts";
import { applyPlugins, getPluginRequestHandler, resetPlugins } from "../src/plugin/mod.ts";
import { createApp } from "../src/server/app.ts";
import { scanRoutes } from "../src/router/manifest.ts";
import { denextAuth } from "../src/server/auth/mod.ts";
import { credentials } from "../src/server/auth/providers.ts";
import type { AuthAdapter } from "../src/server/auth/adapter.ts";
import type { AuthConfig, VerificationRequestParams } from "../src/server/auth/types.ts";
import { generateSupabaseKeys, installSupabaseKeys } from "../src/server/auth/gotrue/keys.ts";
import type { GoTrueOptions, GoTrueSmsMessage } from "../src/server/auth/gotrue/options.ts";
import { installGoTrue } from "../src/server/auth/gotrue/handler.ts";
import { backend, type BackendOptions } from "../packages/backend/mod.ts";

export const ORIGIN = "https://app.test";
const load = ((path: string) => import(path)) as unknown as ModuleLoader;

/** The bits of supabase-js the suites use (typed loosely: it is loaded by a computed specifier). */
// deno-lint-ignore no-explicit-any
export type SupabaseClient = any;

/** supabase-js, by a computed specifier: type checking must not download it. */
async function supabaseJs(): Promise<
  & { createClient: (url: string, key: string, options?: unknown) => SupabaseClient }
  & Record<
    string,
    unknown
  >
> {
  const spec = ["npm:@supabase/supabase-js", "2.117.2"].join("@");
  return await import(spec);
}

/** A running test app. */
export interface SupabaseAuthApp {
  /** `fetch` into the app (what supabase-js is given). */
  fetch: typeof fetch;
  /** The publishable (anon) key. */
  publishableKey: string;
  /** The secret (service-role) key. */
  secretKey: string;
  /** Emails sent, newest last. */
  emails: VerificationRequestParams[];
  /** SMS sent, newest last. */
  sms: GoTrueSmsMessage[];
  /** A supabase-js client with the publishable key (no persistence, no auto refresh). */
  client(options?: { flowType?: "implicit" | "pkce"; storage?: Storage }): SupabaseClient;
  /** A supabase-js client with the secret key (the admin API). */
  admin(): SupabaseClient;
  /** The auth config. */
  config: AuthConfig;
  /** Tear down. */
  close(): Promise<void>;
}

/** A Web Storage over a Map (for a PKCE client's code verifier). */
export function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
  };
}

/**
 * Build the app.
 *
 * @param options The adapter, `/auth/v1` options, extra auth config and backend options.
 * @returns The app.
 */
export async function supabaseAuthApp(options: {
  adapter: AuthAdapter;
  auth?: GoTrueOptions;
  authConfig?: Partial<AuthConfig>;
  backend?: Omit<BackendOptions, "supabase">;
  plugins?: DenextPlugin[];
  /** The plugin mode (`build`: auto-REST reads the catalog on the first request). */
  mode?: "prod" | "build";
  /** Load supabase-js for `client()` / `admin()` (default `true`; raw-HTTP suites skip it). */
  withClient?: boolean;
}): Promise<SupabaseAuthApp> {
  const root = await Deno.makeTempDir({ prefix: "dnx-supabase-auth-" });
  await Deno.mkdir(`${root}/app`);
  resetPlugins();
  const emails: VerificationRequestParams[] = [];
  const sms: GoTrueSmsMessage[] = [];
  const keys = await generateSupabaseKeys();
  const config: AuthConfig = {
    secret: "supabase-auth-secret-at-least-32-characters!",
    canonicalOrigin: ORIGIN,
    providers: [credentials()],
    adapter: options.adapter,
    rateLimit: false,
    sendVerificationRequest: (params) => void emails.push(params),
    ...options.authConfig,
  };
  const appConfig = {
    plugins: [
      ...(options.plugins ?? []),
      denextAuth(config),
      backend({
        ...options.backend,
        supabase: {
          publishableKey: keys.publishableKey,
          secretKey: keys.secretKey,
          signingKeys: keys.signingKey,
          auth: { sendSms: (message) => void sms.push(message), ...options.auth },
        },
      }),
    ],
  } as DenextConfig;
  await applyPlugins({
    projectRoot: root,
    appDir: `${root}/app`,
    config: appConfig,
    mode: options.mode ?? "prod",
    load,
  });
  const manifest = await scanRoutes(`${root}/app`);
  const handler = createApp({
    getManifest: () => manifest,
    load,
    matchExternal: getPluginRequestHandler(),
  });
  const appFetch: typeof fetch = async (input, init) => {
    // A Request with no init passes through as is, so a test's `setRemoteAddr` peer survives.
    const request = input instanceof Request && init === undefined
      ? input
      : new Request(input instanceof Request ? input : String(input), init);
    const response = await handler(request);
    return response;
  };
  const base = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
  const { createClient } = options.withClient === false
    ? {
      createClient: () => {
        throw new Error("supabaseAuthApp: built with withClient: false");
      },
    }
    : await supabaseJs();
  return {
    fetch: appFetch,
    publishableKey: keys.publishableKey,
    secretKey: keys.secretKey,
    emails,
    sms,
    config,
    client: (opts = {}) =>
      createClient(ORIGIN, keys.publishableKey, {
        global: { fetch: appFetch },
        auth: {
          ...base,
          flowType: opts.flowType ?? "implicit",
          ...(opts.storage ? { storage: opts.storage, persistSession: true } : {}),
        },
      }),
    admin: () => createClient(ORIGIN, keys.secretKey, { global: { fetch: appFetch }, auth: base }),
    async close() {
      resetPlugins();
      installSupabaseKeys(undefined);
      installGoTrue(undefined);
      await Deno.remove(root, { recursive: true });
    },
  };
}

/** The current TOTP code for a base32 secret (RFC 6238, SHA-1, 6 digits, 30 s). */
export async function totpCode(secret: string, at = Date.now()): Promise<string> {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = secret.replace(/=+$/, "").toUpperCase();
  let bits = "";
  for (const char of clean) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-1" }, false, [
    "sign",
  ]);
  const counter = new DataView(new ArrayBuffer(8));
  counter.setBigUint64(0, BigInt(Math.floor(at / 1000 / 30)));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter.buffer));
  const offset = mac[19] & 0xf;
  const value = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(value % 1_000_000).padStart(6, "0");
}
