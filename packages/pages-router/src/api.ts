// Pages Router API routes: adapt a Web `Request` to Next's imperative
// `(req, res)` handler contract and collect the `res` calls into a `Response`.
// (Global middleware runs earlier in denext's pipeline, before this handler.)

import type { RouteParams } from "@denext/denext/server";

/** The `req` object passed to a Pages API handler (Next `NextApiRequest` subset). */
export interface ApiRequest {
  method: string;
  url: string;
  /** Route params merged with URL search params. */
  query: Record<string, string | string[]>;
  /** Parsed `Cookie` header. */
  cookies: Record<string, string>;
  /** Lower-cased request headers. */
  headers: Record<string, string>;
  /** Parsed body (JSON object, form object, or text), or undefined for GET/HEAD. */
  body: unknown;
}

/** The `res` object passed to a Pages API handler (Next `NextApiResponse` subset). */
export interface ApiResponse {
  statusCode: number;
  status(code: number): ApiResponse;
  setHeader(name: string, value: string | number | string[]): ApiResponse;
  getHeader(name: string): string | null;
  json(body: unknown): ApiResponse;
  send(body: unknown): ApiResponse;
  end(body?: unknown): ApiResponse;
  redirect(statusOrUrl: number | string, url?: string): ApiResponse;
  write(chunk: string): ApiResponse;
}

/** A Pages API handler module. */
export interface ApiModule {
  default?: (req: ApiRequest, res: ApiResponse) => unknown;
}

/** Parse a `Cookie` header into a name→value map. */
function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const k = pair.slice(0, eq).trim();
    if (k) out[k] = decodeURIComponent(pair.slice(eq + 1).trim());
  }
  return out;
}

/** Build the `req` object from a Web Request. */
async function buildReq(
  request: Request,
  params: RouteParams,
  url: URL,
): Promise<ApiRequest> {
  const query: Record<string, string | string[]> = { ...params };
  for (const [k, v] of url.searchParams) {
    const existing = query[k];
    if (existing === undefined) query[k] = v;
    else query[k] = Array.isArray(existing) ? [...existing, v] : [existing as string, v];
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of request.headers) headers[k] = v;

  let body: unknown = undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const ct = request.headers.get("content-type") ?? "";
    try {
      if (ct.includes("application/json")) body = await request.json();
      else if (ct.includes("application/x-www-form-urlencoded")) {
        body = Object.fromEntries(new URLSearchParams(await request.text()));
      } else body = await request.text();
    } catch {
      body = undefined;
    }
  }
  return {
    method: request.method,
    url: url.pathname + url.search,
    query,
    cookies: parseCookies(request.headers.get("cookie")),
    headers,
    body,
  };
}

/** A `res` object plus a promise that resolves to the final Response. */
function buildRes(): { res: ApiResponse; done: Promise<Response>; finish: () => void } {
  let statusCode = 200;
  const headers = new Headers();
  let body: BodyInit | null = null;
  let finished = false;
  let resolve!: (r: Response) => void;
  const done = new Promise<Response>((r) => (resolve = r));

  const finish = (): void => {
    if (finished) return;
    finished = true;
    resolve(new Response(body, { status: statusCode, headers }));
  };

  const res: ApiResponse = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(code: number) {
      statusCode = code;
    },
    status(code) {
      statusCode = code;
      return res;
    },
    setHeader(name, value) {
      headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
      return res;
    },
    getHeader(name) {
      return headers.get(name);
    },
    json(value) {
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      body = JSON.stringify(value);
      finish();
      return res;
    },
    send(value) {
      if (value != null && typeof value === "object" && !(value instanceof Uint8Array)) {
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
        body = JSON.stringify(value);
      } else {
        body = value as BodyInit;
      }
      finish();
      return res;
    },
    end(value) {
      if (value != null) body = value as BodyInit;
      finish();
      return res;
    },
    redirect(statusOrUrl, url) {
      const [code, location] = typeof statusOrUrl === "number"
        ? [statusOrUrl, url ?? "/"]
        : [307, statusOrUrl];
      statusCode = code;
      headers.set("location", location);
      finish();
      return res;
    },
    write(chunk) {
      body = (typeof body === "string" ? body : "") + chunk;
      return res;
    },
  };
  return { res, done, finish };
}

/**
 * Run a Pages API handler against a Web Request and return its Response. A handler
 * that never ends the response is finalized with whatever it set (mirroring Next's
 * lenient behavior) once it returns.
 */
export async function runApiRoute(
  mod: ApiModule,
  request: Request,
  params: RouteParams,
  url: URL,
): Promise<Response> {
  const handler = mod.default;
  if (typeof handler !== "function") {
    return new Response("API route has no default export", { status: 500 });
  }
  const req = await buildReq(request, params, url);
  const { res, done, finish } = buildRes();
  try {
    await handler(req, res);
  } catch (error) {
    if (!(res as { statusCode: number }).statusCode || res.statusCode < 400) {
      return new Response(`Internal Server Error`, { status: 500 });
    }
    throw error;
  }
  finish(); // finalize if the handler returned without ending the response
  return await done;
}
