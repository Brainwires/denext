// Pages Router API routes: adapt a Web `Request` to Next's imperative
// `(req, res)` handler contract and collect the `res` calls into a `Response`.
// (Global middleware runs earlier in denext's pipeline, before this handler.)

import type { RouteParams } from "@denext/denext/server";
import { clearPreviewCookie, previewSecrets, setPreviewCookie, signPreview } from "./preview.ts";

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
  /**
   * Enable Preview Mode: set a signed, httpOnly cookie carrying `data`, so a later
   * `getStaticProps`/`getServerSideProps` sees `context.preview === true` +
   * `context.previewData` and the static cache is bypassed. `maxAge` defaults to the
   * session (cleared when the browser closes).
   */
  setPreviewData(data: unknown, options?: { maxAge?: number }): ApiResponse;
  /** Disable Preview Mode: clear the preview cookie. */
  clearPreviewData(): ApiResponse;
}

/** A deferred preview-cookie mutation, applied (signed) when the response finalizes. */
type PreviewAction =
  | { kind: "set"; data: unknown; maxAge?: number }
  | { kind: "clear" };

/** `export const config` for an API route (Next's `bodyParser` subset). */
export interface ApiRouteConfig {
  api?: {
    /**
     * `false` leaves the body **unparsed** — `req.body` is the raw `Uint8Array`
     * (for webhooks that verify a signature over the exact bytes). An object opts
     * into parsing with a `sizeLimit` (e.g. `"500kb"`, `"2mb"`, or a byte count).
     */
    bodyParser?: false | { sizeLimit?: string | number };
    /** Reserved for parity; denext resolves the response when the handler returns. */
    externalResolver?: boolean;
  };
}

/** A Pages API handler module. */
export interface ApiModule {
  default?: (req: ApiRequest, res: ApiResponse) => unknown;
  /** `export const config` — body-parsing options. */
  config?: ApiRouteConfig;
}

/** Parse a Next size-limit (`"1mb"`, `"500kb"`, `1024`) into bytes; default 1 MiB. */
function parseSizeLimit(limit: string | number | undefined): number {
  if (typeof limit === "number") return limit;
  if (!limit) return 1024 * 1024; // Next's default bodyParser sizeLimit is 1mb
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(limit.trim());
  if (!m) return 1024 * 1024;
  const n = parseFloat(m[1]);
  const unit = (m[2] ?? "b").toLowerCase();
  const mult = unit === "gb" ? 1024 ** 3 : unit === "mb" ? 1024 ** 2 : unit === "kb" ? 1024 : 1;
  return Math.floor(n * mult);
}

/** Raised when a request body exceeds the configured `sizeLimit`. */
class BodyTooLargeError extends Error {}

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

/** Read the request body as bytes, enforcing `sizeLimit`. */
async function readBytes(
  request: Request,
  sizeLimit: number,
): Promise<Uint8Array> {
  const buf = await request.arrayBuffer();
  if (buf.byteLength > sizeLimit) throw new BodyTooLargeError();
  return new Uint8Array(buf);
}

/**
 * Parse a `multipart/form-data` body into a plain object: text fields become
 * strings (repeated names become arrays), and file parts become `File` objects.
 */
async function parseMultipart(
  request: Request,
): Promise<Record<string, unknown>> {
  const form = await request.formData();
  const out: Record<string, unknown> = {};
  for (const [k, v] of form) {
    const existing = out[k];
    if (existing === undefined) out[k] = v;
    else if (Array.isArray(existing)) existing.push(v);
    else out[k] = [existing, v];
  }
  return out;
}

/** Build the `req` object from a Web Request. */
async function buildReq(
  request: Request,
  params: RouteParams,
  url: URL,
  config: ApiRouteConfig | undefined,
): Promise<ApiRequest> {
  const query: Record<string, string | string[]> = { ...params };
  for (const [k, v] of url.searchParams) {
    const existing = query[k];
    if (existing === undefined) query[k] = v;
    else query[k] = Array.isArray(existing) ? [...existing, v] : [existing as string, v];
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of request.headers) headers[k] = v;

  const bodyParser = config?.api?.bodyParser;
  const sizeLimit = bodyParser === false ? Infinity : parseSizeLimit(
    bodyParser === undefined ? undefined : bodyParser.sizeLimit,
  );

  let body: unknown = undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const ct = request.headers.get("content-type") ?? "";
    // `bodyParser: false` → hand back the raw bytes unparsed (webhook signatures).
    if (bodyParser === false) {
      body = new Uint8Array(await request.arrayBuffer());
    } else {
      try {
        if (ct.includes("application/json")) {
          body = JSON.parse(
            new TextDecoder().decode(await readBytes(request, sizeLimit)),
          );
        } else if (ct.includes("application/x-www-form-urlencoded")) {
          const text = new TextDecoder().decode(
            await readBytes(request, sizeLimit),
          );
          body = Object.fromEntries(new URLSearchParams(text));
        } else if (ct.includes("multipart/form-data")) {
          // denext convenience: multipart is parsed into fields + `File`s (Next
          // requires an external parser). The size limit is not enforced here — the
          // platform streams parts — so gate large uploads at the edge if needed.
          body = await parseMultipart(request);
        } else {
          body = new TextDecoder().decode(await readBytes(request, sizeLimit));
        }
      } catch (err) {
        if (err instanceof BodyTooLargeError) throw err;
        body = undefined; // malformed body → undefined (Next parity)
      }
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
function buildRes(): {
  res: ApiResponse;
  done: Promise<Response>;
  finish: () => void;
  preview: () => PreviewAction | null;
} {
  let statusCode = 200;
  const headers = new Headers();
  let body: BodyInit | null = null;
  let finished = false;
  let previewAction: PreviewAction | null = null;
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
      headers.set(
        name,
        Array.isArray(value) ? value.join(", ") : String(value),
      );
      return res;
    },
    getHeader(name) {
      return headers.get(name);
    },
    json(value) {
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      body = JSON.stringify(value);
      finish();
      return res;
    },
    send(value) {
      if (
        value != null && typeof value === "object" &&
        !(value instanceof Uint8Array)
      ) {
        if (!headers.has("content-type")) {
          headers.set("content-type", "application/json");
        }
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
    setPreviewData(data, options) {
      // Recorded synchronously (Next parity); signed + written as a Set-Cookie when
      // runApiRoute finalizes the response (HMAC signing is async).
      previewAction = { kind: "set", data, maxAge: options?.maxAge };
      return res;
    },
    clearPreviewData() {
      previewAction = { kind: "clear" };
      return res;
    },
  };
  return { res, done, finish, preview: () => previewAction };
}

/** Apply a recorded preview action to the finalized response (signs the cookie). */
async function applyPreview(
  response: Response,
  action: PreviewAction,
  secure: boolean,
): Promise<void> {
  if (action.kind === "clear") {
    response.headers.append("set-cookie", clearPreviewCookie(secure));
    return;
  }
  const token = await signPreview(action.data, previewSecrets()[0]);
  response.headers.append(
    "set-cookie",
    setPreviewCookie(token, { secure, maxAge: action.maxAge }),
  );
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
  let req: ApiRequest;
  try {
    req = await buildReq(request, params, url, mod.config);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return new Response("Body exceeded size limit", { status: 413 });
    }
    throw err;
  }
  const { res, done, finish, preview } = buildRes();
  const secure = url.protocol === "https:";
  // Finalize: apply any recorded preview cookie (async signing) to the response.
  const finalize = async (): Promise<Response> => {
    const response = await done;
    const action = preview();
    if (action) await applyPreview(response, action, secure);
    return response;
  };
  try {
    await handler(req, res);
  } catch (error) {
    // If the handler already set an error status (e.g. `res.status(400)` then threw),
    // honor it and finalize its response. Otherwise it's an unexpected failure → 500.
    // Never re-throw: that would escape to core and discard the handler's status.
    if (!(res as { statusCode: number }).statusCode || res.statusCode < 400) {
      console.error("@denext/pages-router: API route threw:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
    finish();
    return await finalize();
  }
  finish(); // finalize if the handler returned without ending the response
  return await finalize();
}
