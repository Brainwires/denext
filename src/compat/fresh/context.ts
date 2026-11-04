// The request context a migrated Fresh route sees (`ctx` in handlers, middleware and components),
// and the per-request record the generated `middleware.ts`, pages, layouts and route handlers
// share. Server-only.

import { currentContext } from "../../server/request-context.ts";
import { clientIp } from "../../server/request-context.ts";
import type { VNode } from "../../jsx/types.ts";
import { HttpError } from "./http-error.ts";
import { CONTINUE_HEADER, PARTIAL_SEARCH_PARAM } from "./constants.ts";
import type {
  PageResponse,
  ResolvedFreshConfig,
  RouteConfig,
  WebSocketHandlers,
  WebSocketUpgradeOptions,
} from "./types.ts";

export { CONTINUE_HEADER } from "./constants.ts";

/** What a page route's handler decided, for the page component to render. */
export type FreshOutcome =
  | { kind: "page"; data: unknown }
  | { kind: "vnode"; vnode: VNode | null }
  | { kind: "error"; error: unknown; status: number };

/** A route the middleware matched. */
export interface MatchedRoute {
  /** The route's id (its file under `routes/`). */
  id: string;
  /** The route pattern. */
  pattern: string;
  /** The route module. */
  mod: FreshModule;
  /** The route has a page component. */
  page: boolean;
  /** The ids of the `_layout` files that wrap it. */
  layouts: string[];
  /** Render without the `_app` wrapper. */
  skipApp: boolean;
  /** Render without the layouts above the route (`skipInheritedLayouts`), code layouts too. */
  skipLayouts?: boolean;
  /** A route registered in code (`app.route()`, a handler's `ctx.render()`, `app.onError()`). */
  code?: boolean;
}

/** One request's Fresh state, shared by the middleware and the page / layouts / route handler. */
export interface FreshRequest {
  /** The context handlers and components see. */
  ctx: Context;
  /** The token on the stand-in response `ctx.next()` resolves with. */
  token: string;
  /** The route the middleware matched (none: a 404, a static file, or no middleware ran). */
  match?: MatchedRoute;
  /** The page route's handler result. */
  outcome?: FreshOutcome;
  /** The generated `middleware.ts` ran for this request. */
  dispatched: boolean;
}

/** A Fresh route / layout / middleware module, as the generated files import it. */
export interface FreshModule {
  /** The component (page, layout, app, error page). */
  default?: unknown;
  /** The handler(s) or middleware(s). */
  handler?: unknown;
  /** Fresh 2's plural spelling of `handler`. */
  handlers?: unknown;
  /** The route / layout config. */
  config?: RouteConfig;
}

/** The Fresh state of each request, keyed by its denext request context. */
const requests = new WeakMap<object, FreshRequest>();

/**
 * The Fresh state of the current request: the one the middleware created, else a new one built
 * from the request (a request no middleware ran for, such as an export render).
 *
 * @param v1 The app is a Fresh 1.x app (handlers take `(req, ctx)`).
 * @returns The request's Fresh state.
 */
export function freshRequest(v1 = false): FreshRequest {
  const rc = currentContext();
  const existing = rc ? requests.get(rc) : undefined;
  if (existing) return existing;
  const request = rc?.request ?? new Request("http://localhost/");
  const fr = createFreshRequest(request, v1);
  if (rc) requests.set(rc, fr);
  return fr;
}

/**
 * Start the Fresh state of a request (the middleware calls this first).
 *
 * @param request The request.
 * @param v1 The app is a Fresh 1.x app.
 * @returns The state, registered on the current request context.
 */
export function createFreshRequest(request: Request, v1: boolean): FreshRequest {
  const fr: FreshRequest = {
    ctx: undefined as unknown as Context,
    token: crypto.randomUUID(),
    dispatched: false,
  };
  fr.ctx = new Context(request, fr, v1);
  const rc = currentContext();
  if (rc) requests.set(rc, fr);
  return fr;
}

/**
 * The response `ctx.next()` resolves with when denext renders the page: a stand-in carrying
 * the status and headers the page will have, which middleware may read and add headers to.
 *
 * @param fr The request's Fresh state.
 * @param status The page's status.
 * @param headers The page's headers.
 * @returns The stand-in.
 */
export function continueResponse(fr: FreshRequest, status = 200, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  if (!h.has("content-type")) h.set("content-type", "text/html; charset=utf-8");
  h.set(CONTINUE_HEADER, fr.token);
  return new Response(null, { status: status >= 200 && status <= 599 ? status : 200, headers: h });
}

/**
 * Whether `res` is (a copy of) this request's stand-in.
 *
 * @param fr The request's Fresh state.
 * @param res A response a middleware chain returned.
 * @returns True when denext should render the page.
 */
export function isContinue(fr: FreshRequest, res: Response): boolean {
  return res.headers.get(CONTINUE_HEADER) === fr.token;
}

/** Whether `value` is the result of `page(data)`. */
export function isPageResponse(value: unknown): value is PageResponse<unknown> {
  return typeof value === "object" && value !== null && !(value instanceof Response) &&
    "data" in value;
}

/** Whether `value` is a JSX element. */
function isElement(value: unknown): value is VNode {
  return typeof value === "object" && value !== null && "type" in value && "props" in value;
}

/**
 * The request context Fresh handlers, middleware and components receive (`ctx`). It carries
 * Fresh 2's members and Fresh 1.x's (`renderNotFound`, `remoteAddr`, `destination`).
 */
export class Context<State = Record<string, unknown>, Data = unknown> {
  /** The resolved app configuration. */
  readonly config: ResolvedFreshConfig;
  /** The request URL. */
  readonly url: URL;
  /** The request. */
  req: Request;
  /** The matched route pattern. */
  route: string | null = null;
  /** The URL parameters of the matched route. */
  params: Record<string, string> = {};
  /** State shared by middleware, handlers and components. */
  readonly state: State = {} as State;
  /** The page data (what the handler passed to `page()`). */
  data: Data = undefined as Data;
  /** The error an error page renders. */
  error: unknown = null;
  /** The connection info. */
  readonly info: Deno.ServeHandlerInfo;
  /**
   * Whether this is a partial request: Fresh's client navigation fetches a page with the
   * `fresh-partial` query parameter to take only its `<Partial>` regions.
   */
  readonly isPartial: boolean;
  /** Fresh 1.x: what the request resolved to. */
  destination: "route" | "notFound" | "static" | "internal" = "notFound";
  /** Fresh 1.x: the base path. */
  readonly basePath = "";
  /** Call the next middleware (or the route); resolves with its response. */
  next: () => Promise<Response> = () => Promise.resolve(new Response(null, { status: 404 }));
  /** In a layout or the app wrapper: the component rendering the content inside it. */
  Component: () => unknown = () => null;
  #fr: FreshRequest;
  #v1: boolean;

  /**
   * Build the context for a request.
   *
   * @param req The request.
   * @param fr The request's Fresh state.
   * @param v1 The app is a Fresh 1.x app.
   */
  constructor(req: Request, fr: FreshRequest, v1: boolean) {
    this.req = req;
    this.url = new URL(req.url);
    this.isPartial = this.url.searchParams.has(PARTIAL_SEARCH_PARAM);
    this.#fr = fr;
    this.#v1 = v1;
    this.config = {
      root: Deno.cwd(),
      basePath: "",
      mode: Deno.env.get("NODE_ENV") === "production" ? "production" : "development",
    };
    // Outside a request (an export render, a direct call) there is no client address.
    const hostname = (currentContext() ? clientIp() : undefined) ?? "127.0.0.1";
    this.info = {
      remoteAddr: { transport: "tcp", hostname, port: 0 },
      completed: Promise.resolve(),
    } as unknown as Deno.ServeHandlerInfo;
  }

  /** Fresh 1.x: the client address. */
  get remoteAddr(): Deno.NetAddr {
    return this.info.remoteAddr as Deno.NetAddr;
  }

  /** Fresh 1.x: the server address. */
  get localAddr(): Deno.NetAddr {
    return { transport: "tcp", hostname: this.url.hostname, port: Number(this.url.port) || 0 };
  }

  /**
   * A redirect response. A same-site path has repeated slashes collapsed, so `//evil.com` stays
   * on this site. A partial request's redirect keeps the `fresh-partial` parameter, so the page
   * it lands on answers with its partials too.
   *
   * @param pathOrUrl Where to go.
   * @param status The status (302).
   * @returns The response.
   */
  redirect(pathOrUrl: string, status = 302): Response {
    let location = pathOrUrl;
    if (pathOrUrl !== "/" && pathOrUrl.startsWith("/")) {
      let idx = pathOrUrl.indexOf("?");
      if (idx === -1) idx = pathOrUrl.indexOf("#");
      const pathname = idx > -1 ? pathOrUrl.slice(0, idx) : pathOrUrl;
      const search = idx > -1 ? pathOrUrl.slice(idx) : "";
      location = `${pathname.replaceAll(/\/+/g, "/")}${search}`;
    }
    if (this.isPartial) location = withPartialParam(location);
    return new Response(null, { status, headers: { location } });
  }

  /**
   * Render the page. Fresh 2: `ctx.render(<jsx />, init?)` renders that JSX inside the layouts.
   * Fresh 1.x: `ctx.render(data, init?)` renders the route's component with `data`.
   *
   * @param value The JSX (Fresh 2) or the page data (Fresh 1.x).
   * @param init The status and headers.
   * @returns The response the page renders as.
   */
  render(value?: unknown, init?: ResponseInit): Promise<Response> {
    if (!this.#v1 && (value === null || isElement(value))) {
      this.#fr.outcome = { kind: "vnode", vnode: value as VNode | null };
    } else {
      this.#fr.outcome = { kind: "page", data: value };
    }
    return Promise.resolve(continueResponse(this.#fr, init?.status, init?.headers));
  }

  /**
   * Fresh 1.x: render the not-found page.
   *
   * @returns The response the not-found page renders as.
   */
  renderNotFound(): Promise<Response> {
    this.#fr.outcome = { kind: "error", error: new HttpError(404), status: 404 };
    return Promise.resolve(continueResponse(this.#fr, 404));
  }

  /**
   * A text response.
   *
   * @param content The text.
   * @param init The status and headers.
   * @returns The response.
   */
  text(content: string, init?: ResponseInit): Response {
    return withType(content, "text/plain; charset=utf-8", init);
  }

  /**
   * An HTML response.
   *
   * @param content The HTML.
   * @param init The status and headers.
   * @returns The response.
   */
  html(content: string, init?: ResponseInit): Response {
    return withType(content, "text/html; charset=utf-8", init);
  }

  /**
   * A JSON response.
   *
   * @param content The value.
   * @param init The status and headers.
   * @returns The response.
   */
  json(content: unknown, init?: ResponseInit): Response {
    return withType(JSON.stringify(content), "application/json", init);
  }

  /**
   * Upgrade the request to a WebSocket.
   *
   * @param handlers The socket's handlers (or omit and use the returned socket).
   * @param options The upgrade options.
   * @returns The upgrade response.
   */
  upgrade(handlers?: WebSocketHandlers, options?: WebSocketUpgradeOptions): Response {
    const { socket, response } = Deno.upgradeWebSocket(this.req, options);
    if (handlers) {
      if (handlers.open) socket.addEventListener("open", () => handlers.open!(socket));
      if (handlers.message) socket.addEventListener("message", (e) => handlers.message!(socket, e));
      if (handlers.close) {
        socket.addEventListener("close", (e) => handlers.close!(socket, e.code, e.reason));
      }
      if (handlers.error) socket.addEventListener("error", (e) => handlers.error!(socket, e));
    }
    return response;
  }
}

/** `location` with the `fresh-partial` parameter added before its fragment. */
function withPartialParam(location: string): string {
  const hashAt = location.indexOf("#");
  const base = hashAt > -1 ? location.slice(0, hashAt) : location;
  const hash = hashAt > -1 ? location.slice(hashAt) : "";
  return `${base}${base.includes("?") ? "&" : "?"}${PARTIAL_SEARCH_PARAM}=true${hash}`;
}

/** A response with a content type (unless `init` sets one). */
function withType(body: string, type: string, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) headers.set("content-type", type);
  return new Response(body, { ...init, headers });
}
