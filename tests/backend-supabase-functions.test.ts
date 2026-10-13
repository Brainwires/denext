// The stock `@supabase/supabase-js` client against a denext app's Edge Functions:
// `functions.invoke(name, { body, headers, method, region })` with JSON, text, FormData and Blob
// bodies, the response parsed by its content type, a 401 surfacing as `FunctionsHttpError`,
// and a `verifyJwt: false` function called with no identity.
//
// Opt-in (it downloads supabase-js from npm): DENEXT_TEST_SUPABASE_JS=1. The backend-integration
// CI job sets it.
//
// The identity today is denext auth's session cookie (sent through supabase-js's global
// headers); once the Supabase-compatible keys land, the anon key and access tokens take over.

import { assertEquals, assertInstanceOf } from "@std/assert";
import { cookieFor, functionsApp, ORIGIN } from "./_functions-app.ts";

const enabled = Deno.env.get("DENEXT_TEST_SUPABASE_JS") === "1";
const USER = "6d1c4c6e-7a1e-4d43-9a0f-3c1f0c0a0002";

type SupabaseModule = {
  createClient: (url: string, key: string, options?: unknown) => {
    functions: {
      invoke: (
        name: string,
        options?: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: unknown }>;
    };
  };
  FunctionsHttpError: new (...args: unknown[]) => Error & { context: Response };
  FunctionRegion: Record<string, string>;
};

/** supabase-js, by a computed specifier: type checking must not download it. */
export async function supabaseJs(): Promise<SupabaseModule> {
  const spec = ["npm:@supabase/supabase-js", "2.49.4"].join("@");
  return await import(spec) as SupabaseModule;
}

Deno.test({
  name: `supabase-js functions.invoke against a denext app${
    enabled ? "" : " (skipped: set DENEXT_TEST_SUPABASE_JS=1)"
  }`,
  ignore: !enabled,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { createClient, FunctionsHttpError, FunctionRegion } = await supabaseJs();
    const app = await functionsApp({
      "functions/echo/index.ts": `
import { corsHeaders } from "../_shared/cors.ts";
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const type = req.headers.get("content-type") ?? "";
  let body: unknown = null;
  if (type.startsWith("application/json")) body = await req.json();
  else if (type.startsWith("multipart/form-data")) body = Object.fromEntries(await req.formData());
  else if (type.startsWith("application/octet-stream")) body = [...new Uint8Array(await req.arrayBuffer())];
  else if (req.method !== "GET") body = await req.text();
  return Response.json({
    method: req.method,
    type: type.split(";")[0],
    body,
    custom: req.headers.get("x-custom"),
    region: req.headers.get("x-region"),
    auth: req.headers.get("authorization"),
  }, { headers: corsHeaders });
});`,
      "functions/_shared/cors.ts": `export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};`,
      "functions/text.ts": `export default () => new Response("plain text");`,
      "functions/bytes.ts":
        `export default () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/octet-stream" } });`,
      "functions/public.ts":
        `Deno.serve((req) => Response.json({ hello: new URL(req.url).pathname }));`,
    }, {
      functions: {
        functions: {
          public: { verifyJwt: false },
          text: { verifyJwt: false },
          bytes: { verifyJwt: false },
        },
      },
    });
    try {
      const fetchApp = ((input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        return app.call(url.pathname + url.search, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          // deno-lint-ignore no-explicit-any
          ...(request.body ? { duplex: "half" } as any : {}),
        });
      }) as typeof fetch;
      const cookie = await cookieFor(USER);
      const signedIn = createClient(ORIGIN, "anon-key", {
        global: { fetch: fetchApp, headers: { cookie } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const anonymous = createClient(ORIGIN, "anon-key", {
        global: { fetch: fetchApp },
        auth: { persistSession: false, autoRefreshToken: false },
      });

      // A JSON body (an object), custom headers and a region.
      const json = await signedIn.functions.invoke("echo", {
        body: { name: "Functions" },
        headers: { "x-custom": "yes" },
        region: FunctionRegion.UsEast1,
      });
      assertEquals(json.error, null);
      const got = json.data as Record<string, unknown>;
      assertEquals(got.method, "POST");
      assertEquals(got.type, "application/json");
      assertEquals(got.body, { name: "Functions" });
      assertEquals(got.custom, "yes");
      assertEquals(got.region, "us-east-1");
      assertEquals(got.auth, "Bearer anon-key");

      // A string body is text/plain.
      const text = await signedIn.functions.invoke("echo", { body: "hello" });
      assertEquals((text.data as Record<string, unknown>).body, "hello");
      assertEquals((text.data as Record<string, unknown>).type, "text/plain");

      // FormData.
      const form = new FormData();
      form.set("field", "value");
      const formed = await signedIn.functions.invoke("echo", { body: form });
      assertEquals((formed.data as Record<string, unknown>).body, { field: "value" });

      // A Blob is application/octet-stream.
      const blob = await signedIn.functions.invoke("echo", {
        body: new Blob([new Uint8Array([7, 8])]),
      });
      assertEquals((blob.data as Record<string, unknown>).body, [7, 8]);

      // GET with no body.
      const get = await signedIn.functions.invoke("echo", { method: "GET" });
      assertEquals((get.data as Record<string, unknown>).method, "GET");

      // Responses are parsed by content type.
      assertEquals((await anonymous.functions.invoke("text")).data, "plain text");
      const bytes = (await anonymous.functions.invoke("bytes")).data as Blob;
      assertEquals([...new Uint8Array(await bytes.arrayBuffer())], [1, 2, 3]);

      // No identity: 401, as FunctionsHttpError with the response as its context.
      const denied = await anonymous.functions.invoke("echo", { body: { a: 1 } });
      assertInstanceOf(denied.error, FunctionsHttpError);
      assertEquals((denied.error as InstanceType<typeof FunctionsHttpError>).context.status, 401);

      // verifyJwt: false — callable by anyone.
      const open = await anonymous.functions.invoke("public", { body: {} });
      assertEquals(open.data, { hello: "/public" });
    } finally {
      await app.close();
    }
  },
});
