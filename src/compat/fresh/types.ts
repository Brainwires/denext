// The Fresh types `denext/fresh` exports (Fresh 2's, plus Fresh 1.x's names). Type-only.

import type { VNode, VNodeChildren } from "../../jsx/types.ts";
import type { Context } from "./context.ts";

/** An HTTP method a handler object can name. */
export type Method = "HEAD" | "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "OPTIONS";

/** What a page handler returns to render the page: `page(data, { status, headers })`. */
export interface PageResponse<T> {
  /** The data the page component receives as `props.data`. */
  data: T;
  /** Extra response headers. */
  headers?: HeadersInit;
  /** The response status. */
  status?: number;
}

/** A route handler function. */
export interface HandlerFn<Data = unknown, State = unknown> {
  (ctx: Context<State>):
    | Response
    | PageResponse<Data>
    | Promise<Response | PageResponse<Data>>;
}

/** A route handler per HTTP method. */
export type HandlerByMethod<Data = unknown, State = unknown> = {
  [M in Method]?: HandlerFn<Data, State>;
};

/** A route's `handler` export: one function, or one per method. */
export type RouteHandler<Data = unknown, State = unknown> =
  | HandlerFn<Data, State>
  | HandlerByMethod<Data, State>;

/** The page data a handler returns. */
export type RouteData<Handler> = Handler extends RouteHandler<infer Data, unknown> ? Data
  : never;

/** A middleware: runs before the route, calls `ctx.next()` to continue. */
export type MiddlewareFn<State = unknown> = (
  ctx: Context<State>,
) => Response | Promise<Response>;

/** A middleware or an ordered list of them. */
export type Middleware<State = unknown> = MiddlewareFn<State>;

/** The props a page, layout or app component receives (the request context plus `data`). */
export type PageProps<Data = unknown, State = unknown> =
  & Pick<
    Context<State>,
    | "config"
    | "url"
    | "req"
    | "params"
    | "info"
    | "state"
    | "isPartial"
    | "Component"
    | "error"
    | "route"
  >
  & { data: Data };

/** A route module's `config` export. */
export interface RouteConfig {
  /** A URL pattern used instead of the file path. */
  routeOverride?: string;
  /** Render without the `_app` wrapper. */
  skipAppWrapper?: boolean;
  /** Render without the `_layout` files above the route. */
  skipInheritedLayouts?: boolean;
  /** The methods the route answers (`"ALL"` or a list). */
  methods?: "ALL" | Method[];
  /** Fresh's content-security-policy opt-in (denext applies its own `csp` config). */
  csp?: boolean;
}

/** A layout module's `config` export. */
export interface LayoutConfig {
  /** Render without the `_app` wrapper. */
  skipAppWrapper?: boolean;
  /** Render without the `_layout` files above this one. */
  skipInheritedLayouts?: boolean;
}

/** Fresh's app configuration. */
export interface FreshConfig {
  /** The project root. */
  root?: string;
  /** A path prefix the app is served under. */
  basePath?: string;
  /** `development` or `production`. */
  mode?: "development" | "production";
}

/** The resolved app configuration `ctx.config` holds. */
export interface ResolvedFreshConfig {
  /** The project root. */
  root: string;
  /** A path prefix the app is served under. */
  basePath: string;
  /** `development` or `production`. */
  mode: "development" | "production";
}

/** A lazily loaded value. */
export type Lazy<T> = () => Promise<T>;
/** A value or a lazily loaded one. */
export type MaybeLazy<T> = T | Lazy<T>;

/** A registered island. */
export interface Island {
  /** Its file. */
  file: string;
  /** Its name. */
  name: string;
  /** The export it renders. */
  exportName: string;
  /** The component. */
  fn: (props: never) => unknown;
  /** Its stylesheets. */
  css: string[];
}

/** `app.listen()` options. */
export interface ListenOptions {
  /** The port. */
  port?: number;
  /** The hostname. */
  hostname?: string;
}

/** WebSocket handlers for `ctx.upgrade()`. */
export interface WebSocketHandlers {
  /** The socket opened. */
  open?(socket: WebSocket): void;
  /** A message arrived. */
  message?(socket: WebSocket, event: MessageEvent): void;
  /** The socket closed. */
  close?(socket: WebSocket, code: number, reason: string): void;
  /** The socket failed. */
  error?(socket: WebSocket, event: Event | ErrorEvent): void;
}

/** `ctx.upgrade()` options. */
export interface WebSocketUpgradeOptions {
  /** Seconds without a pong before the socket closes. */
  idleTimeout?: number;
  /** The subprotocol. */
  protocol?: string;
}

// ── Fresh 1.x names ────────────────────────────────────────────────────────

/** Fresh 1.x: a handler `(req, ctx)`. */
export type Handler<T = unknown, State = Record<string, unknown>> = (
  req: Request,
  ctx: Context<State, T>,
) => Response | Promise<Response>;

/** Fresh 1.x: handlers per method. */
export type Handlers<T = unknown, State = Record<string, unknown>> = {
  [K in Method]?: Handler<T, State>;
};

/** Fresh 1.x: the handler context. */
export type HandlerContext<T = unknown, State = Record<string, unknown>> = Context<State, T>;
/** Fresh 1.x: the middleware context. */
export type MiddlewareHandlerContext<State = Record<string, unknown>> = Context<State>;
/** Fresh 1.x: an async route's context. */
export type RouteContext<T = unknown, State = Record<string, unknown>> = Context<State, T>;
/** Fresh 1.x: the app wrapper's context. */
export type AppContext<T = unknown, State = Record<string, unknown>> = Context<State, T>;
/** Fresh 1.x: a layout's context. */
export type LayoutContext<T = unknown, State = Record<string, unknown>> = Context<State, T>;
/** Fresh 1.x: an error page's context. */
export type ErrorHandlerContext<State = Record<string, unknown>> = Context<State>;
/** Fresh 1.x: a not-found handler's context. */
export type UnknownHandlerContext<State = Record<string, unknown>> = Context<State>;

/** Fresh 1.x: a middleware `(req, ctx)`. */
export type MiddlewareHandler<State = Record<string, unknown>> = (
  req: Request,
  ctx: Context<State>,
) => Response | Promise<Response>;

/** Fresh 1.x: a page's props. */
export interface LegacyPageProps<T = unknown, State = Record<string, unknown>> {
  /** The request URL. */
  url: URL;
  /** The route pattern. */
  route: string;
  /** The URL parameters. */
  params: Record<string, string>;
  /** What the handler passed to `ctx.render()`. */
  data: T;
  /** The middleware state. */
  state: State;
}

/** Fresh 1.x: the `_app` component's props. */
export type AppProps<T = unknown, State = Record<string, unknown>> =
  & LegacyPageProps<T, State>
  & { Component: () => VNode | null };
/** Fresh 1.x: a `_layout` component's props. */
export type LayoutProps<T = unknown, State = Record<string, unknown>> = AppProps<T, State>;
/** Fresh 1.x: the `_500` page's props. */
export type ErrorPageProps = LegacyPageProps<unknown> & { error: unknown };
/** Fresh 1.x: the `_404` page's props. */
export type UnknownPageProps<T = unknown> = LegacyPageProps<T>;

/** Fresh 1.x: a plugin (not run on denext; port what it does into denext.config.ts). */
export interface Plugin {
  /** Its name. */
  name: string;
  /** Anything else. */
  [key: string]: unknown;
}

/** Children a Fresh component may return. */
export type ComponentChildren = VNodeChildren;
