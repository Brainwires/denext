/**
 * In-process app testing for denext — drive a request handler the way a browser
 * with **JavaScript disabled** would: follow redirects, keep a cookie jar across
 * requests, and submit the very `<form>` markup your Server Components rendered.
 *
 * This is the framework-agnostic core of denext's app-testing story. Get a handler
 * for a project with {@linkcode createTestApp} (in-process, no build, no socket),
 * or wrap any `(Request) => Response | Promise<Response>` handler you already have.
 *
 * ```ts
 * import { createTestApp, createTestClient } from "@denext/denext/testing";
 *
 * const client = createTestClient(await createTestApp("./"));
 *
 * // Log in through the rendered form — no client JS involved.
 * const page = await client.get("/login");
 * const form = client.form(page.text);
 * const res = await client.submit(form, { email: "a@b.c", password: "pw" });
 * // The session cookie is now in the jar; later requests are authenticated.
 * const home = await client.get("/");
 * ```
 *
 * @module
 */

import {
  createApp,
  createMiddlewareRunner,
  defaultLoader,
  PageCache,
  scanRoutes,
} from "../server/mod.ts";
import { resolveProject } from "../build/paths.ts";
import {
  buildBoundaryManifest,
  computeBoundaryRoutes,
  importFunctionExports,
  routeEntryFiles,
} from "../build/module-graph.ts";
import { tagServerModules } from "../runtime/server-action.ts";
import { resolve, toFileUrl } from "@std/path";

/**
 * Build an in-process request handler for a real project directory — **no build
 * step, no socket**. It renders Server Components, runs Server Actions and
 * `middleware.ts`, and reads cookies/sessions, exactly as production does, but it
 * ships no client bundle — so it drives the **JavaScript-disabled** path your app
 * must support. The handler keeps one `PageCache`, so `revalidate`-based ISR is
 * exercised across successive requests. Pair it with {@linkcode createTestClient}.
 *
 * ```ts
 * import { createTestApp, createTestClient } from "@denext/denext/testing";
 * const client = createTestClient(await createTestApp("./"));
 * ```
 *
 * @param projectDir The app directory (contains `app/`, optional `middleware.ts`).
 * @returns A `(Request) => Promise<Response>` handler.
 */
export async function createTestApp(projectDir: string): Promise<TestHandler> {
  const paths = await resolveProject(resolve(projectDir));
  const manifest = await scanRoutes(paths.appDir);
  let getMiddleware: (() => ReturnType<typeof createMiddlewareRunner>) | undefined;
  if (paths.middlewarePath) {
    const mod = await import(toFileUrl(resolve(paths.middlewarePath)).href);
    const runner = createMiddlewareRunner(mod);
    getMiddleware = () => runner;
  }

  // Discover the "use client"/"use server" boundary by crawling the import graph
  // (the same pass the production server runs) — with no build. This is what lets
  // `<form action={serverActionFn}>` render a working endpoint URL and lets Server
  // Actions dispatch. Every discovered "use server" module is registered up front
  // so actions work on ALL routes, not only ones that also reach a client island.
  // No client bundle is emitted, which is exactly the JavaScript-disabled surface
  // this handler is meant to exercise.
  const boundary = await buildBoundaryManifest(
    paths.appDir,
    [...new Set(manifest.pages.flatMap(routeEntryFiles))],
    { exportsOf: importFunctionExports },
  );
  await tagServerModules(boundary.server);
  const flightRoutes = await computeBoundaryRoutes(paths.appDir, manifest.pages);

  return createApp({
    getManifest: () => manifest,
    load: defaultLoader,
    publicDir: paths.publicDir,
    getMiddleware,
    pageCache: new PageCache(),
    i18n: paths.i18n ?? undefined,
    flight: flightRoutes.size > 0,
    appDir: paths.appDir,
    flightRoutes,
    flightClients: boundary.client,
    flightServers: boundary.server,
  });
}

/** A request body helper: a plain object is sent as `x-www-form-urlencoded`. */
export type FormBody = Record<string, string | number | boolean>;

/** Options for a single {@linkcode TestClient} request. */
export interface TestRequestInit extends Omit<RequestInit, "body"> {
  /**
   * A form body — encoded as `application/x-www-form-urlencoded` (the no-JS form
   * submission wire format). Mutually exclusive with `json` and `body`.
   */
  form?: FormBody;
  /** A JSON body — sets `content-type: application/json`. */
  json?: unknown;
  /** A raw body (string, `FormData`, `URLSearchParams`, bytes, …). */
  body?: BodyInit;
}

/** One hop in a followed redirect chain. */
export interface RedirectHop {
  /** The 3xx status of the hop. */
  status: number;
  /** The absolute `Location` the hop pointed at. */
  location: string;
}

/**
 * A response whose body has already been read into {@linkcode TestResponse.text}
 * — so assertions are synchronous and the body is never left dangling.
 */
export interface TestResponse {
  /** The final status (after any followed redirects). */
  status: number;
  /** The final response headers. */
  headers: Headers;
  /** The response body, already read as text. */
  text: string;
  /** The `Location` header of this response, if any. */
  location: string | null;
  /** The redirect chain followed to reach this response (empty if none). */
  redirects: RedirectHop[];
  /** Parse {@linkcode TestResponse.text} as JSON. */
  json(): unknown;
}

/** A `<form>` parsed out of rendered HTML, ready to {@linkcode TestClient.submit}. */
export interface TestForm {
  /** The resolved (absolute-path) form action URL. */
  action: string;
  /** The upper-cased HTTP method (`GET` or `POST`). */
  method: string;
  /** The form's `enctype`. */
  enctype: string;
  /** The default field values parsed from the form's controls. */
  fields: Record<string, string>;
}

/** Locate a specific form when a page renders more than one. */
export interface FormQuery {
  /** Pick the form whose `action` matches this pattern. */
  action?: RegExp;
  /** Pick the form that contains a control with this `name` (e.g. `"password"`). */
  has?: string;
  /** Pick the Nth of the still-matching forms (0-based). Default `0`. */
  index?: number;
}

/**
 * A cookie jar: stores cookies set by responses and replays them on later
 * requests, honoring deletions (`Max-Age=0` / a past `Expires`).
 */
export class CookieJar {
  #jar = new Map<string, string>();

  /** Absorb every `Set-Cookie` from a response's headers. */
  absorb(headers: Headers): void {
    // `getSetCookie` returns each Set-Cookie separately (Deno/std support it).
    const list = typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : headers.get("set-cookie")
      ? [headers.get("set-cookie")!]
      : [];
    for (const line of list) this.#apply(line);
  }

  #apply(setCookie: string): void {
    const [pair, ...attrs] = setCookie.split(";");
    const eq = pair.indexOf("=");
    if (eq < 0) return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) return;
    // A cookie is a deletion if Max-Age<=0 or Expires is in the past (the common
    // "expire it now" shape servers use to clear a cookie).
    let deleted = false;
    for (const attr of attrs) {
      const [k, v] = attr.split("=");
      const key = k.trim().toLowerCase();
      if (key === "max-age" && Number(v) <= 0) deleted = true;
      if (key === "expires" && v && /1970|Thu, 01 Jan 1970/i.test(v)) deleted = true;
    }
    if (deleted) this.#jar.delete(name);
    else this.#jar.set(name, value);
  }

  /** The `Cookie` header value for the current jar, or `null` if empty. */
  header(): string | null {
    if (this.#jar.size === 0) return null;
    return [...this.#jar].map(([n, v]) => `${n}=${v}`).join("; ");
  }

  /** Read one cookie's current value. */
  get(name: string): string | undefined {
    return this.#jar.get(name);
  }

  /** Set a cookie directly (e.g. to seed a test). */
  set(name: string, value: string): void {
    this.#jar.set(name, value);
  }

  /** Remove all cookies. */
  clear(): void {
    this.#jar.clear();
  }
}

/** Options for {@linkcode createTestClient}. */
export interface TestClientOptions {
  /**
   * The origin used to resolve request paths and as the same-origin `Origin`
   * header on unsafe methods (so Server Action CSRF checks pass). Default
   * `"http://localhost"`.
   */
  origin?: string;
  /**
   * Follow 3xx redirects automatically. Default `false` — a redirect is returned
   * as-is so you can assert its status and `Location`.
   */
  followRedirects?: boolean;
  /** Max redirects to follow when `followRedirects` is on. Default `10`. */
  maxRedirects?: number;
}

/** A handler under test: anything that maps a `Request` to a `Response`. */
export type TestHandler = (request: Request) => Response | Promise<Response>;

/** A cookie-aware, no-JS test driver over a request handler. */
export interface TestClient {
  /** The shared cookie jar (inspect or seed it directly). */
  readonly cookies: CookieJar;
  /** Issue a request. `path` may be absolute or relative to the client origin. */
  request(path: string, init?: TestRequestInit): Promise<TestResponse>;
  /** `GET path`. */
  get(path: string, init?: TestRequestInit): Promise<TestResponse>;
  /** `POST path` (pass `{ form }` or `{ json }` for a body). */
  post(path: string, init?: TestRequestInit): Promise<TestResponse>;
  /**
   * Parse a `<form>` out of rendered HTML. Throws if no matching form is found —
   * a rendered form is exactly what progressive enhancement guarantees exists.
   */
  form(html: string, query?: FormQuery): TestForm;
  /**
   * Submit a parsed {@linkcode TestForm}, overriding/adding field `values`. This
   * is the no-JS path: it posts the form's own action URL with its own fields.
   */
  submit(form: TestForm, values?: Record<string, string>): Promise<TestResponse>;
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Build a {@linkcode TestResponse} from a `Response`, reading its body once. */
async function toTestResponse(res: Response, redirects: RedirectHop[]): Promise<TestResponse> {
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    text,
    location: res.headers.get("location"),
    redirects,
    json: () => JSON.parse(text),
  };
}

/** Decode HTML entities that appear in attribute values our renderer emits. */
function unescapeAttr(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** Pull the value of `attr` from an opening tag's attribute string. */
function attrOf(tag: string, attr: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`, "i")) ??
    tag.match(new RegExp(`\\b${attr}\\s*=\\s*'([^']*)'`, "i"));
  return m ? unescapeAttr(m[1]) : undefined;
}

/** Extract every `<form>…</form>` block (opening tag + inner HTML) from a page. */
function extractForms(html: string): { open: string; inner: string }[] {
  const forms: { open: string; inner: string }[] = [];
  const re = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) forms.push({ open: `<form ${m[1]}>`, inner: m[2] });
  return forms;
}

/** Collect the default `name → value` fields from a form's inner HTML. */
function collectFields(inner: string): Record<string, string> {
  const fields: Record<string, string> = {};
  // <input> / <button> — self-closing or not; value defaults to "".
  const controlRe = /<(input|button)\b([^>]*)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = controlRe.exec(inner)) !== null) {
    const tag = m[0];
    const name = attrOf(tag, "name");
    if (!name) continue;
    const type = (attrOf(tag, "type") ?? "text").toLowerCase();
    // Unchecked checkboxes/radios contribute nothing (browser behavior).
    if ((type === "checkbox" || type === "radio") && !/\bchecked\b/i.test(tag)) continue;
    fields[name] = attrOf(tag, "value") ?? (type === "checkbox" ? "on" : "");
  }
  // <textarea name>…</textarea>
  const taRe = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
  while ((m = taRe.exec(inner)) !== null) {
    const name = attrOf(`<textarea ${m[1]}>`, "name");
    if (name) fields[name] = unescapeAttr(m[2]);
  }
  // <select name><option value selected>…  — take the selected option, else first.
  const selRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  while ((m = selRe.exec(inner)) !== null) {
    const name = attrOf(`<select ${m[1]}>`, "name");
    if (!name) continue;
    const opts = [...m[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)];
    const chosen = opts.find((o) => /\bselected\b/i.test(o[1])) ?? opts[0];
    if (chosen) {
      fields[name] = attrOf(`<option ${chosen[1]}>`, "value") ?? chosen[2].trim();
    }
  }
  return fields;
}

/**
 * Create a cookie-aware, no-JS test client over a request `handler`.
 *
 * @param handler The handler under test (e.g. from `createProdHandler`).
 * @param options Origin and redirect-following behavior.
 * @returns A {@linkcode TestClient}.
 */
export function createTestClient(
  handler: TestHandler,
  options: TestClientOptions = {},
): TestClient {
  const origin = (options.origin ?? "http://localhost").replace(/\/$/, "");
  const originHost = new URL(origin).host;
  const followRedirects = options.followRedirects ?? false;
  const maxRedirects = options.maxRedirects ?? 10;
  const cookies = new CookieJar();

  const resolve = (path: string): string =>
    path.startsWith("http://") || path.startsWith("https://") ? path : `${origin}${path}`;

  async function once(url: string, init: TestRequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    let body: BodyInit | undefined = init.body;
    const method = (init.method ?? "GET").toUpperCase();

    if (init.form !== undefined) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(init.form)) params.set(k, String(v));
      body = params;
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/x-www-form-urlencoded");
      }
    } else if (init.json !== undefined) {
      body = JSON.stringify(init.json);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }

    // In-process there's no HTTP layer to add a Host header; set it (and a
    // same-origin Origin on unsafe methods) so Server Action CSRF checks pass.
    if (!headers.has("host")) headers.set("host", originHost);
    if (UNSAFE.has(method) && !headers.has("origin")) headers.set("origin", origin);
    const cookieHeader = cookies.header();
    if (cookieHeader && !headers.has("cookie")) headers.set("cookie", cookieHeader);

    const res = await handler(new Request(url, { ...init, method, headers, body }));
    cookies.absorb(res.headers);
    return res;
  }

  async function request(path: string, init: TestRequestInit = {}): Promise<TestResponse> {
    let url = resolve(path);
    let res = await once(url, init);
    const hops: RedirectHop[] = [];
    if (followRedirects) {
      let n = 0;
      while (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        if (n++ >= maxRedirects) throw new Error(`Exceeded ${maxRedirects} redirects at ${url}`);
        const location = new URL(res.headers.get("location")!, url).href;
        hops.push({ status: res.status, location });
        await res.body?.cancel();
        url = location;
        // Per fetch semantics, a redirect is followed with GET (303 always; 301/302
        // in practice) and no body.
        res = await once(url, { headers: init.headers });
      }
    }
    return toTestResponse(res, hops);
  }

  return {
    cookies,
    request,
    get: (path, init) => request(path, { ...init, method: "GET" }),
    post: (path, init) => request(path, { ...init, method: "POST" }),
    form(html, query = {}) {
      const forms = extractForms(html);
      let matched = forms;
      if (query.action) {
        matched = matched.filter((f) => query.action!.test(attrOf(f.open, "action") ?? ""));
      }
      if (query.has) {
        const nameRe = new RegExp(`\\bname\\s*=\\s*["']${query.has}["']`, "i");
        matched = matched.filter((f) => nameRe.test(f.inner));
      }
      const picked = matched[query.index ?? 0];
      if (!picked) {
        const desc = [
          query.action && `matching ${query.action}`,
          query.has && `with a "${query.has}" field`,
        ].filter(Boolean).join(" ");
        throw new Error(
          `No form found${desc ? " " + desc : ""} (page has ${forms.length} form(s)).`,
        );
      }
      const action = attrOf(picked.open, "action") ?? "";
      return {
        action: action ? resolve(action) : origin + "/",
        method: (attrOf(picked.open, "method") ?? "GET").toUpperCase(),
        enctype: attrOf(picked.open, "enctype") ?? "application/x-www-form-urlencoded",
        fields: collectFields(picked.inner),
      };
    },
    submit(form, values = {}) {
      const fields = { ...form.fields, ...values };
      if (form.method === "GET") {
        const u = new URL(form.action);
        for (const [k, v] of Object.entries(fields)) u.searchParams.set(k, v);
        return request(u.href, { method: "GET" });
      }
      return request(form.action, { method: "POST", form: fields });
    },
  };
}
